import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import type { AiConfig } from './types'
import { transcribeAudio } from './transcribe'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

/** Total time an inbound voice note may spend on download + transcription.
 *  The webhook's `after()` block shares a 60 s budget with every other
 *  message in the batch, so this must stay well under it. */
export const INBOUND_TRANSCRIBE_BUDGET_MS = 25_000

/**
 * The key to send to OpenAI's Whisper endpoint, or undefined.
 *
 * Only a key that belongs to OpenAI may go to api.openai.com: the
 * account's own key when its provider is `openai`, otherwise the
 * server-level `OPENAI_API_KEY`. An Anthropic or OpenAI-compatible key
 * (Groq, OpenRouter, …) is never sent there — that would hand a
 * credential to a third party.
 */
export function pickWhisperKey(
  aiConfig: Pick<AiConfig, 'provider' | 'apiKey'> | null,
  envOpenAiKey: string | undefined,
): string | undefined {
  const envKey = envOpenAiKey?.trim() || undefined
  if (aiConfig?.provider === 'openai' && aiConfig.apiKey) return aiConfig.apiKey
  return envKey
}

/**
 * Download an inbound WhatsApp voice note and transcribe it, within a
 * fixed time budget. Never throws; returns null on any failure, on
 * timeout, or when no transcription key is configured.
 */
export async function transcribeInboundAudio(args: {
  db: SupabaseClient
  accountId: string
  mediaId: string
  mimeType: string
  accessToken: string
  budgetMs?: number
}): Promise<string | null> {
  const { db, accountId, mediaId, mimeType, accessToken } = args
  const budgetMs = args.budgetMs ?? INBOUND_TRANSCRIBE_BUDGET_MS
  const deadlineAt = Date.now() + budgetMs

  const work = async (): Promise<string | null> => {
    const geminiKey = process.env.GEMINI_API_KEY?.trim() || undefined
    let aiConfig: AiConfig | null = null
    try {
      aiConfig = await loadAiConfig(db, accountId, { requireActive: false })
    } catch (err) {
      console.warn('[transcribe-inbound] could not load AI config:', err)
    }
    const whisperKey = pickWhisperKey(aiConfig, process.env.OPENAI_API_KEY)
    if (!geminiKey && !whisperKey) return null

    const info = await getMediaUrl({ mediaId, accessToken })
    const { buffer } = await downloadMedia({ downloadUrl: info.url, accessToken })
    return transcribeAudio({
      buffer,
      fileName: 'audio.ogg',
      mimeType,
      apiKey: whisperKey,
      geminiApiKey: geminiKey,
      deadlineAt,
    })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[transcribe-inbound] gave up on media ${mediaId} after ${budgetMs} ms`,
      )
      resolve(null)
    }, budgetMs)
  })

  try {
    // The race also bounds the Meta media download, which has no timeout
    // of its own. Provider calls abort themselves at `deadlineAt`.
    return await Promise.race([work(), timeout])
  } catch (err) {
    console.warn('[transcribe-inbound] transcription failed:', err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
