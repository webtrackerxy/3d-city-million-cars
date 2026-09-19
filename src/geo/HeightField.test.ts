import { describe, expect, it } from "vitest";
import { terrariumElevation } from "@/data/terrariumTile.ts";
import { HeightField, tileCoords } from "./HeightField.ts";

describe("HeightField", () => {
  it("interpolates bilinearly and clamps at the edges", () => {
    // 3×3 grid, 10 m spacing, elevation = 100 + x/10 + 2·z/10
    const data = new Float32Array(9);
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) data[z * 3 + x] = 100 + x + 2 * z;
    const hf = new HeightField({ originX: -10, originZ: -10, spacing: 10, width: 3, height: 3, data });
    expect(hf.sample(-10, -10)).toBeCloseTo(100, 6);
    expect(hf.sample(0, 0)).toBeCloseTo(103, 6);
    expect(hf.sample(-5, -5)).toBeCloseTo(101.5, 6);
    expect(hf.sample(-500, -500)).toBeCloseTo(100, 4);
    expect(hf.sample(500, 500)).toBeCloseTo(106, 4);
  });

  it("decodes terrarium and computes tile coordinates", () => {
    expect(terrariumElevation(128, 0, 0)).toBe(0);
    expect(terrariumElevation(128, 100, 128)).toBeCloseTo(100.5, 6);
    const t = tileCoords(0, 0, 1);
    expect(t.x).toBeCloseTo(1, 9);
    expect(t.y).toBeCloseTo(1, 9);
    const hk = tileCoords(114.1594, 22.2816, 14);
    expect(Math.floor(hk.x)).toBe(13387);
    expect(Math.floor(hk.y)).toBe(7151);
  });
});
