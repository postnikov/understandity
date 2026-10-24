/**
 * Voice answer recorder: getUserMedia + MediaRecorder, hard cap from the lesson (60 s), explicit stop.
 * A level meter feeds the «listening» state, and the peak level tells silence apart from a real answer
 * before anything is sent: silence is «no answer received», never «did not understand».
 * No microphone (or permission denied) → a silent demo clip so the path still works; the UI says so.
 */
export interface Recording {
  blob: Blob;
  fromMicrophone: boolean;
  durationSec: number;
  /** 0..1 peak RMS during the take; null when there was no microphone or no working meter. */
  peak: number | null;
}

export type MicProblem = 'unsupported' | 'denied' | 'no_device' | null;

/** Below this peak RMS the take is treated as silence (tuned on the built-in MacBook mic). */
export const SILENCE_PEAK = 0.02;

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveStop: ((r: Recording) => void) | null = null;
  private fallback = false;
  private pendingStart = false;
  private startedAt = 0;
  private peakLevel = 0;
  /** Meter samples actually read from a running AudioContext; the silence gate trusts the peak only then. */
  private samples = 0;
  problem: MicProblem = null;

  get recording() {
    return this.recorder?.state === 'recording' || this.fallback;
  }

  /** Current RMS level 0..1 (call from requestAnimationFrame). */
  level(): number {
    if (!this.analyser || this.ctx?.state !== 'running') return 0;
    this.samples++;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    if (rms > this.peakLevel) this.peakLevel = rms;
    return rms;
  }

  async start(maxSec = 60, onAutoStop?: () => void): Promise<{ microphone: boolean; problem: MicProblem }> {
    this.chunks = [];
    this.pendingStart = true;
    this.peakLevel = 0;
    this.samples = 0;
    this.problem = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        this.problem = 'unsupported';
        throw new Error('no media api');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!this.pendingStart) {
        stream.getTracks().forEach((t) => t.stop());
        return { microphone: true, problem: null };
      }
      this.stream = stream;
      this.recorder = new MediaRecorder(stream);
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' });
        const durationSec = (performance.now() - this.startedAt) / 1000;
        const peak = this.samples > 10 ? this.peakLevel : null;
        this.release();
        this.resolveStop?.({ blob, fromMicrophone: true, durationSec, peak });
      };
      try {
        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.ctx.createMediaStreamSource(stream).connect(this.analyser);
        void this.ctx.resume().catch(() => undefined);
      } catch {
        this.analyser = null; // meter is cosmetic; recording still works
      }
      this.recorder.start(250);
      this.fallback = false;
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (!this.problem) this.problem = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'no_device';
      this.fallback = this.pendingStart;
    }
    this.pendingStart = false;
    this.startedAt = performance.now();
    this.timer = setTimeout(() => onAutoStop?.(), maxSec * 1000);
    return { microphone: !this.fallback, problem: this.problem };
  }

  stop(): Promise<Recording> {
    if (this.timer) clearTimeout(this.timer);
    const durationSec = (performance.now() - this.startedAt) / 1000;
    if (this.fallback || !this.recorder) {
      this.fallback = false;
      this.pendingStart = false;
      // Silent demo clip: non-empty so the fake STT answers; a real STT will say «no answer».
      return Promise.resolve({ blob: new Blob([new Uint8Array(24000)], { type: 'audio/webm' }), fromMicrophone: false, durationSec, peak: null });
    }
    return new Promise((resolve) => {
      this.resolveStop = resolve;
      this.recorder!.stop();
    });
  }

  /** Abort without producing a recording (leaving the card, switching step). */
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.resolveStop = null;
    this.fallback = false;
    this.pendingStart = false;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = () => this.release();
      this.recorder.stop();
    } else this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
    this.recorder = null;
  }
}
