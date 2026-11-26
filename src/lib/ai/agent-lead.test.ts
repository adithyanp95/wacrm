import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb, type FakeTables } from '@/lib/flows/fake-db.test-helper'

const h = vi.hoisted(() => ({ dispatched: [] as { contactId: string; tagId: string }[] }))

// The real writer also fires tag automations; here we just record the
// call and write the join row, which is what the lead logic depends on.
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: async (input: {
    db: { from: (t: string) => { insert: (r: unknown) => Promise<unknown> } }
    contactId: string
    tagId: string
  }) => {
    h.dispatched.push({ contactId: input.contactId, tagId: input.tagId })
    await input.db.from('contact_tags').insert({ contact_id: input.contactId, tag_id: input.tagId })
    return { added: true, dispatched: true }
  },
}))

import {
  AI_PIPELINE_NAME,
  applyLeadUpdate,
  getLeadProfile,
  parseLeadUpdate,
  sweepSilentLeads,
} from './agent-lead'

const ACCT = 'acct-1'
const USER = 'user-1'
let tables: FakeTables
let db: never

function tagId(name: string) {
  return (tables.tags.find((t) => t.name === name && t.account_id === ACCT)?.id as string) ?? null
}
function hasTag(contactId: string, name: string) {
  const id = tagId(name)
  return !!id && tables.contact_tags.some((r) => r.contact_id === contactId && r.tag_id === id)
}
function fieldValue(contactId: string, fieldName: string) {
  const f = tables.custom_fields.find((r) => r.field_name === fieldName)
  return tables.contact_custom_values.find(
    (r) => r.contact_id === contactId && r.custom_field_id === f?.id,
  )?.value
}
function stageNameOf(deal: Record<string, unknown>) {
  return tables.pipeline_stages.find((s) => s.id === deal.stage_id)?.name
}
const apply = (update: unknown, conversationId = 'conv-1') =>
  applyLeadUpdate(db, {
    accountId: ACCT,
    userId: USER,
    conversationId,
    update: parseLeadUpdate(update),
  })

beforeEach(() => {
  h.dispatched = []
  tables = {
    conversations: [
      { id: 'conv-1', account_id: ACCT, contact_id: 'contact-1' },
      { id: 'conv-2', account_id: ACCT, contact_id: 'contact-2' },
    ],
    contacts: [
      { id: 'contact-1', account_id: ACCT, name: 'Ada', phone: '9100' },
      { id: 'contact-2', account_id: ACCT, name: null, phone: '9200' },
      { id: 'old-contact', account_id: ACCT, name: 'Old', phone: '9300' },
    ],
    accounts: [{ id: ACCT, default_currency: 'INR' }],
    custom_fields: [],
    contact_custom_values: [],
    tags: [{ id: 'team-tag', account_id: ACCT, name: 'VIP', color: '#000' }],
    contact_tags: [{ contact_id: 'contact-1', tag_id: 'team-tag' }],
    pipelines: [],
    pipeline_stages: [],
    deals: [],
    contact_notes: [],
    messages: [],
  }
  db = createFakeDb(tables) as never
})

describe('parseLeadUpdate', () => {
  it('keeps valid parts and drops the rest', () => {
    const u = parseLeadUpdate({
      fields: { business_type: '  Boutique ', location: '', unknown_field: 'x', budget: 5000 },
      temperature: 'boiling',
      stage: 'price_shared',
      outcome: 'won',
      deal_value: '3000',
      note: '   ',
    })
    expect(u).toEqual({ fields: { business_type: 'Boutique' }, stage: 'price_shared', deal_value: 3000 })
  })

  it('rejects a non-object body', () => {
    expect(() => parseLeadUpdate(null)).toThrow()
  })
})

describe('applyLeadUpdate', () => {
  it('first update creates fields, the AI Sales pipeline, a deal and the interest tag', async () => {
    const res = await apply({
      fields: { business_type: 'Boutique', location: 'Kochi', budget: '₹5,000' },
      temperature: 'warm',
      stage: 'talking',
    })

    expect(fieldValue('contact-1', 'Business type')).toBe('Boutique')
    expect(fieldValue('contact-1', 'Location')).toBe('Kochi')
    expect(fieldValue('contact-1', 'Monthly ad budget')).toBe('₹5,000')

    expect(tables.pipelines).toEqual([expect.objectContaining({ name: AI_PIPELINE_NAME, account_id: ACCT })])
    expect(tables.pipeline_stages.map((s) => s.name)).toEqual([
      'New lead',
      'Talking',
      'Price shared',
      'Proof shared',
      'Ready to start',
    ])
    expect(tables.deals).toHaveLength(1)
    expect(tables.deals[0]).toMatchObject({
      contact_id: 'contact-1',
      currency: 'INR',
      status: 'open',
      title: 'Ada — AI lead',
    })
    // Never linked to the chat: that foreign key has no ON DELETE rule
    // and would block deleting the chat or the contact.
    expect(tables.deals[0]).not.toHaveProperty('conversation_id')
    expect(stageNameOf(tables.deals[0])).toBe('Talking')

    expect(hasTag('contact-1', 'Warm')).toBe(true)
    expect(h.dispatched).toEqual([{ contactId: 'contact-1', tagId: tagId('Warm') }])
    expect(res.applied).toEqual(expect.arrayContaining(['fields', 'temperature:warm', 'deal_created:talking']))
  })

  it('moves the deal forward only, swaps the interest tag, and updates fields', async () => {
    await apply({ temperature: 'warm', stage: 'price_shared' })
    await apply({ temperature: 'hot', stage: 'talking', fields: { plan: 'Starter' }, deal_value: 3000 })

    expect(tables.deals).toHaveLength(1)
    expect(stageNameOf(tables.deals[0])).toBe('Price shared') // not moved back
    expect(tables.deals[0].value).toBe(3000)
    expect(hasTag('contact-1', 'Hot')).toBe(true)
    expect(hasTag('contact-1', 'Warm')).toBe(false)
    expect(fieldValue('contact-1', 'Interested plan')).toBe('Starter')

    await apply({ stage: 'ready', fields: { plan: 'Growth' } })
    expect(stageNameOf(tables.deals[0])).toBe('Ready to start')
    expect(fieldValue('contact-1', 'Interested plan')).toBe('Growth')
    // Fields and the pipeline are created once, then reused.
    expect(tables.pipelines).toHaveLength(1)
    expect(tables.custom_fields.filter((f) => f.field_name === 'Interested plan')).toHaveLength(1)
  })

  it('never touches the team’s own tags', async () => {
    await apply({ temperature: 'cold' })
    await apply({ temperature: 'hot', outcome: 'lost', outcome_reason: 'too expensive' })
    expect(hasTag('contact-1', 'VIP')).toBe(true)
  })

  it('records a lost outcome: tag, closed deal and a note with the reason', async () => {
    await apply({ stage: 'price_shared' })
    await apply({ outcome: 'lost', outcome_reason: 'Chose another agency' })

    expect(hasTag('contact-1', 'Lost')).toBe(true)
    expect(tables.deals[0]).toMatchObject({ status: 'lost' })
    expect(tables.deals[0].closed_at).toBeTruthy()
    expect(tables.contact_notes).toEqual([
      expect.objectContaining({ contact_id: 'contact-1', note_text: '🤖 Lost: Chose another agency' }),
    ])
  })

  it('clears an earlier "Silent" tag once the lead talks again', async () => {
    await apply({ stage: 'price_shared' })
    tables.tags.push({ id: 'silent-tag', account_id: ACCT, name: 'Silent', color: '#999' })
    tables.contact_tags.push({ contact_id: 'contact-1', tag_id: 'silent-tag' })

    const res = await apply({ temperature: 'warm' })
    expect(hasTag('contact-1', 'Silent')).toBe(false)
    expect(res.applied).toContain('silent_cleared')
  })

  it('saves a free-form note (e.g. the handoff summary)', async () => {
    await apply({ note: 'Wants a call tomorrow about Growth.' })
    expect(tables.contact_notes[0]).toMatchObject({
      note_text: '🤖 Wants a call tomorrow about Growth.',
      account_id: ACCT,
      user_id: USER,
    })
  })

  it('404s for a conversation outside the account', async () => {
    await expect(apply({ temperature: 'hot' }, 'conv-x')).rejects.toMatchObject({ status: 404 })
  })
})

describe('getLeadProfile', () => {
  it('returns what the CRM knows: fields, interest, stage', async () => {
    await apply({
      fields: { business_type: 'Clinic', goal: 'More appointments' },
      temperature: 'hot',
      stage: 'proof_shared',
    })
    expect(await getLeadProfile(db, ACCT, 'contact-1')).toEqual({
      fields: { business_type: 'Clinic', goal: 'More appointments' },
      temperature: 'hot',
      stage: 'proof_shared',
      outcome: null,
    })
  })

  it('is empty for a contact the agent never handled', async () => {
    expect(await getLeadProfile(db, ACCT, 'old-contact')).toEqual({
      fields: {},
      temperature: null,
      stage: null,
      outcome: null,
    })
  })
})

describe('sweepSilentLeads', () => {
  const NOW = new Date('2026-11-26T12:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

  beforeEach(async () => {
    await apply({ stage: 'price_shared' }, 'conv-1')
    await apply({ stage: 'talking' }, 'conv-2')
  })

  it('tags a lead Silent when OUR message was last and old enough, noting where they stopped', async () => {
    tables.messages.push(
      { conversation_id: 'conv-1', sender_type: 'customer', created_at: hoursAgo(100) },
      { conversation_id: 'conv-1', sender_type: 'bot', created_at: hoursAgo(80) },
    )
    // Fake DB ignores ORDER BY, so keep the newest message first.
    tables.messages.reverse()

    const res = await sweepSilentLeads(db, { accountId: ACCT, userId: USER, afterHours: 72, now: NOW })
    expect(res).toEqual({ checked: 2, marked: 1 })
    expect(hasTag('contact-1', 'Silent')).toBe(true)
    expect(tables.contact_notes.at(-1)).toMatchObject({
      contact_id: 'contact-1',
      note_text: '🤖 Went silent after: Price shared (no reply for 3 days).',
    })
  })

  it('leaves leads whose last message is theirs, or ours but recent', async () => {
    tables.messages.push(
      { conversation_id: 'conv-1', sender_type: 'customer', created_at: hoursAgo(90) },
      { conversation_id: 'conv-2', sender_type: 'bot', created_at: hoursAgo(10) },
    )
    const res = await sweepSilentLeads(db, { accountId: ACCT, userId: USER, afterHours: 72, now: NOW })
    expect(res.marked).toBe(0)
  })

  it('skips leads already marked Lost or Silent, and never touches old contacts', async () => {
    await apply({ outcome: 'lost' }, 'conv-1')
    tables.messages.push(
      { conversation_id: 'conv-1', sender_type: 'bot', created_at: hoursAgo(200) },
      { conversation_id: 'conv-2', sender_type: 'bot', created_at: hoursAgo(200) },
    )
    const first = await sweepSilentLeads(db, { accountId: ACCT, userId: USER, afterHours: 72, now: NOW })
    expect(first.marked).toBe(1) // only conv-2; conv-1's deal is closed as lost
    const second = await sweepSilentLeads(db, { accountId: ACCT, userId: USER, afterHours: 72, now: NOW })
    expect(second.marked).toBe(0) // already Silent
    expect(hasTag('old-contact', 'Silent')).toBe(false)
  })

  it('does nothing before the agent has created its pipeline', async () => {
    tables.pipelines = []
    const res = await sweepSilentLeads(db, { accountId: ACCT, userId: USER, afterHours: 72, now: NOW })
    expect(res).toEqual({ checked: 0, marked: 0 })
  })
})
