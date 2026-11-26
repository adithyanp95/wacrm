import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { configuredTestNumbers } from '@/lib/inbox/test-reset'

/**
 * GET /api/conversations/test-numbers  (admin+)
 *
 * The owner's test numbers, read from the server's environment at request
 * time. The inbox uses this to decide where to show "Reset test chat".
 * Agents and viewers get 403 and never see the button.
 */
export async function GET() {
  try {
    await requireRole('admin')
    return NextResponse.json(
      { numbers: [...configuredTestNumbers()] },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
