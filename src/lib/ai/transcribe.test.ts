import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  transcribeAudio,
  transcribeWithGemini,
  transcribeWithWhisper,
  DEFAULT_GEMINI_TRANSCRIPTION_PROMPT,
  DEFAULT_MANGLISH_MALAYALAM_PROMPT,
} from './transcribe';

describe('transcribeAudio & providers', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.GEMINI_API_KEY = originalEnv;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('returns null if buffer is empty or both api keys are missing', async () => {
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

  describe('transcribeWithGemini', () => {
    it('sends base64 audio and prompt to Gemini 2.0 Flash and returns trimmed text', async () => {
      let capturedUrl = '';
      let capturedBody: any = null;

      globalThis.fetch = vi.fn().mockImplementation(async (url, options) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(options?.body as string);
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: '  നിങ്ങളുടെ പ്ലാൻ ഡീറ്റെയിൽസ് ഒന്നു പറയാമോ?  ' }],
                },
              },
            ],
          }),
        } as unknown as Response;
      });

      const audioBuffer = Buffer.from('fake-ogg-bytes');
      const result = await transcribeWithGemini({
        buffer: audioBuffer,
        apiKey: 'gemini-secret-key',
        mimeType: 'audio/ogg',
      });

      expect(result).toBe('നിങ്ങളുടെ പ്ലാൻ ഡീറ്റെയിൽസ് ഒന്നു പറയാമോ?');
      expect(capturedUrl).toContain('gemini-2.5-flash');
      expect(capturedUrl).toContain('key=gemini-secret-key');
      expect(capturedBody.contents[0].parts[0].inlineData.mimeType).toBe('audio/ogg');
      expect(capturedBody.contents[0].parts[0].inlineData.data).toBe(
        audioBuffer.toString('base64'),
      );
      expect(capturedBody.contents[0].parts[1].text).toBe(DEFAULT_GEMINI_TRANSCRIPTION_PROMPT);
    });

    it('returns null on Gemini API error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'API key invalid',
      } as unknown as Response);

      const result = await transcribeWithGemini({
        buffer: Buffer.from('audio-bytes'),
        apiKey: 'invalid-key',
      });

      expect(result).toBeNull();
    });
  });

  describe('transcribeAudio routing & fallback', () => {
    it('prioritizes Gemini when geminiApiKey is provided', async () => {
      const geminiSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'മലയാളം ചോദ്യം' }],
              },
            },
          ],
        }),
      });

      globalThis.fetch = geminiSpy;

      const result = await transcribeAudio({
        buffer: Buffer.from('voice-bytes'),
        apiKey: 'openai-key',
        geminiApiKey: 'gemini-key',
      });

      expect(result).toBe('മലയാളം ചോദ്യം');
      expect(geminiSpy).toHaveBeenCalledTimes(1);
      const calledUrl = geminiSpy.mock.calls[0][0];
      expect(calledUrl).toContain('generativelanguage.googleapis.com');
    });

    it('falls back to Whisper when Gemini fails', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url) => {
        callCount++;
        if (String(url).includes('generativelanguage')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'Server error',
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ text: 'Whisper fallback transcript' }),
        } as unknown as Response;
      });

      const result = await transcribeAudio({
        buffer: Buffer.from('voice-bytes'),
        apiKey: 'openai-key',
        geminiApiKey: 'gemini-key',
      });

      expect(result).toBe('Whisper fallback transcript');
      expect(callCount).toBe(2);
    });
  });

  describe('transcribeWithWhisper', () => {
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

      const result = await transcribeWithWhisper({
        buffer: Buffer.from('fake-audio-bytes'),
        apiKey: 'sk-test',
        fileName: 'voice.ogg',
        mimeType: 'audio/ogg',
      });

      expect(result).toBe('ഹലോ, എനിക്ക് ഒരു ചോദ്യമുണ്ട്');
      expect(capturedBody).not.toBeNull();
      const formData = capturedBody as unknown as FormData;
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

      await transcribeWithWhisper({
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

      await transcribeWithWhisper({
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

      const result = await transcribeWithWhisper({
        buffer: Buffer.from('fake-audio-bytes'),
        apiKey: 'sk-test',
      });

      expect(result).toBeNull();
    });
  });
});
