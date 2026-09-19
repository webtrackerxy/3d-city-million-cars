import { describe, expect, it } from "vitest";
import {
  LocalFrame,
  latFromMercatorY,
  lngFromMercatorX,
  mercatorUnitsPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
  multiplyMat4,
} from "./coordinateSystem.ts";

const TOKYO = { longitude: 139.7671, latitude: 35.6812 };

describe("Mercator formulas", () => {
  it("round-trip lon/lat", () => {
    expect(lngFromMercatorX(mercatorXFromLng(TOKYO.longitude))).toBeCloseTo(TOKYO.longitude, 10);
    expect(latFromMercatorY(mercatorYFromLat(TOKYO.latitude))).toBeCloseTo(TOKYO.latitude, 10);
    expect(mercatorXFromLng(0)).toBe(0.5);
    expect(mercatorYFromLat(0)).toBeCloseTo(0.5, 12);
  });

  it("scales metres by 1/cos(lat)", () => {
    expect(mercatorUnitsPerMetre(0) * 40075016.686).toBeCloseTo(1, 9);
    expect(mercatorUnitsPerMetre(60) / mercatorUnitsPerMetre(0)).toBeCloseTo(2, 9);
  });
});

describe("LocalFrame", () => {
  const frame = new LocalFrame(TOKYO);

  it("puts the origin at local zero and east/north in the right directions", () => {
    expect(frame.lngLatToLocal(TOKYO)).toEqual({ x: 0, y: 0, z: 0 });
    const east = frame.lngLatToLocal({ longitude: TOKYO.longitude + 0.01, latitude: TOKYO.latitude });
    expect(east.x).toBeGreaterThan(0);
    expect(Math.abs(east.z)).toBeLessThan(1e-6);
    // 0.01° of longitude at 35.68° is ~904 m on the ground, but Mercator metres are
    // scaled by 1/cos(lat) relative to ground metres only away from the origin latitude;
    // at the origin the frame is true metres.
    expect(east.x).toBeCloseTo(904, -1);
    const north = frame.lngLatToLocal({ longitude: TOKYO.longitude, latitude: TOKYO.latitude + 0.01 });
    expect(north.z).toBeLessThan(0); // north is −z
    expect(Math.abs(north.z)).toBeCloseTo(1112, -1);
  });

  it("round-trips local ↔ lon/lat and local ↔ mercator", () => {
    const p = { x: 1234.5, y: 12, z: -987.25 };
    const ll = frame.localToLngLat(p);
    const back = frame.lngLatToLocal(ll);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.z).toBeCloseTo(p.z, 6);
    expect(back.y).toBeCloseTo(p.y, 9);
    const m = frame.localToMercator(p);
    const back2 = frame.mercatorToLocal(m);
    expect(back2.x).toBeCloseTo(p.x, 6);
    expect(back2.y).toBeCloseTo(p.y, 6);
    expect(back2.z).toBeCloseTo(p.z, 6);
  });

  it("modelMatrix agrees with localToMercator", () => {
    const m = frame.modelMatrix();
    const p = { x: 500, y: 20, z: -300 };
    const merc = frame.localToMercator(p);
    const x = (m[0] as number) * p.x + (m[4] as number) * p.y + (m[8] as number) * p.z + (m[12] as number);
    const y = (m[1] as number) * p.x + (m[5] as number) * p.y + (m[9] as number) * p.z + (m[13] as number);
    const z = (m[2] as number) * p.x + (m[6] as number) * p.y + (m[10] as number) * p.z + (m[14] as number);
    expect(x).toBeCloseTo(merc.x, 15);
    expect(y).toBeCloseTo(merc.y, 15);
    expect(z).toBeCloseTo(merc.z, 15);
  });

  it("keeps float64 precision: 1 m offsets survive the 0.5-range Mercator origin", () => {
    const a = frame.localToMercator({ x: 0, y: 0, z: 0 });
    const b = frame.localToMercator({ x: 1, y: 0, z: 0 });
    expect((b.x - a.x) / frame.scale).toBeCloseTo(1, 6);
  });
});

describe("multiplyMat4", () => {
  it("multiplies column-major matrices", () => {
    const t = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]); // translation
    const s = new Float64Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]); // scale
    const r = multiplyMat4(t, s);
    // (t·s) applied to (1,1,1): scale first then translate -> (7, 9, 11)
    expect([r[0], r[5], r[10], r[12], r[13], r[14]]).toEqual([2, 3, 4, 5, 6, 7]);
  });
});
