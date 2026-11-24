// Thin client for the CRM's /api/v1/agent bridge. The CRM enforces every
// rule (AI switches, pause, assignment, reply limit, stale replies); this
// client only reports what it said.

export type BlockedReason =
  | 'external_mode_off'
  | 'ai_off'
  | 'auto_reply_off'
  | 'assigned'
  | 'paused'
  | 'reply_limit';

export interface AgentContext {
  conversation: {
    id: string;
    status: string;
    assigned_agent_id: string | null;
    ai_paused: boolean;
    ai_reply_count: number;
    ai_reply_limit: number | null;
    blocked_reason: BlockedReason | null;
  };
  contact: { id: string; name: string | null; company: string | null } | null;
  business_prompt: string | null;
  model: string | null;
  latest_customer_message_id: string | null;
  messages: {
    role: 'user' | 'assistant';
    sent_by: 'customer' | 'agent' | 'bot';
    content_type: string;
    content: string;
    at: string;
  }[];
}

export class CrmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CrmError';
  }

  /** For a 409: the machine reason before the colon ("stale", "reply_limit", …). */
  get reason(): string | null {
    if (this.status !== 409) return null;
    return this.message.split(':')[0]?.trim() || null;
  }
}

export interface Crm {
  getContext(conversationId: string): Promise<AgentContext>;
  reply(conversationId: string, parts: string[], inReplyTo: string | null): Promise<void>;
  handoff(conversationId: string, summary: string | null): Promise<void>;
  typing(conversationId: string): Promise<void>;
  knowledge(query: string): Promise<string[]>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export function createCrmClient(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Crm {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/api/v1/agent${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CrmError(0, 'network', `CRM unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as
      | { data?: T; error?: { code?: string; message?: string } }
      | null;
    if (!res.ok) {
      throw new CrmError(
        res.status,
        json?.error?.code ?? 'unknown',
        json?.error?.message ?? `CRM returned HTTP ${res.status}`,
      );
    }
    return json?.data as T;
  }

  const conv = (id: string) => `/conversations/${encodeURIComponent(id)}`;

  return {
    getContext: (id) => call<AgentContext>('GET', conv(id)),
    reply: async (id, parts, inReplyTo) => {
      await call('POST', `${conv(id)}/reply`, { parts, in_reply_to: inReplyTo });
    },
    handoff: async (id, summary) => {
      await call('POST', `${conv(id)}/handoff`, summary ? { summary } : {});
    },
    typing: async (id) => {
      await call('POST', `${conv(id)}/typing`, {});
    },
    knowledge: async (query) => {
      const data = await call<{ excerpts: string[] }>(
        'GET',
        `/knowledge?q=${encodeURIComponent(query)}&k=5`,
      );
      return data?.excerpts ?? [];
    },
  };
}
