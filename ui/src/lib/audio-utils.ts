/**
 * Audio helpers shared between voice mode and the streaming-STT plumbing.
 *
 * ``encodePcm16Wav`` writes a Float32Array (the format Silero VAD callbacks
 * deliver) as a 16-bit PCM WAV Blob so the existing ``/voice/transcribe``
 * endpoint can consume it without changes.
 */

const WAV_HEADER_SIZE = 44;
const PCM16_BYTES = 2;

/**
 * Encode mono Float32 PCM samples to a 16-bit PCM WAV Blob.
 *
 * @param samples  Mono PCM samples in the range ``[-1, 1]``.
 * @param sampleRate  Sample rate in Hz (Silero VAD emits 16 000 Hz).
 */
export function encodePcm16Wav(samples: Float32Array, sampleRate = 16_000): Blob {
  const dataSize = samples.length * PCM16_BYTES;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);

  // RIFF header.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // fmt chunk (16-byte PCM descriptor).
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * PCM16_BYTES, true); // byte rate
  view.setUint16(32, PCM16_BYTES, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Float32 -> Int16 (clipping at the rails).
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_SIZE + i * PCM16_BYTES, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
