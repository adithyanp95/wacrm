// ============================================================
// Lead updates from the external AI agent: contact fields, interest
// tag, the "AI Sales" pipeline deal, notes, and outcome tracking.
//
// The agent only ever manages ITS OWN fields / tags / pipeline (names
// below). It never deletes anything the team created, and it only
// touches contacts it is actually talking to — old contacts that never
// write in are never visited. Everything is created on first use, so
// no migration or manual setup is needed.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '@/lib/api/v1/respond'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'

export const LEAD_FIELDS = {
  business_type: 'Business type',
  location: 'Location',
  ads_before: 'Ads before?',
  goal: 'Main goal',
  budget: 'Monthly ad budget',
  plan: 'Interested plan',
  main_doubt: 'Main doubt',
  summary: 'AI summary',
} as const
export type LeadFieldKey = keyof typeof LEAD_FIELDS

export const TEMPERATURE_TAGS = {
  hot: { name: 'Hot', color: '#ef4444' },
  warm: { name: 'Warm', color: '#f59e0b' },
  cold: { name: 'Cold', color: '#3b82f6' },
} as const
export type Temperature = keyof typeof TEMPERATURE_TAGS

export const OUTCOME_TAGS = {
  lost: { name: 'Lost', color: '#6b7280' },
  not_a_fit: { name: 'Not a fit', color: '#a855f7' },
  silent: { name: 'Silent', color: '#94a3b8' },
} as const
/** Outcomes the agent may set from the chat. `silent` is set only by the
 *  timer (sweepSilentLeads); `won` only by the team (deal → Won). */
export type AgentOutcome = 'lost' | 'not_a_fit'

export const AI_PIPELINE_NAME = 'AI Sales'
export const AI_STAGES = [
  { key: 'new', name: 'New lead', color: '#94a3b8' },
  { key: 'talking', name: 'Talking', color: '#3b82f6' },
  { key: 'price_shared', name: 'Price shared', color: '#f59e0b' },
  { key: 'proof_shared', name: 'Proof shared', color: '#8b5cf6' },
  { key: 'ready', name: 'Ready to start', color: '#22c55e' },
] as const
export type StageKey = (typeof AI_STAGES)[number]['key']

const MAX_FIELD_LENGTH = 300
const MAX_NOTE_LENGTH = 1000

export interface LeadUpdate {
  fields?: Partial<Record<LeadFieldKey, string>>
  temperature?: Temperature
  stage?: StageKey
  outcome?: AgentOutcome
  outcome_reason?: string
  note?: string
  deal_value?: number
}

export interface LeadProfile {
  fields: Partial<Record<LeadFieldKey, string>>
  temperature: Temperature | null
  stage: StageKey | null
  outcome: 'lost' | 'not_a_fit' | 'silent' | 'won' | null
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? clip(t, max) : undefined
}

/**
 * Validate an agent-supplied update. Lenient by design: unknown keys and
 * invalid values are dropped rather than rejected, so one bad field from
 * the model never loses the rest of the update.
 */
export function parseLeadUpdate(input: unknown): LeadUpdate {
  if (!input || typeof input !== 'object') {
    throw new ApiError('bad_request', 'Body must be a JSON object', 400)
  }
  const raw = input as Record<string, unknown>
  const out: LeadUpdate = {}

  if (raw.fields && typeof raw.fields === 'object') {
    const fields: Partial<Record<LeadFieldKey, string>> = {}
    for (const key of Object.keys(LEAD_FIELDS) as LeadFieldKey[]) {
      const v = cleanText((raw.fields as Record<string, unknown>)[key], MAX_FIELD_LENGTH)
      if (v) fields[key] = v
    }
    if (Object.keys(fields).length > 0) out.fields = fields
  }
  if (typeof raw.temperature === 'string' && raw.temperature in TEMPERATURE_TAGS) {
    out.temperature = raw.temperature as Temperature
  }
  if (typeof raw.stage === 'string' && AI_STAGES.some((s) => s.key === raw.stage)) {
    out.stage = raw.stage as StageKey
  }
  if (raw.outcome === 'lost' || raw.outcome === 'not_a_fit') {
    out.outcome = raw.outcome
    out.outcome_reason = cleanText(raw.outcome_reason, MAX_FIELD_LENGTH)
  }
  const note = cleanText(raw.note, MAX_NOTE_LENGTH)
  if (note) out.note = note
  const value = Number(raw.deal_value)
  if (Number.isFinite(value) && value > 0 && value < 1e9) out.deal_value = Math.round(value)
  return out
}

// ── find-or-create helpers (always resolve to the OLDEST row, so a rare
//    concurrent double-create still converges on one consistent row) ──

async function ensureTag(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  tag: { name: string; color: string },
): Promise<string> {
  const find = () =>
    db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', tag.name)
      .order('created_at', { ascending: true })
      .limit(1)
  const { data } = await find()
  if (data?.[0]) return data[0].id as string
  const { error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name: tag.name, color: tag.color })
  if (error) throw new Error(`create tag ${tag.name}: ${error.message}`)
  const again = await find()
  return again.data![0].id as string
}

/** Existing tag ids by name — never creates. */
async function findTagIds(
  db: SupabaseClient,
  accountId: string,
  names: string[],
): Promise<Map<string, string>> {
  const { data } = await db
    .from('tags')
    .select('id, name, created_at')
    .eq('account_id', accountId)
    .in('name', names)
    .order('created_at', { ascending: true })
  const map = new Map<string, string>()
  for (const row of (data ?? []) as { id: string; name: string }[]) {
    if (!map.has(row.name)) map.set(row.name, row.id)
  }
  return map
}

async function contactTagIds(db: SupabaseClient, contactId: string): Promise<Set<string>> {
  const { data } = await db.from('contact_tags').select('tag_id').eq('contact_id', contactId)
  return new Set(((data ?? []) as { tag_id: string }[]).map((r) => r.tag_id))
}

async function removeTagIfPresent(db: SupabaseClient, contactId: string, tagId: string) {
  await db.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tagId)
}

async function ensureFields(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  names: string[],
): Promise<Map<string, string>> {
  const load = async () => {
    const { data } = await db
      .from('custom_fields')
      .select('id, field_name, created_at')
      .eq('account_id', accountId)
      .in('field_name', names)
      .order('created_at', { ascending: true })
    const map = new Map<string, string>()
    for (const row of (data ?? []) as { id: string; field_name: string }[]) {
      if (!map.has(row.field_name)) map.set(row.field_name, row.id)
    }
    return map
  }
  let map = await load()
  const missing = names.filter((n) => !map.has(n))
  if (missing.length > 0) {
    const { error } = await db.from('custom_fields').insert(
      missing.map((field_name) => ({
        account_id: accountId,
        user_id: userId,
        field_name,
        field_type: 'text',
      })),
    )
    if (error) throw new Error(`create custom fields: ${error.message}`)
    map = await load()
  }
  return map
}

interface PipelineInfo {
  pipelineId: string
  /** stage key → stage id */
  stageIds: Map<StageKey, string>
  /** stage id → stage key */
  stageKeys: Map<string, StageKey>
}

async function findAiPipeline(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', AI_PIPELINE_NAME)
    .order('created_at', { ascending: true })
    .limit(1)
  return (data?.[0]?.id as string | undefined) ?? null
}

async function loadStages(db: SupabaseClient, pipelineId: string) {
  const { data } = await db
    .from('pipeline_stages')
    .select('id, name, created_at')
    .eq('pipeline_id', pipelineId)
    .order('created_at', { ascending: true })
  return (data ?? []) as { id: string; name: string }[]
}

function indexStages(pipelineId: string, rows: { id: string; name: string }[]): PipelineInfo {
  const stageIds = new Map<StageKey, string>()
  const stageKeys = new Map<string, StageKey>()
  for (const s of AI_STAGES) {
    const row = rows.find((r) => r.name === s.name)
    if (row) {
      stageIds.set(s.key, row.id)
      stageKeys.set(row.id, s.key)
    }
  }
  return { pipelineId, stageIds, stageKeys }
}

async function ensureAiPipeline(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<PipelineInfo> {
  let pipelineId = await findAiPipeline(db, accountId)
  if (!pipelineId) {
    const { error } = await db
      .from('pipelines')
      .insert({ account_id: accountId, user_id: userId, name: AI_PIPELINE_NAME })
    if (error) throw new Error(`create pipeline: ${error.message}`)
    pipelineId = (await findAiPipeline(db, accountId))!
  }
  let rows = await loadStages(db, pipelineId)
  const missing = AI_STAGES.map((s, position) => ({ ...s, position })).filter(
    (s) => !rows.some((r) => r.name === s.name),
  )
  if (missing.length > 0) {
    const { error } = await db.from('pipeline_stages').insert(
      missing.map((s) => ({
        pipeline_id: pipelineId,
        name: s.name,
        position: s.position,
        color: s.color,
      })),
    )
    if (error) throw new Error(`create pipeline stages: ${error.message}`)
    rows = await loadStages(db, pipelineId)
  }
  return indexStages(pipelineId, rows)
}

interface DealRow {
  id: string
  stage_id: string
  status: string
  value: number | null
}

async function findLatestAiDeal(
  db: SupabaseClient,
  accountId: string,
  pipelineId: string,
  contactId: string,
): Promise<DealRow | null> {
  const { data } = await db
    .from('deals')
    .select('id, stage_id, status, value')
    .eq('account_id', accountId)
    .eq('pipeline_id', pipelineId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
  return (data?.[0] as DealRow | undefined) ?? null
}

const stageIndex = (key: StageKey) => AI_STAGES.findIndex((s) => s.key === key)

async function addNote(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  text: string,
) {
  await db.from('contact_notes').insert({
    account_id: accountId,
    user_id: userId,
    contact_id: contactId,
    note_text: `🤖 ${clip(text, MAX_NOTE_LENGTH)}`,
  })
}

/**
 * Apply one turn's lead update. Called right after the agent answered a
 * lead, so the lead is active: a "Silent" tag from an earlier timeout is
 * cleared. Returns the names of what changed (for logs/tests).
 */
export async function applyLeadUpdate(
  db: SupabaseClient,
  args: { accountId: string; userId: string; conversationId: string; update: LeadUpdate },
): Promise<{ applied: string[] }> {
  const { accountId, userId, conversationId, update } = args
  const applied: string[] = []

  const { data: conv } = await db
    .from('conversations')
    .select('id, contact_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conv) throw new ApiError('not_found', 'Conversation not found', 404)
  const contactId = conv.contact_id as string

  // 1. Contact fields (the lead's memory).
  if (update.fields) {
    const entries = Object.entries(update.fields) as [LeadFieldKey, string][]
    const ids = await ensureFields(db, accountId, userId, entries.map(([k]) => LEAD_FIELDS[k]))
    const rows = entries
      .map(([k, value]) => ({ contact_id: contactId, custom_field_id: ids.get(LEAD_FIELDS[k])!, value }))
      .filter((r) => r.custom_field_id)
    if (rows.length > 0) {
      const { error } = await db
        .from('contact_custom_values')
        .upsert(rows, { onConflict: 'contact_id,custom_field_id' })
      if (error) throw new Error(`save fields: ${error.message}`)
      applied.push('fields')
    }
  }

  // 2. Tags: clear Silent (they're talking again), swap the interest tag.
  const managed = await findTagIds(db, accountId, [
    OUTCOME_TAGS.silent.name,
    ...Object.values(TEMPERATURE_TAGS).map((t) => t.name),
  ])
  const current = await contactTagIds(db, contactId)
  const silentId = managed.get(OUTCOME_TAGS.silent.name)
  if (silentId && current.has(silentId)) {
    await removeTagIfPresent(db, contactId, silentId)
    applied.push('silent_cleared')
  }
  if (update.temperature) {
    const wanted = TEMPERATURE_TAGS[update.temperature]
    for (const t of Object.values(TEMPERATURE_TAGS)) {
      const id = managed.get(t.name)
      if (t.name !== wanted.name && id && current.has(id)) await removeTagIfPresent(db, contactId, id)
    }
    const tagId = await ensureTag(db, accountId, userId, wanted)
    if (!current.has(tagId)) {
      await addContactTagAndDispatch({ db, accountId, contactId, tagId })
    }
    applied.push(`temperature:${update.temperature}`)
  }

  // 3. The deal in the "AI Sales" pipeline: created on the first update,
  //    moved FORWARD only (never back), closed as lost on a lost outcome.
  const pipeline = await ensureAiPipeline(db, accountId, userId)
  let deal = await findLatestAiDeal(db, accountId, pipeline.pipelineId, contactId)
  if (!deal) {
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const { data: acct } = await db
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle()
    const firstStage = update.stage ?? 'talking'
    const { error } = await db.from('deals').insert({
      account_id: accountId,
      user_id: userId,
      pipeline_id: pipeline.pipelineId,
      stage_id: pipeline.stageIds.get(firstStage),
      contact_id: contactId,
      conversation_id: conversationId,
      title: `${contact?.name || contact?.phone || 'Lead'} — AI lead`,
      value: update.deal_value ?? 0,
      currency: acct?.default_currency ?? 'INR',
      status: 'open',
    })
    if (error) throw new Error(`create deal: ${error.message}`)
    applied.push(`deal_created:${firstStage}`)
    deal = await findLatestAiDeal(db, accountId, pipeline.pipelineId, contactId)
  } else if (deal.status === 'open') {
    const patch: Record<string, unknown> = {}
    const currentKey = pipeline.stageKeys.get(deal.stage_id)
    if (
      update.stage &&
      (!currentKey || stageIndex(update.stage) > stageIndex(currentKey)) &&
      pipeline.stageIds.get(update.stage)
    ) {
      patch.stage_id = pipeline.stageIds.get(update.stage)
      applied.push(`stage:${update.stage}`)
    }
    if (update.deal_value && update.deal_value !== Number(deal.value)) {
      patch.value = update.deal_value
      applied.push('deal_value')
    }
    if (Object.keys(patch).length > 0) {
      await db.from('deals').update(patch).eq('id', deal.id)
    }
  }

  // 4. Outcome from the chat (lost / not a fit).
  if (update.outcome) {
    const tagId = await ensureTag(db, accountId, userId, OUTCOME_TAGS[update.outcome])
    if (!current.has(tagId)) await addContactTagAndDispatch({ db, accountId, contactId, tagId })
    if (deal && deal.status === 'open') {
      await db
        .from('deals')
        .update({ status: 'lost', closed_at: new Date().toISOString() })
        .eq('id', deal.id)
    }
    const label = update.outcome === 'lost' ? 'Lost' : 'Not a fit'
    await addNote(
      db,
      accountId,
      userId,
      contactId,
      update.outcome_reason ? `${label}: ${update.outcome_reason}` : label,
    )
    applied.push(`outcome:${update.outcome}`)
  }

  // 5. Free-form note (e.g. the handoff summary).
  if (update.note) {
    await addNote(db, accountId, userId, contactId, update.note)
    applied.push('note')
  }

  return { applied }
}

/** What the CRM already knows about this lead — the agent's memory. */
export async function getLeadProfile(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<LeadProfile> {
  const profile: LeadProfile = { fields: {}, temperature: null, stage: null, outcome: null }

  const names = Object.values(LEAD_FIELDS) as string[]
  const { data: fieldRows } = await db
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)
    .in('field_name', names)
  const keyById = new Map<string, LeadFieldKey>()
  for (const row of (fieldRows ?? []) as { id: string; field_name: string }[]) {
    const key = (Object.keys(LEAD_FIELDS) as LeadFieldKey[]).find((k) => LEAD_FIELDS[k] === row.field_name)
    if (key) keyById.set(row.id, key)
  }
  if (keyById.size > 0) {
    const { data: values } = await db
      .from('contact_custom_values')
      .select('custom_field_id, value')
      .eq('contact_id', contactId)
      .in('custom_field_id', [...keyById.keys()])
    for (const v of (values ?? []) as { custom_field_id: string; value: string | null }[]) {
      const key = keyById.get(v.custom_field_id)
      if (key && v.value?.trim()) profile.fields[key] = v.value.trim()
    }
  }

  const tagNames = [
    ...Object.values(TEMPERATURE_TAGS).map((t) => t.name),
    ...Object.values(OUTCOME_TAGS).map((t) => t.name),
  ]
  const tagIds = await findTagIds(db, accountId, tagNames)
  if (tagIds.size > 0) {
    const current = await contactTagIds(db, contactId)
    for (const [key, t] of Object.entries(TEMPERATURE_TAGS) as [Temperature, { name: string }][]) {
      const id = tagIds.get(t.name)
      if (id && current.has(id)) profile.temperature = key
    }
    for (const [key, t] of Object.entries(OUTCOME_TAGS) as [keyof typeof OUTCOME_TAGS, { name: string }][]) {
      const id = tagIds.get(t.name)
      if (id && current.has(id)) profile.outcome = key
    }
  }

  const pipelineId = await findAiPipeline(db, accountId)
  if (pipelineId) {
    const deal = await findLatestAiDeal(db, accountId, pipelineId, contactId)
    if (deal) {
      if (deal.status === 'won') profile.outcome = 'won'
      const info = indexStages(pipelineId, await loadStages(db, pipelineId))
      profile.stage = info.stageKeys.get(deal.stage_id) ?? null
    }
  }
  return profile
}

/**
 * Outcome timer: an open AI deal whose conversation ended with OUR
 * message more than `afterHours` ago, and no reply since, is tagged
 * "Silent" with a note saying where the lead stopped. Only leads the
 * agent has a deal for are considered, so old contacts are never touched.
 * Rule-based — no AI call.
 */
export async function sweepSilentLeads(
  db: SupabaseClient,
  args: { accountId: string; userId: string; afterHours: number; now?: Date },
): Promise<{ checked: number; marked: number }> {
  const { accountId, userId } = args
  const afterHours = Math.min(Math.max(args.afterHours, 1), 24 * 30)
  const cutoff = new Date((args.now ?? new Date()).getTime() - afterHours * 3_600_000)

  const pipelineId = await findAiPipeline(db, accountId)
  if (!pipelineId) return { checked: 0, marked: 0 }
  const stages = indexStages(pipelineId, await loadStages(db, pipelineId))

  const { data: deals } = await db
    .from('deals')
    .select('id, contact_id, conversation_id, stage_id')
    .eq('account_id', accountId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')
    .limit(500)
  const rows = (deals ?? []) as {
    id: string
    contact_id: string
    conversation_id: string | null
    stage_id: string
  }[]

  const skipTags = await findTagIds(db, accountId, [
    OUTCOME_TAGS.silent.name,
    OUTCOME_TAGS.lost.name,
    OUTCOME_TAGS.not_a_fit.name,
  ])
  let silentTagId: string | null = skipTags.get(OUTCOME_TAGS.silent.name) ?? null
  let marked = 0

  for (const deal of rows) {
    if (!deal.conversation_id) continue
    const tags = await contactTagIds(db, deal.contact_id)
    if ([...skipTags.values()].some((id) => tags.has(id))) continue

    const { data: last } = await db
      .from('messages')
      .select('sender_type, created_at')
      .eq('conversation_id', deal.conversation_id)
      .order('created_at', { ascending: false })
      .limit(1)
    const msg = last?.[0] as { sender_type: string; created_at: string } | undefined
    if (!msg || msg.sender_type === 'customer') continue
    if (new Date(msg.created_at) > cutoff) continue

    silentTagId ??= await ensureTag(db, accountId, userId, OUTCOME_TAGS.silent)
    await addContactTagAndDispatch({ db, accountId, contactId: deal.contact_id, tagId: silentTagId })
    const stageKey = stages.stageKeys.get(deal.stage_id)
    const stageName = AI_STAGES.find((s) => s.key === stageKey)?.name ?? 'unknown stage'
    const days = Math.round(afterHours / 24)
    await addNote(
      db,
      accountId,
      userId,
      deal.contact_id,
      `Went silent after: ${stageName} (no reply for ${days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${afterHours} hours`}).`,
    )
    marked++
  }
  return { checked: rows.length, marked }
}
