/**
 * GPU-resident vehicle state: two RGBA32F textures (previous and next snapshot) holding
 * (x, y, z, heading) per vehicle, indexed by vehicle id. The vertex shader interpolates
 * between them with a single uniform `t`, so per-frame CPU work is zero and the upload
 * happens only when a new data snapshot arrives (e.g. 10 Hz). See spec §31, §34.
 */

import { DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";
import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";

export const STATE_TEXTURE_WIDTH = 512;

export class VehicleStateTexture {
  readonly width = STATE_TEXTURE_WIDTH;
  readonly height: number;
  readonly capacity: number;
  readonly prev: DataTexture;
  readonly next: DataTexture;
  private readonly prevData: Float32Array;
  private readonly nextData: Float32Array;
  /** timestamps (seconds) of the two snapshots, for interpolation */
  prevTime = 0;
  nextTime = 0;
  snapshots = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.height = Math.max(1, Math.ceil(capacity / this.width));
    const texels = this.width * this.height * 4;
    this.prevData = new Float32Array(texels);
    this.nextData = new Float32Array(texels);
    this.prev = VehicleStateTexture.makeTexture(this.prevData, this.width, this.height);
    this.next = VehicleStateTexture.makeTexture(this.nextData, this.width, this.height);
  }

  private static makeTexture(data: Float32Array, w: number, h: number): DataTexture {
    const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Push a new snapshot: the current `next` becomes `prev`, and `next` is refilled from
   * the buffer. Costs one 1.6 MB copy for 100k vehicles plus one texture upload.
   */
  pushSnapshot(buffer: VehicleBuffer, time: number): void {
    // swap contents: prev <- next (copy), then next <- buffer
    this.prevData.set(this.nextData);
    buffer.packStateInto(this.nextData);
    this.prevTime = this.nextTime;
    this.nextTime = time;
    if (this.snapshots === 0) {
      // first snapshot: make prev identical so interpolation starts stable
      this.prevData.set(this.nextData);
      this.prevTime = time;
    }
    this.snapshots++;
    this.prev.needsUpdate = true;
    this.next.needsUpdate = true;
  }

  /** Push an already packed (x, y, z, heading) RGBA snapshot, e.g. from the traffic worker. */
  pushPacked(packed: Float32Array, time: number): void {
    this.prevData.set(this.nextData);
    this.nextData.set(packed.subarray(0, Math.min(packed.length, this.nextData.length)));
    this.prevTime = this.nextTime;
    this.nextTime = time;
    if (this.snapshots === 0) {
      this.prevData.set(this.nextData);
      this.prevTime = time;
    }
    this.snapshots++;
    this.prev.needsUpdate = true;
    this.next.needsUpdate = true;
  }

  /** Interpolation factor for render time `now` (seconds, same clock as pushSnapshot). */
  factorAt(now: number): number {
    const span = this.nextTime - this.prevTime;
    if (span <= 0) return 1;
    const t = (now - this.prevTime) / span;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  dispose(): void {
    this.prev.dispose();
    this.next.dispose();
  }
}
