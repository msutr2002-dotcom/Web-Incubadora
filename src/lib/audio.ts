export type AlarmLevel = 'critical' | 'warning' | 'none';

const LEVELS: Record<Exclude<AlarmLevel, 'none'>, { freq: number; beeps: number; gap: number; repeat: number }> = {
  critical: { freq: 1180, beeps: 3, gap: 0.16, repeat: 2200 },
  warning: { freq: 780, beeps: 2, gap: 0.22, repeat: 4200 },
};

export class AlarmSound {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private level: AlarmLevel = 'none';
  private muted = false;
  private volume = 0.5;

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    if (muted) {
      this.stopTimer();
      return;
    }
    if (this.level !== 'none') {
      const level = this.level as Exclude<AlarmLevel, 'none'>;
      this.playBurst(level);
      this.timer = setInterval(() => this.playBurst(level), LEVELS[level].repeat);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      if (!this.ctx) this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return this.ctx;
    } catch {
      return null;
    }
  }

  private playBurst(level: Exclude<AlarmLevel, 'none'>): void {
    const ctx = this.ensureContext();
    if (!ctx || this.muted) return;
    const { freq, beeps, gap } = LEVELS[level];
    const start = ctx.currentTime + 0.02;
    for (let i = 0; i < beeps; i += 1) {
      const t = start + i * gap;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.setValueAtTime(freq * 0.82, t + gap * 0.55);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.02, this.volume), t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + gap * 0.75);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + gap);
    }
  }

  setLevel(level: AlarmLevel): void {
    if (level === this.level) return;
    this.level = level;
    this.stopTimer();
    if (level === 'none' || this.muted) return;

    this.playBurst(level);
    const { repeat } = LEVELS[level];
    this.timer = setInterval(() => this.playBurst(level), repeat);
  }

  getLevel(): AlarmLevel {
    return this.level;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.stopTimer();
  }

  /** Called on explicit user interaction to unlock the audio hardware. */
  unlock(): void {
    this.ensureContext();
  }

  dispose(): void {
    this.stopTimer();
    void this.ctx?.close();
    this.ctx = null;
  }
}
