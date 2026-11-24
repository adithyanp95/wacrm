import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  engineSendText: vi.fn(),
  handOff: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    /** Newest first, as the DB returns them. */
    messages: [] as Record<string, unknown>[],
    claim: true as boolean,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: vi.fn() }))
vi.mock('./auto-reply', async () => ({
  handOff: h.handOff,
  isExternalAgentMode: () => process.env.AI_AGENT_MODE === 'external',
}))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: vi.fn(),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTypingIndicator: vi.fn() }))

import {
  blockedReason,
  getAgentContext,
  parseReplyParts,
  sendAgentReply,
  agentHandoff,
  typingPauseMs,
} from './agent-bridge'
import { ApiError } from '@/lib/api/v1/respond'

function fakeDb() {
  const chain = (result: () => unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order']) c[m] = () => c
    c.maybeSingle = () => Promise.resolve({ data: result(), error: null })
    c.limit = () => Promise.resolve({ data: result(), error: null })
    return c
  }
  return {
    from: (table: string) => {
      if (table === 'conversations') return chain(() => h.state.conv)
      if (table === 'messages') return chain(() => h.state.messages)
      if (table === 'contacts') return chain(() => ({ id: 'contact-1', name: 'Ada', company: null }))
      if (table === 'whatsapp_config') return chain(() => ({ user_id: 'owner-1' }))
      throw new Error(`unexpected table ${table}`)
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  } as never
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    baseUrl: null,
    apiKey: 'sk-test',
    systemPrompt: 'You sell Meta Ads.',
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 20,
    handoffAgentId: 'agent-7',
    embeddingsApiKey: null,
    ...overrides,
  }
}

const BASE = {
  accountId: 'acct-1',
  userId: 'key-owner',
  conversationId: 'conv-1',
  parts: ['Hey!', 'What business do you run?'],
  sleep: async () => {},
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AI_AGENT_MODE = 'external'
  h.state.conv = {
    id: 'conv-1',
    contact_id: 'contact-1',
    status: 'open',
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.messages = [
    { sender_type: 'customer', content_type: 'audio', content_text: 'ethra aanu?', message_id: 'wamid.2', created_at: '2026-11-25T10:01:00Z' },
    { sender_type: 'customer', content_type: 'image', content_text: null, message_id: 'wamid.1', created_at: '2026-11-25T10:00:00Z' },
  ]
  h.state.claim = true
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.engineSendText.mockImplementation(async ({ text }: { text: string }) => ({
    whatsapp_message_id: `wamid.out.${text.length}`,
  }))
})

afterEach(() => {
  delete process.env.AI_AGENT_MODE
})

describe('blockedReason', () => {
  const conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }

  it('allows a reply when every switch is on', () => {
    expect(blockedReason(aiConfig(), conv)).toBeNull()
  })

  it('refuses when the CRM is not in external mode (no double replies)', () => {
    delete process.env.AI_AGENT_MODE
    expect(blockedReason(aiConfig(), conv)).toBe('external_mode_off')
  })

  it('reports each rule in priority order', () => {
    expect(blockedReason(null, conv)).toBe('ai_off')
    expect(blockedReason(aiConfig({ autoReplyEnabled: false }), conv)).toBe('auto_reply_off')
    expect(blockedReason(aiConfig(), { ...conv, assigned_agent_id: 'u1' })).toBe('assigned')
    expect(blockedReason(aiConfig(), { ...conv, ai_autoreply_disabled: true })).toBe('paused')
    expect(blockedReason(aiConfig(), { ...conv, ai_reply_count: 20 })).toBe('reply_limit')
  })
})

describe('parseReplyParts', () => {
  it('accepts 1–3 parts and trims them', () => {
    expect(parseReplyParts([' Hi ', 'Two'])).toEqual(['Hi', 'Two'])
    expect(parseReplyParts('Just one')).toEqual(['Just one'])
  })

  it('rejects empty, non-string, too many, or too long parts', () => {
    expect(() => parseReplyParts([])).toThrow(ApiError)
    expect(() => parseReplyParts(['ok', ' '])).toThrow(ApiError)
    expect(() => parseReplyParts(['ok', 3])).toThrow(ApiError)
    expect(() => parseReplyParts(['a', 'b', 'c', 'd'])).toThrow(ApiError)
    expect(() => parseReplyParts(['x'.repeat(1001)])).toThrow(ApiError)
    expect(() => parseReplyParts(null)).toThrow(ApiError)
  })
})

describe('typingPauseMs', () => {
  it('scales with length within 0.8–2.5 s', () => {
    expect(typingPauseMs('Hi')).toBe(800)
    expect(typingPauseMs('x'.repeat(40))).toBe(1400)
    expect(typingPauseMs('x'.repeat(500))).toBe(2500)
  })
})

describe('getAgentContext', () => {
  it('returns state, prompt, latest customer message and text messages oldest-first', async () => {
    const ctx = await getAgentContext(fakeDb(), 'acct-1', 'conv-1')
    expect(ctx.conversation.blocked_reason).toBeNull()
    expect(ctx.conversation.ai_reply_limit).toBe(20)
    expect(ctx.business_prompt).toBe('You sell Meta Ads.')
    expect(ctx.latest_customer_message_id).toBe('wamid.2')
    // The image has no text, so only the voice-note transcript remains.
    expect(ctx.messages).toEqual([
      expect.objectContaining({ role: 'user', content_type: 'audio', content: 'ethra aanu?' }),
    ])
  })

  it('404s for a conversation outside the account', async () => {
    h.state.conv = null
    await expect(getAgentContext(fakeDb(), 'acct-1', 'conv-x')).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('sendAgentReply', () => {
  it('claims ONE slot and sends every part as an AI message', async () => {
    const res = await sendAgentReply(fakeDb(), { ...BASE, inReplyTo: 'wamid.2' })
    expect(h.state.rpcCalls).toEqual([
      { name: 'claim_ai_reply_slot', args: { conversation_id: 'conv-1', max_replies: 20 } },
    ])
    expect(h.engineSendText).toHaveBeenCalledTimes(2)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hey!', aiGenerated: true, contactId: 'contact-1', userId: 'key-owner' }),
    )
    expect(res.whatsapp_message_ids).toHaveLength(2)
  })

  it('refuses a stale reply when the customer wrote again', async () => {
    await expect(
      sendAgentReply(fakeDb(), { ...BASE, inReplyTo: 'wamid.1' }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('stale') })
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('refuses when a team member took over', async () => {
    h.state.conv = { ...h.state.conv, assigned_agent_id: 'u1' }
    await expect(sendAgentReply(fakeDb(), BASE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('assigned'),
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('refuses when the atomic claim loses the last slot', async () => {
    h.state.claim = false
    await expect(sendAgentReply(fakeDb(), BASE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('reply_limit'),
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('falls back to the WhatsApp config owner when the key creator is gone', async () => {
    await sendAgentReply(fakeDb(), { ...BASE, userId: null, parts: ['Hi'] })
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1' }))
  })
})

describe('agentHandoff', () => {
  it("uses the agent's summary and the configured handoff agent", async () => {
    await agentHandoff(fakeDb(), {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      summary: 'Boutique owner in Kochi, ready to start.',
    })
    expect(h.handOff).toHaveBeenCalledWith(
      expect.anything(),
      'agent-7',
      'conv-1',
      '🤖 Boutique owner in Kochi, ready to start.',
    )
  })

  it('writes a default summary when none is given', async () => {
    await agentHandoff(fakeDb(), { accountId: 'acct-1', conversationId: 'conv-1' })
    expect(h.handOff.mock.calls[0][3]).toContain('ethra aanu?')
  })
})
