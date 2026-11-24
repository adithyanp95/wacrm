// ============================================================
// GET /api/v1/agent/conversations/{id} — everything the external AI
// agent needs for its next turn: state, whether it may reply, the
// business prompt, and recent messages (scope: ai:agent).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import { getAgentContext } from '@/lib/ai/agent-bridge';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);
    return ok(await getAgentContext(ctx.supabase, ctx.accountId, id));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
