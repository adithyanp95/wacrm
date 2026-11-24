// ============================================================
// GET /api/v1/agent/knowledge?q=…&k=5 — Knowledge-base excerpts for the
// agent to ground prices, offers and policies in (scope: ai:agent).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { agentKnowledge } from '@/lib/ai/agent-bridge';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) return fail('bad_request', "'q' is required", 400);
    const k = Number(url.searchParams.get('k') ?? 5);
    const excerpts = await agentKnowledge(ctx.supabase, {
      accountId: ctx.accountId,
      query: q,
      k: Number.isFinite(k) ? k : 5,
    });
    return ok({ excerpts });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
