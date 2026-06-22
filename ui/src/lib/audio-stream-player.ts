/**
 * Streaming audio player for ``audio_delta`` packets.
 *
 * Queues decoded ``AudioBuffer``s on a single ``AudioContext`` so chunks
 * play back-to-back without gaps even when network jitter delays a packet.
 * The next chunk is scheduled at ``max(now, lastBufferEndTime)`` — when
 * a chunk arrives before its predecessor finishes the queue stays tight;
 * when it arrives late we wait for the AudioContext clock to catch up
 * rather than drop the chunk.
 */

export interface AudioStreamPlayerOptions {
  /** Hint for the AudioContext sample rate. Defaults to the device-native rate. */
  sampleRate?: number;
  /** Called when the queue empties after the last enqueued chunk finishes. */
  onAllChunksPlayed?: () => void;
  /** Called when ``decodeAudioData`` rejects a chunk (rare, but logs help debug). */
  onDecodeError?: (error: Error) => void;
}

export class AudioStreamPlayer {
  private context: AudioContext | null = null;
  /** Time (seconds, in the AudioContext clock) when the last queued chunk ends. */
  private nextStartAt = 0;
  /** Active source nodes — kept so ``stop()`` can cancel pending playback. */
  private activeSources = new Set<AudioBufferSourceNode>();
  /** Sequential chunk count that has finished playing. */
  private playedCount = 0;
  /** Sequential chunk count we expect to enqueue total (set by ``markStreamEnd``). */
  private expectedCount: number | null = null;

  constructor(private readonly options: AudioStreamPlayerOptions = {}) {}

  /** Lazily create the AudioContext on first chunk. Browsers require a user
   *  gesture to start audio, so callers should construct from a click handler. */
  private getContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not available in this browser');
    this.context = new Ctor(
      this.options.sampleRate ? { sampleRate: this.options.sampleRate } : undefined,
    );
    this.nextStartAt = this.context.currentTime;
    return this.context;
  }

  /**
   * Enqueue one chunk. ``mimeType`` is forwarded to ``decodeAudioData`` only
   * indirectly — the browser sniffs the bytes regardless, but logging the
   * MIME helps when a provider returns an unexpected codec.
   */
  async enqueue(audio: ArrayBuffer, _mimeType: string = 'audio/mpeg'): Promise<void> {
    const ctx = this.getContext();
    let buffer: AudioBuffer;
    try {
      // ``decodeAudioData`` mutates the input ArrayBuffer in some browsers,
      // so always pass a copy.
      buffer = await ctx.decodeAudioData(audio.slice(0));
    } catch (e) {
      this.options.onDecodeError?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, this.nextStartAt);
    this.nextStartAt = startAt + buffer.duration;
    this.activeSources.add(source);

    source.onended = () => {
      this.activeSources.delete(source);
      this.playedCount += 1;
      if (
        this.expectedCount !== null
        && this.playedCount >= this.expectedCount
        && this.activeSources.size === 0
      ) {
        this.options.onAllChunksPlayed?.();
      }
    };

    source.start(startAt);
  }

  /** Stop everything currently scheduled. Used on barge-in (M5). */
  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // already stopped — ignore.
      }
    }
    this.activeSources.clear();
    if (this.context) {
      this.nextStartAt = this.context.currentTime;
    }
    this.playedCount = 0;
    this.expectedCount = null;
  }

  /** Tell the player how many chunks total to expect; once that many have
   *  finished the queue drains and ``onAllChunksPlayed`` fires. */
  markStreamEnd(totalChunks: number): void {
    this.expectedCount = totalChunks;
    if (this.playedCount >= totalChunks && this.activeSources.size === 0) {
      this.options.onAllChunksPlayed?.();
    }
  }

  /** Release the AudioContext. After ``close`` the player is unusable. */
  async close(): Promise<void> {
    this.stop();
    if (this.context && this.context.state !== 'closed') {
      await this.context.close();
    }
    this.context = null;
  }
}

/** Decode a base64-encoded audio chunk to an ``ArrayBuffer`` ready for ``enqueue``. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
