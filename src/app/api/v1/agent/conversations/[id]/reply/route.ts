// ============================================================
// POST /api/v1/agent/conversations/{id}/reply — send the agent's reply
// as 1–3 WhatsApp messages (scope: ai:agent).
//
// Body: { "parts": ["…", "…"], "in_reply_to": "wamid.…" }
// 201 → { whatsapp_message_ids }. 409 `conflict` when the CRM refuses:
// AI off / paused / assigned / reply limit reached / stale (the customer
// wrote again — re-read the conversation and re-plan).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import { parseReplyParts, sendAgentReply } from '@/lib/ai/agent-bridge';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'ai:agent');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const parts = parseReplyParts(body.parts);
    const inReplyTo = typeof body.in_reply_to === 'string' ? body.in_reply_to : null;

    const result = await sendAgentReply(ctx.supabase, {
      accountId: ctx.accountId,
      userId: ctx.createdBy,
      conversationId: id,
      parts,
      inReplyTo,
    });
    return ok(result, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
