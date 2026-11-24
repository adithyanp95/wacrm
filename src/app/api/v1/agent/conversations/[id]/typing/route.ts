// ============================================================
// POST /api/v1/agent/conversations/{id}/typing — show "typing…" to the
// customer (and mark their latest message read) while the agent thinks
// (scope: ai:agent). Best-effort: always 200, `shown` says if it worked.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import { agentTyping } from '@/lib/ai/agent-bridge';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);
    return ok(await agentTyping(ctx.supabase, { accountId: ctx.accountId, conversationId: id }));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
