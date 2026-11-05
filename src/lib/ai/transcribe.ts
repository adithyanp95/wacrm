/**
 * Audio transcription service supporting:
 * 1. Google Gemini (gemini-2.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview) — Primary engine for Malayalam, Manglish, and regional languages.
 *    Multimodal native audio understanding with state-of-the-art vocabulary and dialect accuracy.
 * 2. OpenAI Whisper (whisper-1) — Fallback engine with prompt-conditioned Malayalam/Manglish support.
 */

export interface TranscribeAudioArgs {
  buffer: Buffer | Uint8Array;
  fileName?: string;
  mimeType?: string;
  apiKey?: string; // OpenAI key (fallback)
  geminiApiKey?: string; // Google Gemini key (primary)
  language?: string;
  prompt?: string;
  retryDelayMs?: number;
}

export const GEMINI_TRANSCRIPTION_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
];

export const DEFAULT_GEMINI_TRANSCRIPTION_PROMPT =
  'Listen carefully to this WhatsApp voice message and transcribe it verbatim.\n' +
  '- The speaker is speaking in Malayalam, Manglish (Malayalam mixed with English), or English.\n' +
  '- Transcribe Malayalam words in clear, grammatically correct Malayalam script (മലയാളം ലിപി).\n' +
  '- Retain common English marketing, advertising, and business terms in English (e.g. Meta Ads, Facebook & Instagram Ads, posters, creative, leads, campaigns, Diwali offer, 50% discount, ₹1,500/month, agency management fee, packages, budget, details).\n' +
  '- Do NOT summarize, explain, translate, or reply to the audio. Output ONLY the exact transcribed text.';

export const DEFAULT_MANGLISH_MALAYALAM_PROMPT =
  'Malayalam and Manglish customer voice note (മലയാളം, Manglish). Topics: Meta Ads, Facebook Ads, Instagram Ads, campaigns, posters, creatives, Diwali offer, 50% discount, ₹1,500/month, package pricing, leads, business inquiries, details, ethra maasam, സംഭാഷണം, ഓഫർ, പരസ്യം, ഡീറ്റെയിൽസ്.';

export const DEFAULT_MALAYALAM_PROMPT = DEFAULT_MANGLISH_MALAYALAM_PROMPT;

/**
 * Call a single Gemini model to transcribe audio.
 * Supports transient error retries (429, 5xx, network error).
 * Returns { transcript } on success, or { fatalAuthError: true } if API key is rejected (401/403).
 */
async function callGeminiModel(opts: {
  model: string;
  base64Data: string;
  mimeType: string;
  apiKey: string;
  prompt: string;
  retryDelayMs: number;
}): Promise<{ transcript: string | null; fatalAuthError?: boolean }> {
  const { model, base64Data, mimeType, apiKey, prompt, retryDelayMs } = opts;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Data,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(
          `[gemini] model ${model} (attempt ${attempt}/2) failed with HTTP ${res.status}:`,
          errText,
        );

        if (res.status === 401 || res.status === 403) {
          // Authentication error; retrying other models with this key will also fail
          return { transcript: null, fatalAuthError: true };
        }

        const isTransient = res.status === 429 || res.status >= 500;
        if (!isTransient || attempt === 2) {
          break;
        }

        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        continue;
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const transcript =
        data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
      if (transcript) {
        return { transcript };
      }
    } catch (err) {
      console.warn(
        `[gemini] model ${model} (attempt ${attempt}/2) network error:`,
        err instanceof Error ? err.message : err,
      );
      if (attempt === 1 && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return { transcript: null };
}

/**
 * Transcribe audio using Google Gemini multimodal audio API.
 * Uses primary model gemini-2.5-flash with automatic retry on transient errors
 * and secondary fallbacks (gemini-3.1-flash-lite, gemini-3-flash-preview).
 * Excels at Indian languages, Malayalam script, and Manglish code-switching.
 */
export async function transcribeWithGemini(args: {
  buffer: Buffer | Uint8Array;
  mimeType?: string;
  apiKey: string;
  prompt?: string;
  models?: string[];
  retryDelayMs?: number;
}): Promise<string | null> {
  const {
    buffer,
    mimeType = 'audio/ogg',
    apiKey,
    prompt = DEFAULT_GEMINI_TRANSCRIPTION_PROMPT,
    models = GEMINI_TRANSCRIPTION_MODELS,
    retryDelayMs = process.env.NODE_ENV === 'test' ? 0 : 400,
  } = args;

  if (!buffer || buffer.byteLength === 0 || !apiKey) {
    return null;
  }

  const base64Data = Buffer.from(buffer).toString('base64');

  for (const model of models) {
    const { transcript, fatalAuthError } = await callGeminiModel({
      model,
      base64Data,
      mimeType,
      apiKey,
      prompt,
      retryDelayMs,
    });

    if (transcript) {
      return transcript;
    }

    if (fatalAuthError) {
      console.warn('[gemini] Authentication failed; aborting Gemini model cascade.');
      break;
    }
  }

  return null;
}

/**
 * Transcribe audio using OpenAI Whisper (whisper-1).
 */
export async function transcribeWithWhisper(
  args: TranscribeAudioArgs,
): Promise<string | null> {
  const {
    buffer,
    fileName = 'audio.ogg',
    mimeType = 'audio/ogg',
    apiKey,
    language,
    prompt = DEFAULT_MANGLISH_MALAYALAM_PROMPT,
  } = args;

  if (!buffer || buffer.byteLength === 0 || !apiKey) {
    return null;
  }

  try {
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-1');

    // Do NOT pass 'ml' to OpenAI Whisper API — OpenAI's API gateway rejects 'ml' with 400 unsupported_language.
    // Whisper's neural network handles Malayalam and Manglish via the priming prompt.
    if (language && language !== 'ml') {
      formData.append('language', language);
    }
    if (prompt) {
      formData.append('prompt', prompt);
    }

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('[whisper] transcription request failed:', res.status, errText);
      return null;
    }

    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    console.warn(
      '[whisper] transcription error:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Unified audio transcription entry point.
 * Prioritizes Google Gemini for superior Malayalam/Manglish accuracy,
 * and gracefully falls back to OpenAI Whisper if Gemini is unconfigured or unavailable.
 */
export async function transcribeAudio(
  args: TranscribeAudioArgs,
): Promise<string | null> {
  const { buffer, mimeType = 'audio/ogg', geminiApiKey, apiKey, retryDelayMs } = args;

  if (!buffer || buffer.byteLength === 0) {
    return null;
  }

  // 1. Prioritize Google Gemini (primary: gemini-2.5-flash with resilient model cascade)
  const activeGeminiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (activeGeminiKey) {
    const geminiTranscript = await transcribeWithGemini({
      buffer,
      mimeType,
      apiKey: activeGeminiKey,
      prompt: args.prompt || DEFAULT_GEMINI_TRANSCRIPTION_PROMPT,
      retryDelayMs,
    });

    if (geminiTranscript) {
      return geminiTranscript;
    }
    console.warn(
      '[transcribe] Gemini transcription failed across all attempted models.',
    );
  }

  // 2. Fall back to OpenAI Whisper if configured
  if (apiKey) {
    console.warn(
      '[transcribe] Falling back to OpenAI Whisper. Note: Malayalam transcription accuracy may be degraded.',
    );
    return transcribeWithWhisper(args);
  }

  return null;
}
