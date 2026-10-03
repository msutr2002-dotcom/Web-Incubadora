export interface Thresholds {
  humMin: number;
  humMax: number;
  hysteresis: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  humMin: 65,
  humMax: 85,
  hysteresis: 2,
};

const KEY = 'incubator.thresholds.v2';

export function loadThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_THRESHOLDS;
    const parsed = JSON.parse(raw) as Partial<Thresholds>;
    return { ...DEFAULT_THRESHOLDS, ...parsed };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export function saveThresholds(t: Thresholds): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* storage disabled */
  }
}

export function inRange(value: number, t: Thresholds): boolean {
  return value >= t.humMin - t.hysteresis && value <= t.humMax + t.hysteresis;
}
