/**
 * Voice answer recorder: getUserMedia + MediaRecorder, 30 s cap, explicit stop.
 * No microphone (or permission denied) → a silent demo clip so the path still works; the UI says so.
 */
export interface Recording {
  blob: Blob;
  fromMicrophone: boolean;
}

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveStop: ((r: Recording) => void) | null = null;
  private fallback = false;
  /** Stop pressed while the permission prompt was still open. */
  private pendingStart = false;

  get recording() {
    return this.recorder?.state === 'recording' || this.fallback;
  }

  async start(maxSec = 30, onAutoStop?: () => void): Promise<{ microphone: boolean }> {
    this.chunks = [];
    this.pendingStart = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('no media api');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.pendingStart) {
        // stopped before permission was granted: drop the stream, nothing was recorded
        stream.getTracks().forEach((t) => t.stop());
        return { microphone: true };
      }
      this.recorder = new MediaRecorder(stream);
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' });
        this.resolveStop?.({ blob, fromMicrophone: true });
        this.recorder = null;
      };
      this.recorder.start();
      this.fallback = false;
    } catch {
      this.fallback = this.pendingStart;
    }
    this.pendingStart = false;
    this.timer = setTimeout(() => {
      onAutoStop?.();
    }, maxSec * 1000);
    return { microphone: !this.fallback };
  }

  stop(): Promise<Recording> {
    if (this.timer) clearTimeout(this.timer);
    if (this.fallback || !this.recorder) {
      this.fallback = false;
      this.pendingStart = false;
      return Promise.resolve({ blob: new Blob([new Uint8Array(24000)], { type: 'audio/webm' }), fromMicrophone: false });
    }
    return new Promise((resolve) => {
      this.resolveStop = resolve;
      this.recorder!.stop();
    });
  }
}
