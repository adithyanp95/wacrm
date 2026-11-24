// ============================================================
// Bridge for the external AI agent service (agent/).
//
// The agent is a separate app: it receives `message.received` webhooks,
// decides what to say, and acts on the CRM only through these
// functions (exposed as /api/v1/agent/*, scope `ai:agent`). Every rule
// the built-in bot obeys is enforced HERE, not in the agent, so a buggy
// or compromised agent still can't:
//   - reply while AI is off, paused, or a human owns the thread
//   - exceed the per-conversation reply limit (atomic slot claim)
//   - answer a stale message after the customer wrote again
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '@/lib/api/v1/respond'
import { loadAiConfig } from './config'
import { retrieveKnowledge } from './knowledge'
import { handOff, isExternalAgentMode } from './auto-reply'
import { buildHandoffSummary } from './handoff'
import { engineSendText, loadAccountMetaCredentials } from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import type { AiConfig } from './types'

/** Messages of these types carry text worth showing the model
 *  (voice notes carry their transcript). */
const TEXT_TYPES = new Set(['text', 'audio', 'interactive', 'button'])
const CONTEXT_MESSAGE_LIMIT = 30
export const MAX_REPLY_PARTS = 3
export const MAX_PART_LENGTH = 1000
const MAX_SUMMARY_LENGTH = 500

export type BlockedReason =
  | 'external_mode_off'
  | 'ai_off'
  | 'auto_reply_off'
  | 'assigned'
  | 'paused'
  | 'reply_limit'

interface ConversationRow {
  id: string
  contact_id: string
  status: string
  assigned_agent_id: string | null
  ai_autoreply_disabled: boolean | null
  ai_reply_count: number | null
}

interface MessageRow {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  message_id: string | null
  created_at: string
}

export interface AgentContext {
  conversation: {
    id: string
    status: string
    assigned_agent_id: string | null
    ai_paused: boolean
    ai_reply_count: number
    ai_reply_limit: number | null
    /** Null when the agent may reply; otherwise why it may not. */
    blocked_reason: BlockedReason | null
  }
  contact: { id: string; name: string | null; company: string | null } | null
  /** Settings → AI system prompt: the business's persona/instructions. */
  business_prompt: string | null
  /** Settings → AI model, so one place controls which model runs. */
  model: string | null
  latest_customer_message_id: string | null
  /** Oldest first. */
  messages: {
    role: 'user' | 'assistant'
    sent_by: 'customer' | 'agent' | 'bot'
    content_type: string
    content: string
    at: string
  }[]
}

async function loadConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<ConversationRow> {
  const { data, error } = await db
    .from('conversations')
    .select('id, contact_id, status, assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[agent-bridge] conversation read failed:', error)
    throw new ApiError('internal', 'Failed to read conversation', 500)
  }
  if (!data) throw new ApiError('not_found', 'Conversation not found', 404)
  return data as ConversationRow
}

async function loadRecentMessages(
  db: SupabaseClient,
  conversationId: string,
): Promise<MessageRow[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, message_id, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(CONTEXT_MESSAGE_LIMIT)
  if (error) {
    console.error('[agent-bridge] messages read failed:', error)
    throw new ApiError('internal', 'Failed to read messages', 500)
  }
  return ((data ?? []) as MessageRow[]).reverse()
}

function latestCustomerMessageId(rows: MessageRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].sender_type === 'customer') return rows[i].message_id
  }
  return null
}

/** The first rule that stops the agent from replying, or null. */
export function blockedReason(
  config: Pick<AiConfig, 'autoReplyEnabled' | 'autoReplyMaxPerConversation'> | null,
  conv: Pick<ConversationRow, 'assigned_agent_id' | 'ai_autoreply_disabled' | 'ai_reply_count'>,
): BlockedReason | null {
  if (!isExternalAgentMode()) return 'external_mode_off'
  if (!config) return 'ai_off'
  if (!config.autoReplyEnabled) return 'auto_reply_off'
  if (conv.assigned_agent_id) return 'assigned'
  if (conv.ai_autoreply_disabled) return 'paused'
  if ((conv.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) return 'reply_limit'
  return null
}

const BLOCKED_MESSAGES: Record<BlockedReason, string> = {
  external_mode_off: 'The CRM is not in external agent mode (set AI_AGENT_MODE=external)',
  ai_off: 'AI is switched off in Settings → AI',
  auto_reply_off: 'Auto-reply is switched off in Settings → AI',
  assigned: 'A team member is assigned to this conversation',
  paused: 'AI is paused on this conversation',
  reply_limit: 'The AI reply limit for this conversation is reached',
}

function blocked(reason: BlockedReason): ApiError {
  return new ApiError('conflict', `${reason}: ${BLOCKED_MESSAGES[reason]}`, 409)
}

/** Everything the agent needs to decide its next move. */
export async function getAgentContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<AgentContext> {
  const conv = await loadConversation(db, accountId, conversationId)
  const config = await loadAiConfig(db, accountId)
  const rows = await loadRecentMessages(db, conversationId)

  const { data: contact } = await db
    .from('contacts')
    .select('id, name, company')
    .eq('id', conv.contact_id)
    .eq('account_id', accountId)
    .maybeSingle()

  return {
    conversation: {
      id: conv.id,
      status: conv.status,
      assigned_agent_id: conv.assigned_agent_id,
      ai_paused: !!conv.ai_autoreply_disabled,
      ai_reply_count: conv.ai_reply_count ?? 0,
      ai_reply_limit: config?.autoReplyMaxPerConversation ?? null,
      blocked_reason: blockedReason(config, conv),
    },
    contact: contact
      ? { id: contact.id, name: contact.name ?? null, company: contact.company ?? null }
      : null,
    business_prompt: config?.systemPrompt ?? null,
    model: config?.model ?? null,
    latest_customer_message_id: latestCustomerMessageId(rows),
    messages: rows
      .filter((m) => TEXT_TYPES.has(m.content_type) && m.content_text?.trim())
      .map((m) => ({
        role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
        sent_by: m.sender_type,
        content_type: m.content_type,
        content: m.content_text!.trim(),
        at: m.created_at,
      })),
  }
}

/** Validate the reply body: 1–3 non-empty text parts. */
export function parseReplyParts(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? [input] : null
  if (!raw) throw new ApiError('bad_request', "'parts' must be an array of strings", 400)
  const parts = raw
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0 || parts.length !== raw.length) {
    throw new ApiError('bad_request', "'parts' must contain non-empty strings only", 400)
  }
  if (parts.length > MAX_REPLY_PARTS) {
    throw new ApiError('bad_request', `At most ${MAX_REPLY_PARTS} parts per reply`, 400)
  }
  if (parts.some((p) => p.length > MAX_PART_LENGTH)) {
    throw new ApiError('bad_request', `Each part must be at most ${MAX_PART_LENGTH} characters`, 400)
  }
  return parts
}

/** Pause before a follow-up bubble, as if typing it: ~35 ms per
 *  character, between 0.8 s and 2.5 s. */
export function typingPauseMs(text: string): number {
  return Math.min(2500, Math.max(800, text.length * 35))
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Send the agent's reply as 1–3 WhatsApp messages. The whole reply
 * costs ONE slot of the reply limit. `inReplyTo` is the customer
 * message the agent was answering; if the customer has written since,
 * the reply is refused (409 stale) so the agent re-plans with the new
 * message instead of answering an outdated one.
 */
export async function sendAgentReply(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Audit user for the sent rows: the API key's creator. Null (creator
     *  since removed) falls back to the WhatsApp config owner. */
    userId: string | null
    conversationId: string
    parts: string[]
    inReplyTo?: string | null
    sleep?: (ms: number) => Promise<void>
  },
): Promise<{ whatsapp_message_ids: string[] }> {
  const { accountId, userId, conversationId, parts, inReplyTo } = args
  const sleep = args.sleep ?? realSleep

  const conv = await loadConversation(db, accountId, conversationId)
  const config = await loadAiConfig(db, accountId)
  const reason = blockedReason(config, conv)
  if (reason) throw blocked(reason)

  if (inReplyTo) {
    const latest = latestCustomerMessageId(await loadRecentMessages(db, conversationId))
    if (latest && latest !== inReplyTo) {
      throw new ApiError('conflict', 'stale: the customer sent a newer message', 409)
    }
  }

  // Atomic cap check + increment (same RPC the built-in bot uses), so
  // concurrent replies can never overshoot the limit.
  const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
    conversation_id: conversationId,
    max_replies: config!.autoReplyMaxPerConversation,
  })
  if (claimErr) {
    console.error('[agent-bridge] claim_ai_reply_slot failed:', claimErr)
    throw new ApiError('internal', 'Failed to claim a reply slot', 500)
  }
  if (claimed !== true) throw blocked('reply_limit')

  const senderId = userId ?? (await whatsappConfigOwner(db, accountId))
  const ids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(typingPauseMs(parts[i]))
    const sent = await engineSendText({
      accountId,
      userId: senderId,
      conversationId,
      contactId: conv.contact_id,
      text: parts[i],
      aiGenerated: true,
    })
    ids.push(sent.whatsapp_message_id)
  }
  return { whatsapp_message_ids: ids }
}

async function whatsappConfigOwner(db: SupabaseClient, accountId: string): Promise<string> {
  const { data } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data?.user_id) throw new ApiError('internal', 'WhatsApp is not configured', 500)
  return data.user_id as string
}

/** Pause the AI on this thread, leave a note, assign the handoff agent. */
export async function agentHandoff(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; summary?: unknown },
): Promise<void> {
  const conv = await loadConversation(db, args.accountId, args.conversationId)
  // Hand off even when AI has been switched off meanwhile.
  const config = await loadAiConfig(db, args.accountId, { requireActive: false })

  let summary: string
  if (typeof args.summary === 'string' && args.summary.trim()) {
    summary = `🤖 ${args.summary.trim().slice(0, MAX_SUMMARY_LENGTH)}`
  } else {
    const rows = await loadRecentMessages(db, args.conversationId)
    summary = buildHandoffSummary({
      messages: rows
        .filter((m) => m.content_text?.trim())
        .map((m) => ({
          role: m.sender_type === 'customer' ? 'user' : 'assistant',
          content: m.content_text!,
        })),
      replyCount: conv.ai_reply_count ?? 0,
    })
  }
  await handOff(db, config?.handoffAgentId ?? null, args.conversationId, summary)
}

/** Show "typing…" on (and mark read) the latest customer message. */
export async function agentTyping(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string },
): Promise<{ shown: boolean }> {
  await loadConversation(db, args.accountId, args.conversationId)
  const latest = latestCustomerMessageId(await loadRecentMessages(db, args.conversationId))
  if (!latest) return { shown: false }
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db as Parameters<typeof loadAccountMetaCredentials>[0],
      args.accountId,
    )
    await sendTypingIndicator({ phoneNumberId, accessToken, messageId: latest })
    return { shown: true }
  } catch (err) {
    // Cosmetic — never fail the agent's turn over it.
    console.warn('[agent-bridge] typing indicator failed:', err)
    return { shown: false }
  }
}

/** Knowledge-base excerpts relevant to `query`. */
export async function agentKnowledge(
  db: SupabaseClient,
  args: { accountId: string; query: string; k?: number },
): Promise<string[]> {
  const query = args.query.trim().slice(0, 1000)
  if (!query) return []
  const config = await loadAiConfig(db, args.accountId, { requireActive: false })
  return retrieveKnowledge(
    db,
    args.accountId,
    { embeddingsApiKey: config?.embeddingsApiKey ?? null },
    query,
    Math.min(Math.max(args.k ?? 5, 1), 8),
  )
}
