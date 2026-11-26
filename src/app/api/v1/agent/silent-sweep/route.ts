// ============================================================
// POST /api/v1/agent/silent-sweep — tag AI leads that stopped replying
// as "Silent", with a note saying where they stopped (scope: ai:agent).
// The agent calls this on a timer. Body: { "after_hours": 72 }.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { whatsappConfigOwner } from '@/lib/ai/agent-bridge';
import { sweepSilentLeads } from '@/lib/ai/agent-lead';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const body = (await request.json().catch(() => ({}))) as { after_hours?: unknown } | null;
    const afterHours = Number(body?.after_hours ?? 72);
    const userId = ctx.createdBy ?? (await whatsappConfigOwner(ctx.supabase, ctx.accountId));
    const result = await sweepSilentLeads(ctx.supabase, {
      accountId: ctx.accountId,
      userId,
      afterHours: Number.isFinite(afterHours) ? afterHours : 72,
    });
    return ok(result);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
