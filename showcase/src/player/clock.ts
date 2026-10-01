// Часы воспроизведения. Время модели двигается в одном цикле requestAnimationFrame;
// холсты читают его каждый кадр, панели React — с ограниченной частотой.
import type { ReplayModel } from "../replay/model";

export const SPEEDS = [10, 30, 60, 120, 300, 600] as const;

export class Clock {
  t: number;
  playing = false;
  speed = 60;
  private last = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly model: ReplayModel) {
    this.t = model.start;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Шаг часов; вызывается из цикла кадров. Возвращает true, если время сдвинулось. */
  tick(now: number): boolean {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.playing || dt === 0) return false;
    const t = this.t + dt * this.speed;
    if (t >= this.model.end) {
      this.t = this.model.end;
      this.playing = false;
      this.emit();
    } else this.t = t;
    return true;
  }

  play(): void {
    if (this.t >= this.model.end) this.t = this.model.start;
    this.playing = true;
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    this.t = this.model.clamp(t);
    this.emit();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.emit();
  }

  faster(dir: 1 | -1): void {
    const i = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number]);
    const j = Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir));
    this.setSpeed(SPEEDS[j]);
  }
}
