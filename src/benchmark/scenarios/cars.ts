/**
 * Benchmarks 3 and 4 (spec §35): the real car meshes.
 *
 * - cars-lod3: every vehicle drawn with the LOD3 mesh (no LOD selection) — confirms the
 *   triangle budget with the real asset.
 * - cars-lod: full bucketed LOD set through VehicleLodRenderer, caps and thresholds from
 *   the config (overridable with ?cap0=..&cap3=.. and ?px0=..&px4=..).
 */

import { Color, DirectionalLight, HemisphereLight } from "three";
import { BUCKET_BOX, DEFAULT_LOD_CONFIG, LOD_BUCKET_COUNT, type LodConfig } from "@/config/lodConfig.ts";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { loadManifest, vehicleAssetUrl } from "@/data/loadManifest.ts";
import { loadVehicleLod, type LodPrimitive } from "@/rendering/assets/loadVehicleLod.ts";
import { VehicleLodRenderer } from "@/rendering/VehicleLodRenderer.ts";
import { SyntheticTraffic } from "@/simulation/SyntheticTraffic.ts";
import { applyCameraPreset } from "../cameras.ts";
import type { Scenario, ScenarioContext, ScenarioHandle, ScenarioParams } from "../types.ts";

const VEHICLE = "porsche";

function addLights(ctx: ScenarioContext): void {
  ctx.scene.add(new HemisphereLight(0xdfe8ff, 0x3a3630, 0.9));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(400, 800, 450);
  ctx.scene.add(sun);
  ctx.scene.background = new Color(0x9fb4c8);
}

async function loadLods(variant: "raw" | "optimized"): Promise<LodPrimitive[][]> {
  const manifest = await loadManifest(VEHICLE);
  const lods: LodPrimitive[][] = [];
  for (const lod of manifest.lods) {
    const file = variant === "optimized" && lod.optimized ? lod.optimized.file : lod.file;
    const loaded = await loadVehicleLod(vehicleAssetUrl(VEHICLE, file));
    lods[lod.id] = loaded.primitives;
  }
  return lods;
}

function configFromParams(params: ScenarioParams): LodConfig {
  const caps = [...DEFAULT_LOD_CONFIG.caps] as [number, number, number, number];
  const minPixels = [...DEFAULT_LOD_CONFIG.minPixels] as [number, number, number, number, number];
  for (let i = 0; i < 4; i++) {
    const v = params[`cap${i}`];
    if (typeof v === "number") caps[i] = v;
  }
  for (let i = 0; i < 5; i++) {
    const v = params[`px${i}`];
    if (typeof v === "number") minPixels[i] = v;
  }
  return { ...DEFAULT_LOD_CONFIG, caps, minPixels };
}

function makeHandle(ctx: ScenarioContext, lods: LodPrimitive[][], config: LodConfig): ScenarioHandle {
  const count = ctx.params.count;
  const buffer = new VehicleBuffer(count);
  const traffic = new SyntheticTraffic(buffer, { count, areaSize: 3000, seed: 7 });
  traffic.start();
  const renderer = new VehicleLodRenderer({ capacity: count, config, lods });
  renderer.uploadAttributes(buffer);
  let simTime = 0;
  renderer.pushSnapshot(buffer, simTime);
  ctx.scene.add(renderer.group);

  let bucketMs = 0;
  let frames = 0;
  let uploads = 0;
  const counts = new Array<number>(LOD_BUCKET_COUNT).fill(0);
  return {
    update(dt) {
      const ticks = traffic.tick(dt);
      simTime += dt;
      if (ticks > 0) {
        renderer.pushSnapshot(buffer, simTime);
        uploads++;
      }
      renderer.setCameraFromThree(ctx.camera, ctx.renderer.domElement.height);
      renderer.update(buffer, simTime - traffic.tickInterval);
      bucketMs += renderer.manager.stats.updateMs;
      frames++;
      for (let b = 0; b < LOD_BUCKET_COUNT; b++) counts[b] = renderer.manager.stats.counts[b] ?? 0;
    },
    stats: () => ({
      lod0: counts[0] ?? 0,
      lod1: counts[1] ?? 0,
      lod2: counts[2] ?? 0,
      lod3: counts[3] ?? 0,
      box: counts[BUCKET_BOX] ?? 0,
      culled: renderer.manager.stats.culled,
      bucketingMsPerFrame: +(bucketMs / Math.max(1, frames)).toFixed(3),
      estimatedTriangles: renderer.manager.triangleEstimate(renderer.trianglesPerBucket),
      snapshotUploads: uploads,
    }),
    dispose() {
      traffic.dispose();
      renderer.dispose();
    },
  };
}

export const carsLod3: Scenario = {
  id: "cars-lod3",
  title: "Benchmark 3: all cars at LOD3",
  description:
    "Every vehicle drawn with the LOD3 mesh (830 tris) via the state texture; heading and tint per instance. No LOD selection.",
  defaults: { count: 100000, view: "city" },
  async setup(ctx): Promise<ScenarioHandle> {
    addLights(ctx);
    applyCameraPreset(ctx.camera, ctx.params.view);
    const lods = await loadLods("optimized");
    const lod3 = lods[3] ?? [];
    // one bucket only: everything that is visible goes to LOD3
    const config: LodConfig = {
      ...DEFAULT_LOD_CONFIG,
      minPixels: [1e9, 1e9, 1e9, 0, 0],
      caps: [0, 0, 0, ctx.params.count],
    };
    return makeHandle(ctx, [[], [], [], lod3], config);
  },
};

export const carsLod: Scenario = {
  id: "cars-lod",
  title: "Benchmark 4: bucketed LOD set",
  description:
    "VehicleLodRenderer with projected-size buckets, hysteresis and nearest-first caps (cap0..cap3, px0..px4 params). Far field as boxes.",
  defaults: { count: 100000, view: "city" },
  async setup(ctx): Promise<ScenarioHandle> {
    addLights(ctx);
    applyCameraPreset(ctx.camera, ctx.params.view);
    const lods = await loadLods("optimized");
    return makeHandle(ctx, lods, configFromParams(ctx.params));
  },
};
