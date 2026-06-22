/**
 * Hook for audio recording with live STT transcription.
 *
 * Handles microphone capture, 16kHz downsampling, WAV encoding,
 * RMS-based silence detection, and live session management.
 */

import { useCallback, useRef, useState } from 'react';
import {
  finishLiveSession,
  sendAudioChunk,
  startLiveSession,
  type LiveSessionState,
} from '@/lib/api-stt';

// Audio recording constants
const CAPTURE_SAMPLE_RATE = 16000;
const TIMESLICE_MS = 3000; // Send cumulative audio every 3 seconds
const MAX_BUFFER_SECONDS = 30;
const SILENCE_RMS_THRESHOLD = 0.015;
const RECENT_RMS_SAMPLES = CAPTURE_SAMPLE_RATE; // Last 1s for silence detection

export type RecordingState = 'idle' | 'recording' | 'transcribing' | 'error';

interface UseAudioRecordingReturn {
  /** Current recording state */
  recordingState: RecordingState;
  /** Current transcript (committed + mutable) */
  transcriptText: string;
  /** Committed (stable) portion of the transcript */
  committedText: string;
  /** Mutable (hypothesis) portion */
  mutableText: string;
  /** Error message if any */
  error: string | null;
  /** Whether the browser supports audio recording */
  isSupported: boolean;
  /** Start recording and live transcription */
  startRecording: (language?: string) => Promise<void>;
  /** Stop recording and finalize transcript */
  stopRecording: () => Promise<string>;
  /** Cancel recording without finalizing */
  cancelRecording: () => void;
}

/**
 * Encode Float32 PCM samples as WAV (16-bit, mono, 16kHz).
 */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Convert float32 to int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Downsample audio from source sample rate to target sample rate.
 */
function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.round(i * ratio);
    result[i] = buffer[Math.min(srcIndex, buffer.length - 1)];
  }
  return result;
}

/**
 * Calculate RMS (Root Mean Square) of audio samples for silence detection.
 */
function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

/**
 * Check if the browser supports audio recording.
 */
function checkSupport(): boolean {
  return !!(
    navigator.mediaDevices?.getUserMedia &&
    window.AudioContext &&
    window.isSecureContext
  );
}

export function useAudioRecording(): UseAudioRecordingReturn {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [transcriptText, setTranscriptText] = useState('');
  const [committedText, setCommittedText] = useState('');
  const [mutableText, setMutableText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const chunkIndexRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // TODO: migrate to AudioWorkletNode — ScriptProcessorNode is deprecated
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const samplesBufferRef = useRef<Float32Array[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isCancelledRef = useRef(false);

  const isSupported = checkSupport();

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    samplesBufferRef.current = [];
  }, []);

  const startRecording = useCallback(
    async (language?: string) => {
      if (recordingState !== 'idle') return;

      setError(null);
      setTranscriptText('');
      setCommittedText('');
      setMutableText('');
      isCancelledRef.current = false;
      chunkIndexRef.current = 0;

      try {
        // Request microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: { ideal: CAPTURE_SAMPLE_RATE },
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        streamRef.current = stream;

        // Start live session on backend
        const session = await startLiveSession(language);
        sessionIdRef.current = session.session_id;

        // Set up audio processing
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        const maxSamples = CAPTURE_SAMPLE_RATE * MAX_BUFFER_SECONDS;

        processor.onaudioprocess = (event) => {
          if (isCancelledRef.current) return;
          const inputData = event.inputBuffer.getChannelData(0);
          const downsampled = downsample(
            inputData,
            audioContext.sampleRate,
            CAPTURE_SAMPLE_RATE
          );
          samplesBufferRef.current.push(new Float32Array(downsampled));

          // Trim to max buffer size
          let totalSamples = samplesBufferRef.current.reduce((s, b) => s + b.length, 0);
          while (totalSamples > maxSamples && samplesBufferRef.current.length > 1) {
            const removed = samplesBufferRef.current.shift();
            if (removed) totalSamples -= removed.length;
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        setRecordingState('recording');

        // Send cumulative audio periodically
        // Whisper needs several seconds of context — we send the FULL recording
        // each time and let the backend's live_stt_session handle deduplication
        intervalRef.current = setInterval(async () => {
          if (
            isCancelledRef.current ||
            !sessionIdRef.current ||
            samplesBufferRef.current.length === 0
          ) {
            return;
          }

          // Build cumulative audio from ALL buffered samples (don't clear!)
          const allSamples = samplesBufferRef.current;
          const totalLength = allSamples.reduce((s, b) => s + b.length, 0);
          const combined = new Float32Array(totalLength);
          let offset = 0;
          for (const buf of allSamples) {
            combined.set(buf, offset);
            offset += buf.length;
          }

          // Detect silence from the most recent audio only
          const recentStart = Math.max(0, combined.length - RECENT_RMS_SAMPLES);
          const recentSamples = combined.subarray(recentStart);
          const rms = calculateRms(recentSamples);
          const isSilence = rms < SILENCE_RMS_THRESHOLD;

          // Encode full cumulative audio and send
          const wavBlob = encodeWav(combined, CAPTURE_SAMPLE_RATE);
          const currentIndex = chunkIndexRef.current++;

          try {
            const state: LiveSessionState = await sendAudioChunk(
              sessionIdRef.current,
              currentIndex,
              wavBlob,
              isSilence
            );

            if (!isCancelledRef.current) {
              setCommittedText(state.committed_text);
              setMutableText(state.mutable_text);
              setTranscriptText(state.transcript_text);
            }
          } catch (err) {
            console.error('STT chunk error:', err);
          }
        }, TIMESLICE_MS);
      } catch (err) {
        cleanup();
        const message =
          err instanceof DOMException
            ? getDomExceptionMessage(err)
            : err instanceof Error
              ? err.message
              : 'Failed to start recording';
        setError(message);
        setRecordingState('error');
      }
    },
    [recordingState, cleanup]
  );

  const stopRecording = useCallback(async (): Promise<string> => {
    if (!sessionIdRef.current) {
      cleanup();
      setRecordingState('idle');
      return '';
    }

    setRecordingState('transcribing');
    cleanup();

    try {
      const result = await finishLiveSession(sessionIdRef.current);
      sessionIdRef.current = null;

      const finalText = result.text;
      setTranscriptText(finalText);
      setCommittedText(finalText);
      setMutableText('');
      setRecordingState('idle');
      return finalText;
    } catch (err) {
      console.error('STT finish error:', err);
      setError(err instanceof Error ? err.message : 'Failed to finalize transcript');
      setRecordingState('error');
      sessionIdRef.current = null;
      return transcriptText;
    }
  }, [cleanup, transcriptText]);

  const cancelRecording = useCallback(() => {
    isCancelledRef.current = true;
    cleanup();
    sessionIdRef.current = null;
    setRecordingState('idle');
    setTranscriptText('');
    setCommittedText('');
    setMutableText('');
    setError(null);
  }, [cleanup]);

  return {
    recordingState,
    transcriptText,
    committedText,
    mutableText,
    error,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}

function getDomExceptionMessage(err: DOMException): string {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Microphone access denied. Please allow microphone permissions.';
    case 'NotFoundError':
      return 'No microphone detected.';
    case 'NotReadableError':
      return 'Microphone is in use by another application.';
    case 'AbortError':
      return 'Microphone permission request was interrupted.';
    default:
      return `Microphone error: ${err.message}`;
  }
}
