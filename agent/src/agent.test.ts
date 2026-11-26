import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { verifySignature } from './signature.js';
import { ConversationScheduler } from './scheduler.js';
import {
  buildSystemPrompt,
  humanizePunctuation,
  parseDecision,
  toChatTurns,
  knowledgeQuery,
} from './brain.js';
import { runTurn, type TurnDeps } from './turn.js';
import { CrmError, type AgentContext, type Crm } from './crm.js';
import { createAgentServer } from './server.js';
import { loadConfig } from './config.js';

const SECRET = 'whsec_test';
const sign = (body: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

describe('verifySignature', () => {
  it('accepts a correct, fresh signature', () => {
    expect(verifySignature(sign('{"a":1}'), '{"a":1}', SECRET)).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets, old timestamps and junk', () => {
    expect(verifySignature(sign('{"a":1}'), '{"a":2}', SECRET)).toBe(false);
    expect(verifySignature(sign('{}'), '{}', 'other')).toBe(false);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifySignature(sign('{}', old), '{}', SECRET)).toBe(false);
    expect(verifySignature(undefined, '{}', SECRET)).toBe(false);
    expect(verifySignature('t=abc,v1=zz', '{}', SECRET)).toBe(false);
  });
});

describe('ConversationScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('answers a burst of messages once, after the lead goes quiet', async () => {
    vi.useFakeTimers();
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const s = new ConversationScheduler({ debounceMs: 10_000, maxWaitMs: 30_000, runTurn });
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(4_000);
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(4_000);
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(runTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('never waits longer than maxWaitMs after the first message', async () => {
    vi.useFakeTimers();
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const s = new ConversationScheduler({ debounceMs: 10_000, maxWaitMs: 15_000, runTurn });
    for (let i = 0; i < 5; i++) {
      s.notify('c1');
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('runs one follow-up turn for messages that arrive mid-turn, never two at once', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const runTurn = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (runTurn.mock.calls.length === 1) await new Promise<void>((r) => (release = r));
      active--;
    });
    const s = new ConversationScheduler({ debounceMs: 1_000, maxWaitMs: 5_000, runTurn });
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(1_000);
    s.notify('c1');
    s.notify('c1');
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(s.pending).toBe(0);
  });

  it('keeps conversations independent', async () => {
    vi.useFakeTimers();
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const s = new ConversationScheduler({ debounceMs: 1_000, maxWaitMs: 5_000, runTurn });
    s.notify('a');
    s.notify('b');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTurn.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
  });
});

describe('brain', () => {
  it('parses replies and caps them at 3 parts', () => {
    expect(parseDecision('{"action":"reply","messages":["Hi!","What do you sell?"]}')).toEqual({
      action: 'reply',
      messages: ['Hi!', 'What do you sell?'],
      lead: null,
    });
    const many = parseDecision(JSON.stringify({ action: 'reply', messages: ['1', '2', '3', '4'] }));
    expect(many.messages).toEqual(['1', '2', '3']);
  });

  it('parses a handoff with summary and an optional holding message', () => {
    const d = parseDecision(
      '```json\n{"action":"handoff","summary":"Wants a call","messages":["Sure, the team will call you."]}\n```',
    );
    expect(d).toEqual({
      action: 'handoff',
      summary: 'Wants a call',
      messages: ['Sure, the team will call you.'],
      lead: null,
    });
  });

  it('falls back to plain text, and to a handoff when nothing usable came back', () => {
    expect(parseDecision('Hey!\n\nWhat business do you run?')).toEqual({
      action: 'reply',
      messages: ['Hey!', 'What business do you run?'],
      lead: null,
    });
    expect(parseDecision('[[HANDOFF]]').action).toBe('handoff');
    expect(parseDecision('').action).toBe('handoff');
    expect(parseDecision('{"action":"reply","messages":[]}').action).toBe('handoff');
  });

  it('marks voice notes and merges consecutive turns', () => {
    const turns = toChatTurns([
      { role: 'user', sent_by: 'customer', content_type: 'text', content: 'hi', at: '' },
      { role: 'user', sent_by: 'customer', content_type: 'audio', content: 'ethra aanu?', at: '' },
      { role: 'assistant', sent_by: 'bot', content_type: 'text', content: 'Hey!', at: '' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'hi\n[voice note] ethra aanu?' },
      { role: 'assistant', content: 'Hey!' },
    ]);
  });

  it('builds a prompt with the business instructions, knowledge and honesty rule', () => {
    const p = buildSystemPrompt({
      businessPrompt: 'We run Meta Ads.',
      knowledge: ['Starter plan: ₹3,000/month'],
      contactName: 'Ada',
    });
    expect(p).toContain('We run Meta Ads.');
    expect(p).toContain('[1] Starter plan: ₹3,000/month');
    expect(p).toContain('"Ada"');
    expect(p).toContain('never claim to be human');
    expect(p).toContain('"action":"handoff"');
  });

  it('searches knowledge with the last two lead messages', () => {
    const q = knowledgeQuery([
      { role: 'user', sent_by: 'customer', content_type: 'text', content: 'a', at: '' },
      { role: 'assistant', sent_by: 'bot', content_type: 'text', content: 'x', at: '' },
      { role: 'user', sent_by: 'customer', content_type: 'text', content: 'b', at: '' },
      { role: 'user', sent_by: 'customer', content_type: 'text', content: 'c', at: '' },
    ]);
    expect(q).toBe('b\nc');
  });
});

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    conversation: {
      id: 'c1',
      status: 'open',
      assigned_agent_id: null,
      ai_paused: false,
      ai_reply_count: 0,
      ai_reply_limit: 20,
      blocked_reason: null,
    },
    contact: { id: 'k1', name: 'Ada', company: null },
    business_prompt: 'We run Meta Ads.',
    model: 'gpt-test',
    latest_customer_message_id: 'wamid.9',
    lead: null,
    messages: [{ role: 'user', sent_by: 'customer', content_type: 'text', content: 'META', at: '' }],
    ...overrides,
  };
}

function fakeCrm(ctx: AgentContext): Crm & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    getContext: vi.fn().mockResolvedValue(ctx),
    reply: vi.fn().mockResolvedValue(undefined),
    handoff: vi.fn().mockResolvedValue(undefined),
    typing: vi.fn().mockResolvedValue(undefined),
    knowledge: vi.fn().mockResolvedValue(['Starter plan: ₹3,000/month']),
    updateLead: vi.fn().mockResolvedValue(['fields']),
    silentSweep: vi.fn().mockResolvedValue({ checked: 0, marked: 0 }),
  };
}

function deps(crm: Crm, output: string | Error): TurnDeps {
  return {
    crm,
    think: vi.fn(async () => {
      if (output instanceof Error) throw output;
      return output;
    }),
    defaultModel: 'gpt-default',
    log: () => {},
  };
}

describe('runTurn', () => {
  it('reads, thinks with knowledge, and replies to the latest message', async () => {
    const crm = fakeCrm(context());
    const d = deps(crm, '{"action":"reply","messages":["Hey!","What business do you run?"]}');
    expect(await runTurn(d, 'c1')).toBe('replied');
    expect(crm.typing).toHaveBeenCalledWith('c1');
    expect(crm.reply).toHaveBeenCalledWith('c1', ['Hey!', 'What business do you run?'], 'wamid.9');
    const [system, , model] = (d.think as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(system).toContain('Starter plan');
    expect(model).toBe('gpt-test');
  });

  it('does nothing when the CRM says it may not reply', async () => {
    const ctx = context();
    ctx.conversation.blocked_reason = 'assigned';
    const crm = fakeCrm(ctx);
    expect(await runTurn(deps(crm, '{}'), 'c1')).toBe('skipped_blocked');
    expect(crm.typing).not.toHaveBeenCalled();
    expect(crm.reply).not.toHaveBeenCalled();
  });

  it('hands off (not silence) when the lead writes after the reply limit', async () => {
    const ctx = context();
    ctx.conversation.blocked_reason = 'reply_limit';
    const crm = fakeCrm(ctx);
    expect(await runTurn(deps(crm, '{}'), 'c1')).toBe('handed_off');
    expect(crm.handoff).toHaveBeenCalledWith('c1', expect.stringContaining('reply limit'));
    expect(crm.reply).not.toHaveBeenCalled();
  });

  it('does nothing when the last message is already an answer', async () => {
    const crm = fakeCrm(
      context({
        messages: [{ role: 'assistant', sent_by: 'bot', content_type: 'text', content: 'Hi', at: '' }],
      }),
    );
    expect(await runTurn(deps(crm, '{}'), 'c1')).toBe('skipped_answered');
  });

  it('sends the holding message, then hands off with the summary', async () => {
    const crm = fakeCrm(context());
    const out = '{"action":"handoff","summary":"Wants a call","messages":["Sure, the team will call you."]}';
    expect(await runTurn(deps(crm, out), 'c1')).toBe('handed_off');
    expect(crm.reply).toHaveBeenCalledWith('c1', ['Sure, the team will call you.'], 'wamid.9');
    expect(crm.handoff).toHaveBeenCalledWith('c1', 'Wants a call');
  });

  it('hands off instead of going silent when the model fails', async () => {
    const crm = fakeCrm(context());
    expect(await runTurn(deps(crm, new Error('OpenAI HTTP 429')), 'c1')).toBe('handed_off');
    expect(crm.reply).not.toHaveBeenCalled();
    expect(crm.handoff).toHaveBeenCalledWith('c1', expect.stringContaining('could not reply'));
  });

  it('hands off when the CRM reports the reply limit', async () => {
    const crm = fakeCrm(context());
    crm.reply.mockRejectedValue(new CrmError(409, 'conflict', 'reply_limit: limit reached'));
    expect(await runTurn(deps(crm, '{"action":"reply","messages":["Hi"]}'), 'c1')).toBe('handed_off');
    expect(crm.handoff).toHaveBeenCalled();
  });

  it('leaves a stale reply to the newer turn', async () => {
    const crm = fakeCrm(context());
    crm.reply.mockRejectedValue(new CrmError(409, 'conflict', 'stale: newer message'));
    expect(await runTurn(deps(crm, '{"action":"reply","messages":["Hi"]}'), 'c1')).toBe('stale');
    expect(crm.handoff).not.toHaveBeenCalled();
  });

  it('still replies when the knowledge search fails', async () => {
    const crm = fakeCrm(context());
    crm.knowledge.mockRejectedValue(new Error('down'));
    expect(await runTurn(deps(crm, '{"action":"reply","messages":["Hi"]}'), 'c1')).toBe('replied');
  });
});

describe('texting style fixes (live test, 2026-11-26)', () => {
  it('turns long dashes between words into commas, but keeps number ranges', () => {
    expect(humanizePunctuation('Starter plan ₹3,000/month aanu — 1 campaign, 4 posters')).toBe(
      'Starter plan ₹3,000/month aanu, 1 campaign, 4 posters',
    );
    expect(humanizePunctuation('report send cheyyum—free plan share cheyyatte?')).toBe(
      'report send cheyyum, free plan share cheyyatte?',
    );
    expect(humanizePunctuation('enquiries in 1–2 weeks')).toBe('enquiries in 1–2 weeks');
    expect(humanizePunctuation('Sure – the team will call')).toBe('Sure, the team will call');
    expect(humanizePunctuation('— hello —')).toBe('hello');
  });

  it('applies the dash fix to every message the model sends', () => {
    const d = parseDecision('{"action":"reply","messages":["Starter ₹3,000 aanu — weekly report undu."]}');
    expect(d.messages).toEqual(['Starter ₹3,000 aanu, weekly report undu.']);
  });

  it('prompt carries the respect, honesty, language, no-repeat and no-dash rules', () => {
    const p = buildSystemPrompt({ businessPrompt: null, knowledge: [], contactName: null });
    expect(p).toContain('never nee, ninte, ninakku or ninne');
    expect(p).toContain('you are the business\'s AI assistant');
    expect(p).toContain('Never say or hint that you are not a bot');
    expect(p).toContain("EVERY message you send is in the lead's language");
    expect(p).toContain('Never repeat the question or offer from your previous message');
    expect(p).toContain('Never use long dashes');
    // The scaffold itself must not model the dash habit it forbids.
    expect(p.replace('(— or –)', '')).not.toMatch(/\s—\s/);
  });
});

describe('lead tracking', () => {
  const withLead = (action: 'reply' | 'handoff', lead: unknown, extra = '') =>
    `{"action":"${action}","messages":["Nice, boutiques do well on Instagram."]${extra},"lead":${JSON.stringify(lead)}}`;

  it('parses the lead object from the model, ignoring a non-object', () => {
    const lead = { fields: { business_type: 'Boutique' }, temperature: 'warm', stage: 'talking' };
    expect(parseDecision(withLead('reply', lead)).lead).toEqual(lead);
    expect(parseDecision(withLead('reply', 'nope')).lead).toBeNull();
    expect(parseDecision(withLead('reply', [1])).lead).toBeNull();
  });

  it('shows what is already known in the prompt, and asks for lead tracking', () => {
    const p = buildSystemPrompt({
      businessPrompt: null,
      knowledge: [],
      contactName: null,
      lead: {
        fields: { business_type: 'Boutique', location: 'Kochi' },
        temperature: 'warm',
        stage: 'price_shared',
        outcome: null,
      },
    });
    expect(p).toContain("don't ask again");
    expect(p).toContain('- Business type: Boutique');
    expect(p).toContain('- Location: Kochi');
    expect(p).toContain('- Sales stage: Price shared');
    expect(p).toContain('Lead tracking');
    // Nothing known yet → no memory block.
    const empty = buildSystemPrompt({ businessPrompt: null, knowledge: [], contactName: null, lead: null });
    expect(empty).not.toContain("don't ask again");
  });

  it('saves the lead details to the CRM after replying', async () => {
    const crm = fakeCrm(context());
    const lead = { fields: { business_type: 'Boutique' }, temperature: 'warm', stage: 'talking' };
    expect(await runTurn(deps(crm, withLead('reply', lead)), 'c1')).toBe('replied');
    expect(crm.updateLead).toHaveBeenCalledWith('c1', lead);
    // Reply first, CRM second: the lead never waits on the CRM update.
    expect(crm.reply.mock.invocationCallOrder[0]).toBeLessThan(crm.updateLead.mock.invocationCallOrder[0]);
  });

  it('adds the handoff summary as a note on handoff', async () => {
    const crm = fakeCrm(context());
    const out = withLead('handoff', { temperature: 'hot', stage: 'ready' }, ',"summary":"Ready to start Starter"');
    expect(await runTurn(deps(crm, out), 'c1')).toBe('handed_off');
    expect(crm.updateLead).toHaveBeenCalledWith('c1', {
      temperature: 'hot',
      stage: 'ready',
      note: 'Handed to the team: Ready to start Starter',
    });
  });

  it('still counts the turn as replied when the CRM update fails', async () => {
    const crm = fakeCrm(context());
    crm.updateLead.mockRejectedValue(new Error('CRM down'));
    expect(await runTurn(deps(crm, withLead('reply', { temperature: 'cold' })), 'c1')).toBe('replied');
  });

  it('skips the update when the model reported nothing, or the reply went stale', async () => {
    const crm = fakeCrm(context());
    await runTurn(deps(crm, '{"action":"reply","messages":["Hi"]}'), 'c1');
    expect(crm.updateLead).not.toHaveBeenCalled();

    crm.reply.mockRejectedValue(new CrmError(409, 'conflict', 'stale: newer message'));
    await runTurn(deps(crm, withLead('reply', { temperature: 'hot' })), 'c1');
    expect(crm.updateLead).not.toHaveBeenCalled();
  });
});

describe('webhook server', () => {
  async function withServer(fn: (url: string, received: string[]) => Promise<void>) {
    const received: string[] = [];
    const server = createAgentServer({
      webhookSecret: SECRET,
      onMessageReceived: (id) => received.push(id),
      health: () => ({ turns: 0 }),
      log: () => {},
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    try {
      await fn(`http://127.0.0.1:${port}`, received);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  const event = (id: string) =>
    JSON.stringify({ id, event: 'message.received', data: { conversation_id: 'conv-1' } });

  it('queues a verified message.received once, even if delivered twice', async () => {
    await withServer(async (url, received) => {
      const body = event('evt-1');
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${url}/webhooks/wacrm`, {
          method: 'POST',
          headers: { 'X-Wacrm-Signature': sign(body) },
          body,
        });
        expect(res.status).toBe(200);
      }
      expect(received).toEqual(['conv-1']);
    });
  });

  it('rejects an unsigned delivery', async () => {
    await withServer(async (url, received) => {
      const res = await fetch(`${url}/webhooks/wacrm`, { method: 'POST', body: event('evt-2') });
      expect(res.status).toBe(401);
      expect(received).toEqual([]);
    });
  });

  it('answers /health', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/health`);
      expect(await res.json()).toMatchObject({ ok: true, turns: 0 });
    });
  });
});

describe('loadConfig', () => {
  it('names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/WACRM_URL, WACRM_API_KEY, WACRM_WEBHOOK_SECRET, OPENAI_API_KEY/);
  });

  it('applies defaults and trims the URL', () => {
    const c = loadConfig({
      WACRM_URL: 'https://crm.example.com/',
      WACRM_API_KEY: 'k',
      WACRM_WEBHOOK_SECRET: 's',
      OPENAI_API_KEY: 'o',
    });
    expect(c).toMatchObject({ crmUrl: 'https://crm.example.com', port: 3001, debounceMs: 10_000, openaiModel: null });
  });
});
