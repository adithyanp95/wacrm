import { CrmError, type Crm } from './crm.js';
import {
  buildSystemPrompt,
  callOpenAi,
  knowledgeQuery,
  parseDecision,
  toChatTurns,
  type Decision,
} from './brain.js';

export interface TurnDeps {
  crm: Crm;
  /** Returns the raw model output for (system prompt, chat turns, model). */
  think: (system: string, turns: ReturnType<typeof toChatTurns>, model: string) => Promise<string>;
  defaultModel: string;
  log: (line: string, extra?: Record<string, unknown>) => void;
}

export type TurnOutcome =
  | 'skipped_blocked'
  | 'skipped_answered'
  | 'replied'
  | 'handed_off'
  | 'stale';

/**
 * One agent turn for one conversation: read → decide → act.
 * Logs ids and outcomes only — never message content.
 */
export async function runTurn(deps: TurnDeps, conversationId: string): Promise<TurnOutcome> {
  const { crm, log } = deps;
  const ctx = await crm.getContext(conversationId);

  const last = ctx.messages[ctx.messages.length - 1];
  const leadWaiting = !!last && last.role === 'user';

  if (ctx.conversation.blocked_reason === 'reply_limit' && leadWaiting) {
    // The lead wrote and the AI may not answer any more: put the thread
    // in front of the team instead of going silent.
    await crm.handoff(conversationId, 'Reached the AI reply limit for this conversation.');
    log('reply limit — handed off', { conversationId });
    return 'handed_off';
  }
  if (ctx.conversation.blocked_reason) {
    log('skip', { conversationId, reason: ctx.conversation.blocked_reason });
    return 'skipped_blocked';
  }
  if (!leadWaiting) {
    log('skip', { conversationId, reason: 'nothing new from the lead' });
    return 'skipped_answered';
  }

  await crm.typing(conversationId).catch(() => {});

  const knowledge = await crm.knowledge(knowledgeQuery(ctx.messages)).catch((err) => {
    log('knowledge search failed', { conversationId, error: String(err) });
    return [] as string[];
  });

  const system = buildSystemPrompt({
    businessPrompt: ctx.business_prompt,
    knowledge,
    contactName: ctx.contact?.name ?? null,
  });
  const model = ctx.model || deps.defaultModel;

  let decision: Decision;
  try {
    decision = parseDecision(await deps.think(system, toChatTurns(ctx.messages), model));
  } catch (err) {
    // The brain failed (timeout, quota, bad key). Don't leave the lead
    // hanging silently: put the thread in front of the team.
    log('brain failed — handing off', { conversationId, error: String(err) });
    await crm.handoff(conversationId, 'The AI could not reply (model error). Please follow up.');
    return 'handed_off';
  }

  if (decision.action === 'handoff') {
    if (decision.messages.length > 0) {
      await sendReply(deps, conversationId, decision.messages, ctx.latest_customer_message_id).catch(
        () => {},
      );
    }
    await crm.handoff(conversationId, decision.summary);
    log('handed off', { conversationId });
    return 'handed_off';
  }

  const outcome = await sendReply(deps, conversationId, decision.messages, ctx.latest_customer_message_id);
  if (outcome === 'reply_limit') {
    await crm.handoff(conversationId, 'Reached the AI reply limit for this conversation.');
    log('reply limit — handed off', { conversationId });
    return 'handed_off';
  }
  if (outcome === 'stale') {
    // The lead wrote again while we were thinking; that message's own
    // webhook has already scheduled a fresh turn that will see it.
    log('stale — newer message will be answered', { conversationId });
    return 'stale';
  }
  log('replied', { conversationId, parts: decision.messages.length });
  return 'replied';
}

async function sendReply(
  deps: TurnDeps,
  conversationId: string,
  parts: string[],
  inReplyTo: string | null,
): Promise<'sent' | 'stale' | 'reply_limit'> {
  try {
    await deps.crm.reply(conversationId, parts, inReplyTo);
    return 'sent';
  } catch (err) {
    if (err instanceof CrmError && err.reason === 'stale') return 'stale';
    if (err instanceof CrmError && err.reason === 'reply_limit') return 'reply_limit';
    throw err;
  }
}

/** Production `think`: OpenAI with the configured key and timeout. */
export function openAiThinker(apiKey: string, timeoutMs: number, modelOverride: string | null) {
  return (system: string, turns: ReturnType<typeof toChatTurns>, model: string) =>
    callOpenAi({ apiKey, model: modelOverride ?? model, system, turns, timeoutMs });
}
