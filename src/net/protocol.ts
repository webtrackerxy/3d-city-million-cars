/**
 * Wire protocol for vehicle state updates (spec §33, phase C5). Pure functions over
 * typed arrays; used by the Node server, the browser client and the benchmarks.
 *
 * Binary frame = 16-byte header + records:
 *   header  u8 magic 0xC5 | u8 kind | u16 flags | u32 seq | u32 timeMs | u32 count
 *   FULL     12 B/vehicle, ordered by id 0..count-1:
 *            i32 x_cm | i32 z_cm | u16 heading (turns/65536) | u8 speed (0.5 m/s) | u8 type<<4|colour
 *   DELTA     6 B/vehicle, ordered by id, relative to the previous FULL/DELTA frame:
 *            i16 dx_cm | i16 dz_cm | i8 dheading (turns/256) | u8 speed
 *            followed by `flags` correction records (u32 id | FULL record) for vehicles
 *            whose move exceeded ±327 m (teleports/respawns); their delta record is zero
 *   VIEWPORT 16 B/vehicle, arbitrary subset:  u32 id | FULL record
 *
 * JSON frames carry the same information as `{ seq, t, v: [[id, x, z, h, v, c], ...] }`
 * with centimetre-rounded numbers, for a fair size comparison.
 *
 * Quantisation: 1 cm positions, 0.0055° heading, 0.5 m/s speed. A delta record cannot
 * express more than ±327 m per update; such vehicles are appended as corrections. The
 * encoder returns null only if more than 65535 corrections are needed.
 */

import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";

export const MAGIC = 0xc5;
export const HEADER_BYTES = 16;
export const FULL_RECORD_BYTES = 12;
export const DELTA_RECORD_BYTES = 6;
export const VIEWPORT_RECORD_BYTES = 16;

export enum FrameKind {
  Full = 0,
  Delta = 1,
  Viewport = 2,
}

export interface FrameHeader {
  kind: FrameKind;
  flags: number;
  seq: number;
  timeMs: number;
  count: number;
}

const TWO_PI = Math.PI * 2;

function quantHeading(h: number): number {
  let t = h / TWO_PI;
  t -= Math.floor(t);
  return Math.round(t * 65536) & 0xffff;
}

function quantSpeed(v: number): number {
  const q = Math.round(v * 2);
  return q < 0 ? 0 : q > 255 ? 255 : q;
}

export function readHeader(buf: ArrayBuffer, byteOffset = 0): FrameHeader {
  const dv = new DataView(buf, byteOffset);
  if (dv.getUint8(0) !== MAGIC) throw new Error("bad magic");
  return {
    kind: dv.getUint8(1),
    flags: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    timeMs: dv.getUint32(8, true),
    count: dv.getUint32(12, true),
  };
}

function writeHeader(dv: DataView, h: FrameHeader): void {
  dv.setUint8(0, MAGIC);
  dv.setUint8(1, h.kind);
  dv.setUint16(2, h.flags, true);
  dv.setUint32(4, h.seq >>> 0, true);
  dv.setUint32(8, h.timeMs >>> 0, true);
  dv.setUint32(12, h.count >>> 0, true);
}

/** Encode vehicles [0, count) as a FULL frame. */
export function encodeFull(buffer: VehicleBuffer, count: number, seq: number, timeMs: number): ArrayBuffer {
  const out = new ArrayBuffer(HEADER_BYTES + count * FULL_RECORD_BYTES);
  const dv = new DataView(out);
  writeHeader(dv, { kind: FrameKind.Full, flags: 0, seq, timeMs, count });
  const { x, z, heading, speed, type, color } = buffer;
  let o = HEADER_BYTES;
  for (let i = 0; i < count; i++, o += FULL_RECORD_BYTES) {
    dv.setInt32(o, Math.round((x[i] as number) * 100), true);
    dv.setInt32(o + 4, Math.round((z[i] as number) * 100), true);
    dv.setUint16(o + 8, quantHeading(heading[i] as number), true);
    dv.setUint8(o + 10, quantSpeed(speed[i] as number));
    dv.setUint8(o + 11, (((type[i] as number) & 0xf) << 4) | ((color[i] as number) & 0xf));
  }
  return out;
}

/** Quantised reference state the DELTA codec is relative to (kept on both ends). */
export class DeltaReference {
  readonly xCm: Int32Array;
  readonly zCm: Int32Array;
  readonly heading: Uint16Array;
  constructor(readonly count: number) {
    this.xCm = new Int32Array(count);
    this.zCm = new Int32Array(count);
    this.heading = new Uint16Array(count);
  }
  /** Reset the reference from a buffer (after a FULL frame on either side). */
  setFromBuffer(buffer: VehicleBuffer): void {
    for (let i = 0; i < this.count; i++) {
      this.xCm[i] = Math.round((buffer.x[i] as number) * 100);
      this.zCm[i] = Math.round((buffer.z[i] as number) * 100);
      this.heading[i] = quantHeading(buffer.heading[i] as number);
    }
  }
}

/**
 * Encode vehicles [0, count) as a DELTA frame against `ref`, updating `ref`. Vehicles
 * that moved more than ±327 m get a zero delta plus a trailing correction record
 * (u32 id + FULL record). Returns null only if more than 65535 corrections are needed.
 */
export function encodeDelta(
  buffer: VehicleBuffer,
  ref: DeltaReference,
  count: number,
  seq: number,
  timeMs: number,
): ArrayBuffer | null {
  const { x, z, heading, speed, type, color } = buffer;
  // pass 1: find corrections
  let corrections = 0;
  for (let i = 0; i < count; i++) {
    const dx = Math.round((x[i] as number) * 100) - (ref.xCm[i] as number);
    const dz = Math.round((z[i] as number) * 100) - (ref.zCm[i] as number);
    if (dx > 32767 || dx < -32768 || dz > 32767 || dz < -32768) corrections++;
  }
  if (corrections > 0xffff) return null;
  const out = new ArrayBuffer(
    HEADER_BYTES + count * DELTA_RECORD_BYTES + corrections * VIEWPORT_RECORD_BYTES,
  );
  const dv = new DataView(out);
  writeHeader(dv, { kind: FrameKind.Delta, flags: corrections, seq, timeMs, count });
  let o = HEADER_BYTES;
  let c = HEADER_BYTES + count * DELTA_RECORD_BYTES;
  for (let i = 0; i < count; i++, o += DELTA_RECORD_BYTES) {
    const xq = Math.round((x[i] as number) * 100);
    const zq = Math.round((z[i] as number) * 100);
    const hq = quantHeading(heading[i] as number);
    const dx = xq - (ref.xCm[i] as number);
    const dz = zq - (ref.zCm[i] as number);
    const sq = quantSpeed(speed[i] as number);
    if (dx > 32767 || dx < -32768 || dz > 32767 || dz < -32768) {
      dv.setInt16(o, 0, true);
      dv.setInt16(o + 2, 0, true);
      dv.setInt8(o + 4, 0);
      dv.setUint8(o + 5, sq);
      dv.setUint32(c, i, true);
      dv.setInt32(c + 4, xq, true);
      dv.setInt32(c + 8, zq, true);
      dv.setUint16(c + 12, hq, true);
      dv.setUint8(c + 14, sq);
      dv.setUint8(c + 15, (((type[i] as number) & 0xf) << 4) | ((color[i] as number) & 0xf));
      c += VIEWPORT_RECORD_BYTES;
      ref.xCm[i] = xq;
      ref.zCm[i] = zq;
      ref.heading[i] = hq;
      continue;
    }
    // heading delta in turns/256, wrapped
    let dh = Math.round((hq - (ref.heading[i] as number)) / 256);
    dh = ((dh + 128) & 0xff) - 128;
    dv.setInt16(o, dx, true);
    dv.setInt16(o + 2, dz, true);
    dv.setInt8(o + 4, dh);
    dv.setUint8(o + 5, sq);
    ref.xCm[i] = xq;
    ref.zCm[i] = zq;
    ref.heading[i] = ((ref.heading[i] as number) + dh * 256) & 0xffff;
  }
  return out;
}

/** Encode an arbitrary subset of vehicle ids as a VIEWPORT frame (with ids). */
export function encodeViewport(
  buffer: VehicleBuffer,
  ids: ArrayLike<number>,
  count: number,
  seq: number,
  timeMs: number,
): ArrayBuffer {
  const out = new ArrayBuffer(HEADER_BYTES + count * VIEWPORT_RECORD_BYTES);
  const dv = new DataView(out);
  writeHeader(dv, { kind: FrameKind.Viewport, flags: 0, seq, timeMs, count });
  const { x, z, heading, speed, type, color } = buffer;
  let o = HEADER_BYTES;
  for (let k = 0; k < count; k++, o += VIEWPORT_RECORD_BYTES) {
    const i = ids[k] as number;
    dv.setUint32(o, i, true);
    dv.setInt32(o + 4, Math.round((x[i] as number) * 100), true);
    dv.setInt32(o + 8, Math.round((z[i] as number) * 100), true);
    dv.setUint16(o + 12, quantHeading(heading[i] as number), true);
    dv.setUint8(o + 14, quantSpeed(speed[i] as number));
    dv.setUint8(o + 15, (((type[i] as number) & 0xf) << 4) | ((color[i] as number) & 0xf));
  }
  return out;
}

/**
 * Decode any binary frame into the buffer. DELTA frames need the receiver's `ref`
 * (kept in sync by FULL frames). Returns the header.
 */
export function decodeFrame(
  buf: ArrayBuffer,
  buffer: VehicleBuffer,
  ref: DeltaReference | null,
): FrameHeader {
  const h = readHeader(buf);
  const dv = new DataView(buf);
  const { x, z, heading, speed, type, color, flags } = buffer;
  let o = HEADER_BYTES;
  switch (h.kind) {
    case FrameKind.Full: {
      for (let i = 0; i < h.count; i++, o += FULL_RECORD_BYTES) {
        const xq = dv.getInt32(o, true);
        const zq = dv.getInt32(o + 4, true);
        const hq = dv.getUint16(o + 8, true);
        x[i] = xq / 100;
        z[i] = zq / 100;
        heading[i] = (hq / 65536) * TWO_PI;
        speed[i] = dv.getUint8(o + 10) / 2;
        const tc = dv.getUint8(o + 11);
        type[i] = tc >> 4;
        color[i] = tc & 0xf;
        flags[i] = 1;
        if (ref) {
          ref.xCm[i] = xq;
          ref.zCm[i] = zq;
          ref.heading[i] = hq;
        }
      }
      if (h.count > buffer.count) buffer.count = h.count;
      break;
    }
    case FrameKind.Delta: {
      if (!ref) throw new Error("delta frame without reference");
      for (let i = 0; i < h.count; i++, o += DELTA_RECORD_BYTES) {
        const xq = (ref.xCm[i] as number) + dv.getInt16(o, true);
        const zq = (ref.zCm[i] as number) + dv.getInt16(o + 2, true);
        const hq = ((ref.heading[i] as number) + dv.getInt8(o + 4) * 256) & 0xffff;
        ref.xCm[i] = xq;
        ref.zCm[i] = zq;
        ref.heading[i] = hq;
        x[i] = xq / 100;
        z[i] = zq / 100;
        heading[i] = (hq / 65536) * TWO_PI;
        speed[i] = dv.getUint8(o + 5) / 2;
      }
      // corrections for vehicles that jumped
      for (let k = 0; k < h.flags; k++, o += VIEWPORT_RECORD_BYTES) {
        const i = dv.getUint32(o, true);
        if (i >= buffer.capacity) continue;
        const xq = dv.getInt32(o + 4, true);
        const zq = dv.getInt32(o + 8, true);
        const hq = dv.getUint16(o + 12, true);
        ref.xCm[i] = xq;
        ref.zCm[i] = zq;
        ref.heading[i] = hq;
        x[i] = xq / 100;
        z[i] = zq / 100;
        heading[i] = (hq / 65536) * TWO_PI;
        speed[i] = dv.getUint8(o + 14) / 2;
        const tc = dv.getUint8(o + 15);
        type[i] = tc >> 4;
        color[i] = tc & 0xf;
      }
      break;
    }
    case FrameKind.Viewport: {
      for (let k = 0; k < h.count; k++, o += VIEWPORT_RECORD_BYTES) {
        const i = dv.getUint32(o, true);
        if (i >= buffer.capacity) continue;
        x[i] = dv.getInt32(o + 4, true) / 100;
        z[i] = dv.getInt32(o + 8, true) / 100;
        heading[i] = (dv.getUint16(o + 12, true) / 65536) * TWO_PI;
        speed[i] = dv.getUint8(o + 14) / 2;
        const tc = dv.getUint8(o + 15);
        type[i] = tc >> 4;
        color[i] = tc & 0xf;
        flags[i] = 1;
        if (i >= buffer.count) buffer.count = i + 1;
      }
      break;
    }
  }
  return h;
}

/** JSON encoding with the same quantisation, for size and parse-cost comparison. */
export function encodeJson(buffer: VehicleBuffer, count: number, seq: number, timeMs: number): string {
  const v: number[][] = new Array<number[]>(count);
  const { x, z, heading, speed, type, color } = buffer;
  for (let i = 0; i < count; i++) {
    v[i] = [
      i,
      Math.round((x[i] as number) * 100) / 100,
      Math.round((z[i] as number) * 100) / 100,
      Math.round((heading[i] as number) * 1000) / 1000,
      Math.round((speed[i] as number) * 2) / 2,
      (((type[i] as number) & 0xf) << 4) | ((color[i] as number) & 0xf),
    ];
  }
  return JSON.stringify({ seq, t: timeMs, v });
}

export function decodeJson(text: string, buffer: VehicleBuffer): FrameHeader {
  const msg = JSON.parse(text) as { seq: number; t: number; v: number[][] };
  const { x, z, heading, speed, type, color, flags } = buffer;
  for (const rec of msg.v) {
    const i = rec[0] as number;
    if (i >= buffer.capacity) continue;
    x[i] = rec[1] as number;
    z[i] = rec[2] as number;
    heading[i] = rec[3] as number;
    speed[i] = rec[4] as number;
    const tc = rec[5] as number;
    type[i] = tc >> 4;
    color[i] = tc & 0xf;
    flags[i] = 1;
    if (i >= buffer.count) buffer.count = i + 1;
  }
  return { kind: FrameKind.Full, flags: 0, seq: msg.seq, timeMs: msg.t, count: msg.v.length };
}
