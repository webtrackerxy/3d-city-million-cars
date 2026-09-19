/**
 * Frame-time-driven cap scaling (spec §37): when frames run long the LOD0–LOD3 caps
 * shrink so more vehicles become boxes; when frames are back at the display rate they
 * grow toward the configured caps. Thresholds are relative to the display period,
 * because a vsync-bound app always reports the refresh interval (16.7 ms at 60 Hz, 8.3 ms
 * at 120 Hz) and fixed millisecond thresholds would ratchet down after any hiccup and
 * never recover.
 *
 * The period is the 20th percentile of the frame intervals in each decision window, not
 * the shortest one: after a late frame the browser delivers an early catch-up frame, and
 * at 1,000,000 vehicles every 100 ms snapshot upload causes such a pair. The shortest
 * interval then reads about 4 ms on a 120 Hz display, a healthy 8.3 ms mean looks 50 %
 * slow, and the caps used to sink to the floor and stay there.
 *
 * Pure and deterministic; the owner pushes the returned scale to the LOD manager (or the
 * worker). No per-frame allocation: intervals go into a fixed buffer, sorted once a window.
 */

/** percentile of the window's frame intervals taken as the display period */
const PERIOD_PERCENTILE = 0.2;
/** shortest plausible display period (250 Hz) */
const MIN_PERIOD_MS = 4;
/** frame intervals kept per window; more than a second at 500 Hz */
const WINDOW_CAPACITY = 512;

export interface AdaptiveLodOptions {
  /** mean frame interval above `slowFactor` × display period shrinks the caps */
  slowFactor?: number;
  /** mean frame interval below `fastFactor` × display period lets the caps grow */
  fastFactor?: number;
  /** multiplicative step per decision */
  step?: number;
  /** seconds between decisions */
  interval?: number;
  minScale?: number;
}

export class AdaptiveLod {
  scale = 1;
  private readonly slowFactor: number;
  private readonly fastFactor: number;
  private readonly intervals = new Float32Array(WINDOW_CAPACITY);
  private stored = 0;
  private readonly step: number;
  private readonly interval: number;
  private readonly minScale: number;
  private acc = 0;
  private sum = 0;
  private samples = 0;

  constructor(opts: AdaptiveLodOptions = {}) {
    this.slowFactor = opts.slowFactor ?? 1.5;
    this.fastFactor = opts.fastFactor ?? 1.15;
    this.step = opts.step ?? 0.8;
    this.interval = opts.interval ?? 1;
    this.minScale = opts.minScale ?? 0.1;
  }

  /** Feed one frame; returns the new scale when a decision was made, else null. */
  update(frameMs: number, dtSeconds: number): number | null {
    this.acc += dtSeconds;
    this.sum += frameMs;
    this.samples++;
    if (frameMs > 0 && this.stored < WINDOW_CAPACITY) this.intervals[this.stored++] = frameMs;
    if (this.acc < this.interval) return null;
    const mean = this.sum / Math.max(1, this.samples);
    let period = mean;
    if (this.stored > 0) {
      const sorted = this.intervals.subarray(0, this.stored).sort();
      period = Math.max(MIN_PERIOD_MS, sorted[Math.floor((this.stored - 1) * PERIOD_PERCENTILE)] as number);
    }
    this.acc = 0;
    this.sum = 0;
    this.samples = 0;
    this.stored = 0;
    let next = this.scale;
    if (mean > period * this.slowFactor) next = Math.max(this.minScale, this.scale * this.step);
    else if (mean < period * this.fastFactor) next = Math.min(1, this.scale / this.step);
    if (next === this.scale) return null;
    this.scale = next;
    return next;
  }
}
