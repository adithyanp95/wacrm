/**
 * Audio transcription service using OpenAI Whisper (whisper-1).
 * Optimized with explicit language targeting ('ml' for Malayalam) and vocabulary biasing
 * to eliminate Dravidian language confusion (e.g. Tamil drift) and accurately transcribe
 * technical English/marketing terms in local script.
 */
export interface TranscribeAudioArgs {
  buffer: Buffer | Uint8Array;
  fileName?: string;
  mimeType?: string;
  apiKey: string;
  language?: string;
  prompt?: string;
}

export const DEFAULT_MALAYALAM_PROMPT =
  'മലയാളം സംഭാഷണം, Local SEO, Google Maps, പാക്കേജുകൾ, ക്ലയന്റ് ഇൻക്വയറി, ബിസിനസ്, ഡിജിറ്റൽ മാർക്കറ്റിംഗ്, ഡീറ്റെയിൽസ്, ഗ്രോത്ത്.';

export async function transcribeAudio(
  args: TranscribeAudioArgs,
): Promise<string | null> {
  const {
    buffer,
    fileName = 'audio.ogg',
    mimeType = 'audio/ogg',
    apiKey,
    language = 'ml',
    prompt = DEFAULT_MALAYALAM_PROMPT,
  } = args;

  if (!buffer || buffer.byteLength === 0 || !apiKey) {
    return null;
  }

  try {
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-1');
    if (language) {
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
