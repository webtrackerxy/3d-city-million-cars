import { describe, expect, it } from "vitest";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import {
  DELTA_RECORD_BYTES,
  DeltaReference,
  FULL_RECORD_BYTES,
  FrameKind,
  HEADER_BYTES,
  decodeFrame,
  decodeJson,
  encodeDelta,
  encodeFull,
  encodeJson,
  encodeViewport,
  readHeader,
} from "./protocol.ts";

function sample(n: number): VehicleBuffer {
  const b = new VehicleBuffer(n);
  for (let i = 0; i < n; i++) {
    b.set(i, {
      x: -2000 + i * 0.37,
      y: 0,
      z: 1500 - i * 0.11,
      heading: (i * 0.7) % (Math.PI * 2),
      speed: (i % 40) * 0.5,
      vehicleType: i % 5,
      colorIndex: i % 16,
    });
  }
  return b;
}

describe("protocol", () => {
  it("FULL round-trips within quantisation error and has the documented size", () => {
    const src = sample(1000);
    const frame = encodeFull(src, 1000, 7, 12345);
    expect(frame.byteLength).toBe(HEADER_BYTES + 1000 * FULL_RECORD_BYTES);
    const h = readHeader(frame);
    expect(h).toEqual({ kind: FrameKind.Full, flags: 0, seq: 7, timeMs: 12345, count: 1000 });
    const dst = new VehicleBuffer(1000);
    decodeFrame(frame, dst, null);
    expect(dst.count).toBe(1000);
    for (const i of [0, 1, 500, 999]) {
      expect(dst.x[i]).toBeCloseTo(src.x[i] as number, 2);
      expect(dst.z[i]).toBeCloseTo(src.z[i] as number, 2);
      expect(Math.abs((dst.heading[i] as number) - (src.heading[i] as number))).toBeLessThan(0.0002);
      expect(dst.speed[i]).toBe(src.speed[i]);
      expect(dst.type[i]).toBe(src.type[i]);
      expect(dst.color[i]).toBe(src.color[i]);
    }
  });

  it("DELTA frames reproduce motion against a shared reference", () => {
    const src = sample(500);
    const senderRef = new DeltaReference(500);
    const receiverRef = new DeltaReference(500);
    const dst = new VehicleBuffer(500);
    decodeFrame(encodeFull(src, 500, 1, 0), dst, receiverRef);
    senderRef.setFromBuffer(src);
    // move everything 1.23 m east, 0.5 m north, rotate 0.1 rad, speed up
    for (let i = 0; i < 500; i++) {
      src.x[i] = (src.x[i] as number) + 1.23;
      src.z[i] = (src.z[i] as number) - 0.5;
      src.heading[i] = ((src.heading[i] as number) + 0.1) % (Math.PI * 2);
      src.speed[i] = 12;
    }
    const delta = encodeDelta(src, senderRef, 500, 2, 100);
    expect(delta).not.toBeNull();
    expect((delta as ArrayBuffer).byteLength).toBe(HEADER_BYTES + 500 * DELTA_RECORD_BYTES);
    decodeFrame(delta as ArrayBuffer, dst, receiverRef);
    for (const i of [0, 250, 499]) {
      expect(dst.x[i]).toBeCloseTo(src.x[i] as number, 2);
      expect(dst.z[i]).toBeCloseTo(src.z[i] as number, 2);
      // heading delta is coarser (1/256 turn ≈ 0.025 rad)
      expect(Math.abs((dst.heading[i] as number) - (src.heading[i] as number))).toBeLessThan(0.03);
      expect(dst.speed[i]).toBe(12);
    }
    // a second delta accumulates without drift beyond quantisation
    for (let i = 0; i < 500; i++) src.x[i] = (src.x[i] as number) + 2;
    decodeFrame(encodeDelta(src, senderRef, 500, 3, 200) as ArrayBuffer, dst, receiverRef);
    expect(dst.x[100]).toBeCloseTo(src.x[100] as number, 2);
  });

  it("DELTA carries jumps beyond ±327 m as full corrections", () => {
    const src = sample(10);
    const senderRef = new DeltaReference(10);
    const receiverRef = new DeltaReference(10);
    const dst = new VehicleBuffer(10);
    decodeFrame(encodeFull(src, 10, 1, 0), dst, receiverRef);
    senderRef.setFromBuffer(src);
    src.x[3] = (src.x[3] as number) + 400;
    src.z[7] = (src.z[7] as number) - 1000;
    const delta = encodeDelta(src, senderRef, 10, 2, 0) as ArrayBuffer;
    expect(readHeader(delta).flags).toBe(2);
    expect(delta.byteLength).toBe(HEADER_BYTES + 10 * DELTA_RECORD_BYTES + 2 * 16);
    decodeFrame(delta, dst, receiverRef);
    expect(dst.x[3]).toBeCloseTo(src.x[3], 2);
    expect(dst.z[7]).toBeCloseTo(src.z[7], 2);
    expect(dst.x[0]).toBeCloseTo(src.x[0] as number, 2);
  });

  it("VIEWPORT frames update only the listed ids", () => {
    const src = sample(100);
    const dst = new VehicleBuffer(100);
    const frame = encodeViewport(src, [5, 42, 99], 3, 9, 500);
    decodeFrame(frame, dst, null);
    expect(dst.x[42]).toBeCloseTo(src.x[42] as number, 2);
    expect(dst.x[41]).toBe(0);
    expect(dst.count).toBe(100);
  });

  it("JSON carries the same data at a much larger size", () => {
    const src = sample(1000);
    const text = encodeJson(src, 1000, 4, 40);
    const dst = new VehicleBuffer(1000);
    const h = decodeJson(text, dst);
    expect(h.count).toBe(1000);
    expect(dst.x[999]).toBeCloseTo(src.x[999] as number, 2);
    const binary = encodeFull(src, 1000, 4, 40).byteLength;
    expect(text.length / binary).toBeGreaterThan(2.5);
  });
});
