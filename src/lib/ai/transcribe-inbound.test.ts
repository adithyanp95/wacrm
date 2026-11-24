import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./config', () => ({ loadAiConfig: vi.fn() }))
vi.mock('./transcribe', () => ({ transcribeAudio: vi.fn() }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))

import { pickWhisperKey, transcribeInboundAudio } from './transcribe-inbound'
import { loadAiConfig } from './config'
import { transcribeAudio } from './transcribe'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

const mockLoadAiConfig = vi.mocked(loadAiConfig)
const mockTranscribe = vi.mocked(transcribeAudio)
const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownload = vi.mocked(downloadMedia)

describe('pickWhisperKey', () => {
  it("uses the account's key when its provider is OpenAI", () => {
    expect(pickWhisperKey({ provider: 'openai', apiKey: 'sk-account' }, 'sk-env')).toBe(
      'sk-account',
    )
  })

  it('never sends an Anthropic key to OpenAI', () => {
    expect(pickWhisperKey({ provider: 'anthropic', apiKey: 'sk-ant-secret' }, undefined)).toBe(
      undefined,
    )
  })

  it('never sends an OpenAI-compatible (third-party) key to OpenAI', () => {
    expect(
      pickWhisperKey({ provider: 'openai_compatible', apiKey: 'gsk_groq' }, undefined),
    ).toBe(undefined)
  })

  it('falls back to the server OPENAI_API_KEY for non-OpenAI providers', () => {
    expect(pickWhisperKey({ provider: 'anthropic', apiKey: 'sk-ant' }, 'sk-env')).toBe('sk-env')
    expect(pickWhisperKey(null, ' sk-env ')).toBe('sk-env')
    expect(pickWhisperKey(null, '  ')).toBe(undefined)
  })
})

describe('transcribeInboundAudio', () => {
  const env = { ...process.env }
  const base = {
    db: {} as never,
    accountId: 'acct-1',
    mediaId: 'media-1',
    mimeType: 'audio/ogg',
    accessToken: 'meta-token',
  }

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.GEMINI_API_KEY = 'gemini-key'
    delete process.env.OPENAI_API_KEY
    mockLoadAiConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant' } as never)
    mockGetMediaUrl.mockResolvedValue({ url: 'https://meta/x', mimeType: 'audio/ogg', fileSize: 10 })
    mockDownload.mockResolvedValue({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it('returns the transcript and never hands the Anthropic key to Whisper', async () => {
    mockTranscribe.mockResolvedValue('hello')
    await expect(transcribeInboundAudio(base)).resolves.toBe('hello')
    const call = mockTranscribe.mock.calls[0][0]
    expect(call.apiKey).toBeUndefined()
    expect(call.geminiApiKey).toBe('gemini-key')
    expect(typeof call.deadlineAt).toBe('number')
  })

  it('skips the download entirely when no transcription key exists', async () => {
    delete process.env.GEMINI_API_KEY
    await expect(transcribeInboundAudio(base)).resolves.toBeNull()
    expect(mockGetMediaUrl).not.toHaveBeenCalled()
  })

  it('gives up with null when the work outlives the budget', async () => {
    mockGetMediaUrl.mockReturnValue(new Promise(() => {})) // hangs forever
    await expect(transcribeInboundAudio({ ...base, budgetMs: 20 })).resolves.toBeNull()
  })

  it('swallows failures and returns null', async () => {
    mockDownload.mockRejectedValue(new Error('boom'))
    await expect(transcribeInboundAudio(base)).resolves.toBeNull()
  })
})
