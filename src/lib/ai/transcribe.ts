/**
 * Audio transcription service using OpenAI Whisper (whisper-1).
 * Supports automatic language detection for Malayalam, English, Manglish, and 90+ languages.
 */
export interface TranscribeAudioArgs {
  buffer: Buffer | Uint8Array;
  fileName?: string;
  mimeType?: string;
  apiKey: string;
  language?: string;
}

export async function transcribeAudio(
  args: TranscribeAudioArgs,
): Promise<string | null> {
  const { buffer, fileName = 'audio.ogg', mimeType = 'audio/ogg', apiKey, language } = args;

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
