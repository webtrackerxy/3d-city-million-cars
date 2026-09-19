import { describe, expect, it } from "vitest";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { BUCKET_BOX, DEFAULT_LOD_CONFIG, type LodConfig } from "@/config/lodConfig.ts";
import { VehicleLodManager, type LodCamera } from "./VehicleLodManager.ts";

/** Camera at the origin looking down −z with a 90° frustum; planes are loose half-spaces. */
function camera(): LodCamera {
  // planes: n·p + d >= 0 inside. Near z <= -0.1, far z >= -100000, |x| <= -z, |y| <= -z
  const planes = new Float32Array([
    0,
    0,
    -1,
    -0.1, // near: -z - 0.1 >= 0
    0,
    0,
    1,
    100000, // far
    -1,
    0,
    -1,
    0, // right: -x - z >= 0
    1,
    0,
    -1,
    0, // left
    0,
    -1,
    -1,
    0, // top
    0,
    1,
    -1,
    0, // bottom
  ]);
  return { x: 0, y: 0, z: 0, planes, focalPx: 500 };
}

function ids(m: VehicleLodManager, bucket: number): number[] {
  const b = m.buckets[bucket];
  if (!b) throw new Error(`no bucket ${bucket}`);
  return Array.from(b.ids.subarray(0, b.count)).sort((x, y) => x - y);
}

function fill(buffer: VehicleBuffer, distances: number[]): void {
  distances.forEach((d, i) => {
    buffer.set(i, { x: 0, y: 0, z: -d, heading: 0, speed: 0, vehicleType: 0, colorIndex: 0 });
  });
}

const config: LodConfig = {
  ...DEFAULT_LOD_CONFIG,
  minPixels: [200, 50, 10, 2, 0.5],
  caps: [2, 3, 100, 1000],
  hysteresis: 0.1,
  boundingRadius: 2,
};

describe("VehicleLodManager", () => {
  it("buckets by projected size and culls outside the frustum", () => {
    const buffer = new VehicleBuffer(8);
    // size = 2r·focal/dist = 2000/dist px  -> 10 m: 200px (LOD0), 100 m: 20px (LOD2), 1000 m: 2px (LOD3), 5000 m: 0.4px (culled)
    fill(buffer, [10, 100, 1000, 5000]);
    buffer.set(4, { x: 500, y: 0, z: -10, heading: 0, speed: 0, vehicleType: 0, colorIndex: 0 }); // outside frustum
    const m = new VehicleLodManager(8, config);
    const stats = m.update(buffer, camera());
    expect(stats.counts).toEqual([1, 0, 1, 1, 0]);
    expect(stats.outsideFrustum).toBe(1);
    expect(stats.culled).toBe(2);
    expect(ids(m, 0)).toEqual([0]);
    expect(ids(m, 3)).toEqual([2]);
  });

  it("applies caps nearest-first and overflows to the next bucket", () => {
    const buffer = new VehicleBuffer(10);
    // six vehicles that all want LOD0 (size >= 200px): distances 4..9 m
    fill(buffer, [9, 4, 8, 5, 7, 6]);
    const m = new VehicleLodManager(10, config);
    const stats = m.update(buffer, camera());
    expect(stats.counts[0]).toBe(2);
    expect(stats.counts[1]).toBe(3);
    expect(stats.counts[2]).toBe(1);
    expect(ids(m, 0)).toEqual([1, 3]); // the two nearest (4 m and 5 m)
    expect(ids(m, 2)).toEqual([0]); // the farthest (9 m)
  });

  it("keeps a vehicle in its bucket inside the hysteresis band", () => {
    const buffer = new VehicleBuffer(1);
    const m = new VehicleLodManager(1, config);
    fill(buffer, [10]); // 200 px: enters LOD0? needs >= 200·1.1 from a worse bucket; first frame has no current bucket
    m.update(buffer, camera());
    expect(m.stats.counts[0]).toBe(1);
    buffer.z[0] = -10.5; // 190 px: below 200 but above 200·0.9 = 180 -> stays LOD0
    m.update(buffer, camera());
    expect(m.stats.counts[0]).toBe(1);
    buffer.z[0] = -11.5; // 174 px: below 180 -> leaves to LOD1
    m.update(buffer, camera());
    expect(m.stats.counts).toEqual([0, 1, 0, 0, 0]);
    buffer.z[0] = -9.5; // 210 px: above 200 but below 220 -> stays LOD1
    m.update(buffer, camera());
    expect(m.stats.counts[1]).toBe(1);
    buffer.z[0] = -9; // 222 px -> back to LOD0
    m.update(buffer, camera());
    expect(m.stats.counts[0]).toBe(1);
  });

  it("keeps an incumbent in a full bucket unless the newcomer is clearly larger", () => {
    const cfg: LodConfig = { ...config, caps: [1, 100, 100, 1000] };
    const buffer = new VehicleBuffer(2);
    const m = new VehicleLodManager(2, cfg);
    fill(buffer, [8, 100]); // vehicle 0 takes LOD0 (250 px); vehicle 1 far away
    m.update(buffer, camera());
    expect(ids(m, 0)).toEqual([0]);
    buffer.z[1] = -7.9; // vehicle 1 now 1.3 % larger than vehicle 0: not enough to evict
    m.update(buffer, camera());
    expect(ids(m, 0)).toEqual([0]);
    buffer.z[1] = -6.5; // 23 % larger: takes the slot
    m.update(buffer, camera());
    expect(ids(m, 0)).toEqual([1]);
  });

  it("scales caps for adaptive LOD without touching the box bucket", () => {
    const cfg: LodConfig = { ...config, caps: [10, 10, 10, 10] };
    const buffer = new VehicleBuffer(20);
    fill(
      buffer,
      Array.from({ length: 20 }, (_, i) => 6 + i * 0.1),
    ); // all LOD0-sized
    const m = new VehicleLodManager(20, cfg);
    m.update(buffer, camera());
    expect(m.stats.counts[0]).toBe(10);
    m.setCapScale(0.5);
    m.update(buffer, camera());
    expect(m.stats.counts[0]).toBe(5);
    expect(m.stats.counts.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("puts sub-threshold but visible vehicles in the box bucket", () => {
    const buffer = new VehicleBuffer(2);
    fill(buffer, [1500, 3500]); // 1.33 px and 0.57 px: box, box
    const m = new VehicleLodManager(2, config);
    m.update(buffer, camera());
    expect(m.stats.counts[BUCKET_BOX]).toBe(2);
  });
});
