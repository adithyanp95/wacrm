import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { transcribeAudio, DEFAULT_MALAYALAM_PROMPT } from './transcribe';

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

  it('posts to Whisper API with language ml and prompt and returns trimmed transcript', async () => {
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
    expect(formData.get('language')).toBe('ml');
    expect(formData.get('prompt')).toBe(DEFAULT_MALAYALAM_PROMPT);
    expect(formData.get('model')).toBe('whisper-1');
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
