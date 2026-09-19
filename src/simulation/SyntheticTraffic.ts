/**
 * Minimal synthetic traffic for benchmarks (spec §31 first paragraph): vehicles move in
 * straight lines with slowly drifting headings inside a square city area and wrap at
 * the edges. Road-following traffic replaces this in phase C4. Writes into a
 * VehicleBuffer; allocates nothing per tick.
 */

import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import type { SimulationSource } from "@/types/vehicle.ts";

export interface SyntheticTrafficOptions {
  count: number;
  /** side length of the square area in metres, centred on the origin */
  areaSize?: number;
  minSpeed?: number;
  maxSpeed?: number;
  tickInterval?: number;
  seed?: number;
}

/** Small deterministic PRNG so benchmark runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SyntheticTraffic implements SimulationSource {
  readonly id = "synthetic";
  readonly vehicleCount: number;
  readonly tickInterval: number;
  running = false;
  private readonly half: number;
  private readonly drift: Float32Array;
  private accumulator = 0;

  constructor(
    private readonly buffer: VehicleBuffer,
    opts: SyntheticTrafficOptions,
  ) {
    if (opts.count > buffer.capacity) throw new RangeError("count exceeds buffer capacity");
    this.vehicleCount = opts.count;
    this.tickInterval = opts.tickInterval ?? 0.1;
    this.half = (opts.areaSize ?? 3000) / 2;
    const rand = mulberry32(opts.seed ?? 1);
    const minSpeed = opts.minSpeed ?? 4;
    const maxSpeed = opts.maxSpeed ?? 22;
    this.drift = new Float32Array(opts.count);
    for (let i = 0; i < opts.count; i++) {
      buffer.set(i, {
        x: (rand() * 2 - 1) * this.half,
        y: 0,
        z: (rand() * 2 - 1) * this.half,
        heading: rand() * Math.PI * 2,
        speed: minSpeed + rand() * (maxSpeed - minSpeed),
        vehicleType: 0,
        colorIndex: Math.floor(rand() * 8),
      });
      this.drift[i] = (rand() - 0.5) * 0.4; // rad/s
    }
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  /** Advance by dt seconds, in fixed steps of tickInterval. Returns the number of ticks run. */
  tick(dtSeconds: number): number {
    if (!this.running) return 0;
    this.accumulator += dtSeconds;
    let ticks = 0;
    while (this.accumulator >= this.tickInterval) {
      this.step(this.tickInterval);
      this.accumulator -= this.tickInterval;
      ticks++;
    }
    return ticks;
  }

  step(dt: number): void {
    const { x, z, heading, speed } = this.buffer;
    const n = this.vehicleCount;
    const half = this.half;
    const size = half * 2;
    const drift = this.drift;
    for (let i = 0; i < n; i++) {
      let h = (heading[i] as number) + (drift[i] as number) * dt;
      if (h > Math.PI * 2) h -= Math.PI * 2;
      else if (h < 0) h += Math.PI * 2;
      heading[i] = h;
      const v = (speed[i] as number) * dt;
      // heading is clockwise from north; north is -z, east is +x
      let px = (x[i] as number) + Math.sin(h) * v;
      let pz = (z[i] as number) - Math.cos(h) * v;
      if (px > half) px -= size;
      else if (px < -half) px += size;
      if (pz > half) pz -= size;
      else if (pz < -half) pz += size;
      x[i] = px;
      z[i] = pz;
    }
  }

  dispose(): void {
    this.running = false;
  }
}
