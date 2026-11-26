// ============================================================
// POST /api/v1/agent/conversations/{id}/lead — the agent records what it
// learned this turn (scope: ai:agent): contact fields, interest tag,
// AI Sales deal stage/value, lost / not-a-fit outcome, a note.
//
// Body: { fields?: { business_type, location, ads_before, goal, budget,
//         plan, main_doubt, summary }, temperature?: hot|warm|cold,
//         stage?: new|talking|price_shared|proof_shared|ready,
//         outcome?: lost|not_a_fit, outcome_reason?, note?, deal_value? }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import { whatsappConfigOwner } from '@/lib/ai/agent-bridge';
import { applyLeadUpdate, parseLeadUpdate } from '@/lib/ai/agent-lead';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);

    const update = parseLeadUpdate(await request.json().catch(() => null));
    const userId = ctx.createdBy ?? (await whatsappConfigOwner(ctx.supabase, ctx.accountId));
    const result = await applyLeadUpdate(ctx.supabase, {
      accountId: ctx.accountId,
      userId,
      conversationId: id,
      update,
    });
    return ok(result);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
