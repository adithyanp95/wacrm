import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { transcribeAudio, DEFAULT_MANGLISH_MALAYALAM_PROMPT } from './transcribe';

describe('transcribeAudio', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null if buffer is empty or apiKey is missing', async () => {
    const res1 = await transcribeAudio({
      buffer: Buffer.from([]),
      apiKey: 'test-key',
    });
    expect(res1).toBeNull();

    const res2 = await transcribeAudio({
      buffer: Buffer.from([1, 2, 3]),
      apiKey: '',
    });
    expect(res2).toBeNull();
  });

  it('posts to Whisper API with Malayalam/Manglish prompt and omits language ml to avoid 400 error', async () => {
    const mockResponse = { text: '  ഹലോ, എനിക്ക് ഒരു ചോദ്യമുണ്ട്  ' };
    let capturedBody: FormData | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options?.body as FormData;
      return {
        ok: true,
        json: async () => mockResponse,
      } as unknown as Response;
    });

    const result = await transcribeAudio({
      buffer: Buffer.from('fake-audio-bytes'),
      apiKey: 'sk-test',
      fileName: 'voice.ogg',
      mimeType: 'audio/ogg',
    });

    expect(result).toBe('ഹലോ, എനിക്ക് ഒരു ചോദ്യമുണ്ട്');
    expect(capturedBody).not.toBeNull();
    const formData = capturedBody as unknown as FormData;
    // 'ml' MUST NOT be sent in language parameter because OpenAI API gateway returns 400
    expect(formData.get('language')).toBeNull();
    expect(formData.get('prompt')).toBe(DEFAULT_MANGLISH_MALAYALAM_PROMPT);
    expect(formData.get('model')).toBe('whisper-1');
  });

  it('strips language if explicitly set to ml', async () => {
    let capturedBody: FormData | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options?.body as FormData;
      return {
        ok: true,
        json: async () => ({ text: 'ടെസ്റ്റ്' }),
      } as unknown as Response;
    });

    await transcribeAudio({
      buffer: Buffer.from('audio-bytes'),
      apiKey: 'sk-test',
      language: 'ml',
    });

    expect(capturedBody).not.toBeNull();
    const formData = capturedBody as unknown as FormData;
    expect(formData.get('language')).toBeNull();
  });

  it('appends language if set to another supported language code', async () => {
    let capturedBody: FormData | null = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options?.body as FormData;
      return {
        ok: true,
        json: async () => ({ text: 'hello' }),
      } as unknown as Response;
    });

    await transcribeAudio({
      buffer: Buffer.from('audio-bytes'),
      apiKey: 'sk-test',
      language: 'en',
    });

    expect(capturedBody).not.toBeNull();
    const formData = capturedBody as unknown as FormData;
    expect(formData.get('language')).toBe('en');
  });

  it('returns null on Whisper API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Invalid audio format',
    } as unknown as Response);

    const result = await transcribeAudio({
      buffer: Buffer.from('fake-audio-bytes'),
      apiKey: 'sk-test',
    });

    expect(result).toBeNull();
  });
});
