/**
 * Structure-of-Arrays storage for up to `capacity` vehicles (spec §4, §38).
 *
 * All fields are typed-array views over one backing buffer, which is a
 * SharedArrayBuffer when the page is cross-origin isolated so a worker can own the
 * simulation while the render thread reads. No per-vehicle objects are ever created.
 *
 * Layout (bytes per vehicle): x,y,z,heading,speed = 5 × 4, type,color,flags = 3 × 1,
 * padded to 24 bytes. 100k vehicles = 2.4 MB.
 */

import type { VehicleState, VehicleType } from "@/types/vehicle.ts";

export const VEHICLE_STRIDE_BYTES = 24;

export interface VehicleBufferViews {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  heading: Float32Array;
  speed: Float32Array;
  type: Uint8Array;
  color: Uint8Array;
  flags: Uint8Array;
}

export const VehicleFlag = {
  Active: 1,
  Selected: 2,
} as const;

export function supportsSharedMemory(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean };
  return typeof SharedArrayBuffer !== "undefined" && g.crossOriginIsolated === true;
}

export class VehicleBuffer implements VehicleBufferViews {
  readonly capacity: number;
  readonly buffer: ArrayBufferLike;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly heading: Float32Array;
  readonly speed: Float32Array;
  readonly type: Uint8Array;
  readonly color: Uint8Array;
  readonly flags: Uint8Array;
  /** Number of vehicles currently populated (≤ capacity). */
  count = 0;

  constructor(capacity: number, backing?: ArrayBufferLike) {
    this.capacity = capacity;
    const bytes = capacity * VEHICLE_STRIDE_BYTES;
    if (backing) {
      if (backing.byteLength < bytes)
        throw new RangeError(`backing buffer too small for ${capacity} vehicles`);
      this.buffer = backing;
    } else {
      this.buffer = supportsSharedMemory() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    }
    const f = capacity * 4;
    this.x = new Float32Array(this.buffer, 0 * f, capacity);
    this.y = new Float32Array(this.buffer, 1 * f, capacity);
    this.z = new Float32Array(this.buffer, 2 * f, capacity);
    this.heading = new Float32Array(this.buffer, 3 * f, capacity);
    this.speed = new Float32Array(this.buffer, 4 * f, capacity);
    this.type = new Uint8Array(this.buffer, 5 * f, capacity);
    this.color = new Uint8Array(this.buffer, 5 * f + capacity, capacity);
    this.flags = new Uint8Array(this.buffer, 5 * f + 2 * capacity, capacity);
  }

  get isShared(): boolean {
    return typeof SharedArrayBuffer !== "undefined" && this.buffer instanceof SharedArrayBuffer;
  }

  /** Read one vehicle as a value object (boundary use only). */
  get(i: number): VehicleState {
    if (i < 0 || i >= this.count) throw new RangeError(`vehicle ${i} out of range`);
    return {
      id: i,
      x: this.x[i] as number,
      y: this.y[i] as number,
      z: this.z[i] as number,
      heading: this.heading[i] as number,
      speed: this.speed[i] as number,
      vehicleType: this.type[i] as VehicleType,
      colorIndex: this.color[i] as number,
    };
  }

  set(i: number, s: Omit<VehicleState, "id">): void {
    if (i < 0 || i >= this.capacity) throw new RangeError(`vehicle ${i} out of range`);
    this.x[i] = s.x;
    this.y[i] = s.y;
    this.z[i] = s.z;
    this.heading[i] = s.heading;
    this.speed[i] = s.speed;
    this.type[i] = s.vehicleType;
    this.color[i] = s.colorIndex;
    this.flags[i] = VehicleFlag.Active;
    if (i >= this.count) this.count = i + 1;
  }

  /**
   * Pack (x, y, z, heading) for vehicles [0, count) into an RGBA float array, the
   * layout of the GPU state texture. `target.length` must be ≥ 4 × count.
   */
  packStateInto(target: Float32Array): void {
    const n = this.count;
    if (target.length < n * 4) throw new RangeError("target too small");
    const { x, y, z, heading } = this;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      target[o] = x[i] as number;
      target[o + 1] = y[i] as number;
      target[o + 2] = z[i] as number;
      target[o + 3] = heading[i] as number;
    }
  }
}
