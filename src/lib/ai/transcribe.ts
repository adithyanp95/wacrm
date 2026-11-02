/**
 * Audio transcription service using OpenAI Whisper (whisper-1).
 * Optimized with Malayalam and Manglish vocabulary biasing and prompt conditioning
 * to eliminate Dravidian language confusion (e.g. Tamil drift) and accurately transcribe
 * technical English/marketing terms in local script and Manglish.
 *
 * NOTE: OpenAI's API gateway rejects `language: 'ml'` with a 400 unsupported_language error.
 * Whisper accurately transcribes Malayalam and Manglish when language is omitted and primed via `prompt`.
 */
export interface TranscribeAudioArgs {
  buffer: Buffer | Uint8Array;
  fileName?: string;
  mimeType?: string;
  apiKey: string;
  language?: string;
  prompt?: string;
}

export const DEFAULT_MANGLISH_MALAYALAM_PROMPT =
  'Malayalam and Manglish customer voice note (മലയാളം, Manglish). Topics: Local SEO, Google Maps 3-Pack, SEO packages, pricing, details, ethra maasam, business growth, client inquiry, സംഭാഷണം, പാക്കേജുകൾ, ഡിജിറ്റൽ മാർക്കറ്റിംഗ്, ഡീറ്റെയിൽസ്.';

export const DEFAULT_MALAYALAM_PROMPT = DEFAULT_MANGLISH_MALAYALAM_PROMPT;

export async function transcribeAudio(
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
    console.warn('[whisper] transcription error:', err instanceof Error ? err.message : err);
    return null;
  }
}
