import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { configuredTestNumbers, isTestNumber } from '@/lib/inbox/test-reset'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/conversations/[id]/test-reset  (admin+)
 *
 * Wipes a chat with one of the owner's TEST numbers so the AI agent can be
 * tested from scratch. Only works for numbers in
 * NEXT_PUBLIC_TEST_PHONE_NUMBERS; any other chat gets 403.
 *
 * Deletes the contact's deals, then the contact itself. Deleting the
 * contact cascades to its conversations (and their messages), tags, custom
 * values and notes — so the agent's lead memory is gone too. The next
 * message from that number starts a brand-new contact and chat.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id, contacts(phone)')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[test-reset] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Could not load the conversation' }, { status: 500 })
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as
      | { phone: string | null }
      | null
    if (!isTestNumber(contact?.phone, configuredTestNumbers())) {
      return NextResponse.json(
        { error: 'Only chats with test numbers can be reset' },
        { status: 403 },
      )
    }

    const contactId = conv.contact_id as string

    // Deals point at the conversation with no ON DELETE action, which
    // would block the cascade — remove this test lead's deals first.
    const { error: dealsErr } = await supabase
      .from('deals')
      .delete()
      .eq('account_id', accountId)
      .or(`contact_id.eq.${contactId},conversation_id.eq.${id}`)
    if (dealsErr) {
      console.error('[test-reset] deals delete error:', dealsErr)
      return NextResponse.json({ error: 'Could not delete the test deals' }, { status: 500 })
    }

    const { data: deleted, error: contactErr } = await supabase
      .from('contacts')
      .delete()
      .eq('id', contactId)
      .eq('account_id', accountId)
      .select('id')
    if (contactErr) {
      console.error('[test-reset] contact delete error:', contactErr)
      return NextResponse.json({ error: 'Could not delete the test chat' }, { status: 500 })
    }
    if (!deleted || deleted.length === 0) {
      return NextResponse.json({ error: 'Nothing was deleted' }, { status: 409 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
