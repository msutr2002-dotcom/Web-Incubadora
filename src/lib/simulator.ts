type Phase = 'normal' | 'hum_high' | 'lockdown' | 'hatch';

const PHASE_ORDER: Phase[] = ['normal', 'hum_high', 'lockdown', 'hatch'];
const PHASE_MS: Record<Phase, number> = { normal: 9000, hum_high: 9000, lockdown: 7000, hatch: 7000 };

export class Simulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private phaseIdx = 0;
  private phaseStart = 0;
  private humidity = 64;
  private temperature = 37.5;
  private battery = 96;

  start(onLine: (line: string) => void): void {
    this.stop();
    this.phaseStart = Date.now();
    const tick = () => {
      const now = Date.now();
      const phase = PHASE_ORDER[this.phaseIdx];
      if (now - this.phaseStart >= PHASE_MS[phase]) {
        this.phaseIdx = (this.phaseIdx + 1) % PHASE_ORDER.length;
        this.phaseStart = now;
        const next = PHASE_ORDER[this.phaseIdx];
        if (next === 'hatch') onLine('ALERT:HATCH,VALUE:' + this.humidity.toFixed(1));
        if (next === 'lockdown') onLine('ALERT:LOCKDOWN');
        if (next === 'hum_high') onLine('ALERT:HUM_HIGH,VALUE:78.5');
      }

      const current = PHASE_ORDER[this.phaseIdx];
      const targetHum =
        current === 'hum_high' ? 79 : current === 'hatch' ? 70 : current === 'lockdown' ? 62 : 64;
      this.humidity += (targetHum - this.humidity) * 0.18 + (Math.random() - 0.5) * 0.6;
      this.temperature += (37.5 - this.temperature) * 0.15 + (Math.random() - 0.5) * 0.12;
      this.battery = Math.max(4, this.battery - 0.01);

      onLine(
        [
          `HUM:${this.humidity.toFixed(1)}`,
          `TEMP:${this.temperature.toFixed(2)}`,
          `BAT:${this.battery.toFixed(0)}`,
          `STATE:${current === 'normal' ? 'IDLE' : current.toUpperCase()}`,
        ].join(','),
      );
    };

    tick();
    this.timer = setInterval(tick, 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
