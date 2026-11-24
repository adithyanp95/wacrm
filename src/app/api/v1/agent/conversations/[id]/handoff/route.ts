// ============================================================
// POST /api/v1/agent/conversations/{id}/handoff — hand the thread to the
// team: pause AI here, leave a note, assign the handoff agent from
// Settings → AI (scope: ai:agent).
//
// Body (optional): { "summary": "Lead runs a boutique in Kochi, wants …" }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import { agentHandoff } from '@/lib/ai/agent-bridge';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
    await agentHandoff(ctx.supabase, {
      accountId: ctx.accountId,
      conversationId: id,
      summary: body?.summary,
    });
    return ok({ handed_off: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
