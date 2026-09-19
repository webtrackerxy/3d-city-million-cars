import { describe, expect, it } from "vitest";
import { VehicleBuffer, VehicleFlag, VEHICLE_STRIDE_BYTES } from "./VehicleBuffer.ts";
import { VehicleType } from "@/types/vehicle.ts";

describe("VehicleBuffer", () => {
  it("allocates exactly stride × capacity bytes and non-overlapping views", () => {
    const b = new VehicleBuffer(1000);
    expect(b.buffer.byteLength).toBe(1000 * VEHICLE_STRIDE_BYTES);
    b.x.fill(1);
    b.y.fill(2);
    b.heading.fill(3);
    b.type.fill(7);
    b.flags.fill(9);
    expect(b.x[999]).toBe(1);
    expect(b.y[0]).toBe(2);
    expect(b.z[0]).toBe(0);
    expect(b.heading[500]).toBe(3);
    expect(b.color[0]).toBe(0);
    expect(b.type[999]).toBe(7);
    expect(b.flags[0]).toBe(9);
  });

  it("round-trips a vehicle through set/get and tracks count", () => {
    const b = new VehicleBuffer(10);
    b.set(3, {
      x: 1.5,
      y: 0,
      z: -2.5,
      heading: Math.PI / 2,
      speed: 12,
      vehicleType: VehicleType.Bus,
      colorIndex: 4,
    });
    expect(b.count).toBe(4);
    const v = b.get(3);
    expect(v).toEqual({
      id: 3,
      x: 1.5,
      y: 0,
      z: -2.5,
      heading: Math.fround(Math.PI / 2),
      speed: 12,
      vehicleType: VehicleType.Bus,
      colorIndex: 4,
    });
    expect(b.flags[3]).toBe(VehicleFlag.Active);
    expect(() => b.get(4)).toThrow(RangeError);
  });

  it("packs xyz+heading into an RGBA float layout", () => {
    const b = new VehicleBuffer(4);
    for (let i = 0; i < 3; i++) {
      b.set(i, { x: i, y: 10 + i, z: 20 + i, heading: 0.1 * i, speed: 0, vehicleType: 0, colorIndex: 0 });
    }
    const out = new Float32Array(16);
    b.packStateInto(out);
    expect(Array.from(out.subarray(0, 12))).toEqual([
      0,
      10,
      20,
      0,
      1,
      11,
      21,
      Math.fround(0.1),
      2,
      12,
      22,
      Math.fround(0.2),
    ]);
    expect(() => {
      b.packStateInto(new Float32Array(4));
    }).toThrow(RangeError);
  });

  it("wraps an externally provided backing buffer", () => {
    const backing = new ArrayBuffer(50 * VEHICLE_STRIDE_BYTES);
    const b = new VehicleBuffer(50, backing);
    expect(b.buffer).toBe(backing);
    expect(() => new VehicleBuffer(51, backing)).toThrow(RangeError);
  });
});
