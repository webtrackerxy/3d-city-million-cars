/**
 * requestAnimationFrame loop with frame timing. Owns nothing else: scenes, cameras and
 * renderers are passed in by the caller so the loop can drive benchmarks and pages alike.
 */

export interface FrameInfo {
  /** seconds since the previous frame (clamped to 0.25 to survive tab switches) */
  dt: number;
  /** seconds since start() */
  elapsed: number;
  /** frame counter since start() */
  frame: number;
  /** high-resolution timestamp of this frame (performance.now()) */
  now: number;
}

export type FrameCallback = (info: FrameInfo) => void;

export class RenderLoop {
  private handle = 0;
  private startTime = 0;
  private lastTime = 0;
  private frame = 0;
  private readonly callbacks = new Set<FrameCallback>();
  running = false;

  add(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();
    this.lastTime = this.startTime;
    this.frame = 0;
    const tick = (now: number): void => {
      if (!this.running) return;
      const dt = Math.min((now - this.lastTime) / 1000, 0.25);
      this.lastTime = now;
      const info: FrameInfo = { dt, elapsed: (now - this.startTime) / 1000, frame: this.frame++, now };
      for (const cb of this.callbacks) cb(info);
      this.handle = requestAnimationFrame(tick);
    };
    this.handle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }
}
