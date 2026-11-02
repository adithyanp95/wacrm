/**
 * Audio transcription service supporting:
 * 1. Google Gemini (gemini-2.0-flash) — Primary engine for Malayalam, Manglish, and regional languages.
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
}

export const DEFAULT_GEMINI_TRANSCRIPTION_PROMPT =
  'Listen carefully to this WhatsApp voice message and transcribe it verbatim.\n' +
  '- The speaker is speaking in Malayalam, Manglish (Malayalam mixed with English), or English.\n' +
  '- Transcribe Malayalam words in clear, grammatically correct Malayalam script (മലയാളം ലിപി).\n' +
  '- Retain common English business, marketing, or technical terms in English (e.g. Local SEO, Google Maps, package, pricing, audit, details, ranking).\n' +
  '- Do NOT summarize, explain, or reply to the audio. Output ONLY the exact transcribed text.';

export const DEFAULT_MANGLISH_MALAYALAM_PROMPT =
  'Malayalam and Manglish customer voice note (മലയാളം, Manglish). Topics: Local SEO, Google Maps 3-Pack, SEO packages, pricing, details, ethra maasam, business growth, client inquiry, സംഭാഷണം, പാക്കേജുകൾ, ഡിജിറ്റൽ മാർക്കറ്റിംഗ്, ഡീറ്റെയിൽസ്.';

export const DEFAULT_MALAYALAM_PROMPT = DEFAULT_MANGLISH_MALAYALAM_PROMPT;

/**
 * Transcribe audio using Google Gemini multimodal audio API (gemini-2.0-flash).
 * Excels at Indian languages, Malayalam script, and Manglish code-switching.
 */
export async function transcribeWithGemini(args: {
  buffer: Buffer | Uint8Array;
  mimeType?: string;
  apiKey: string;
  prompt?: string;
}): Promise<string | null> {
  const {
    buffer,
    mimeType = 'audio/ogg',
    apiKey,
    prompt = DEFAULT_GEMINI_TRANSCRIPTION_PROMPT,
  } = args;

  if (!buffer || buffer.byteLength === 0 || !apiKey) {
    return null;
  }

  try {
    const base64Data = Buffer.from(buffer).toString('base64');
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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
      console.warn('[gemini] audio transcription request failed:', res.status, errText);
      return null;
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
    return transcript;
  } catch (err) {
    console.warn(
      '[gemini] audio transcription error:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
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
  const { buffer, mimeType = 'audio/ogg', geminiApiKey, apiKey } = args;

  if (!buffer || buffer.byteLength === 0) {
    return null;
  }

  // 1. Prioritize Google Gemini (Gemini 2.0 Flash) for Malayalam / Manglish accuracy
  const activeGeminiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (activeGeminiKey) {
    const geminiTranscript = await transcribeWithGemini({
      buffer,
      mimeType,
      apiKey: activeGeminiKey,
      prompt: args.prompt || DEFAULT_GEMINI_TRANSCRIPTION_PROMPT,
    });

    if (geminiTranscript) {
      return geminiTranscript;
    }
    console.warn('[transcribe] Gemini transcription returned null, falling back to Whisper...');
  }

  // 2. Fall back to OpenAI Whisper
  if (apiKey) {
    return transcribeWithWhisper(args);
  }

  return null;
}
