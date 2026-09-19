/**
 * Triangle-budget probe: N static instances of a sphere with a chosen triangle count.
 * Sweep `tris` (per instance) at a fixed count to find the triangles-per-frame this GPU
 * sustains at 60 / 30 FPS. That number, not the spec's LOD table, sizes the LOD buckets.
 */

import {
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  SphereGeometry,
} from "three";
import { mulberry32 } from "@/simulation/SyntheticTraffic.ts";
import { applyCameraPreset } from "../cameras.ts";
import type { Scenario, ScenarioHandle } from "../types.ts";

/** sphere segments giving roughly `tris` triangles: tris ≈ 2 · w · (h − 1) with h = w/2 */
function segmentsFor(tris: number): { w: number; h: number } {
  const w = Math.max(4, Math.round(Math.sqrt(tris)));
  const h = Math.max(3, Math.round(w / 2) + 1);
  return { w, h };
}

export const triangleThroughput: Scenario = {
  id: "triangle-throughput",
  title: "Triangle throughput probe",
  description:
    "count static sphere instances × tris triangles each. Use ?tris=… to sweep the per-frame budget.",
  defaults: { count: 20000, tris: 1000, view: "city" },
  setup(ctx): ScenarioHandle {
    ctx.scene.add(new HemisphereLight(0xdfe8ff, 0x3a3630, 0.9));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(400, 800, 450);
    ctx.scene.add(sun);
    ctx.scene.background = new Color(0x9fb4c8);
    applyCameraPreset(ctx.camera, ctx.params.view);

    const tris = Number(ctx.params.tris ?? 1000);
    const { w, h } = segmentsFor(tris);
    const geometry = new SphereGeometry(1.5, w, h);
    const actualTris = (geometry.getIndex()?.count ?? 0) / 3;
    const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({ color: 0xbfc4cc }), ctx.params.count);
    mesh.frustumCulled = false;
    const rand = mulberry32(3);
    const dummy = new Object3D();
    for (let i = 0; i < ctx.params.count; i++) {
      dummy.position.set((rand() * 2 - 1) * 1500, 1.5, (rand() * 2 - 1) * 1500);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    ctx.scene.add(mesh);
    return {
      update() {
        /* static */
      },
      stats: () => ({ trianglesPerInstance: actualTris, trianglesSubmitted: actualTris * ctx.params.count }),
      dispose() {
        geometry.dispose();
        mesh.material.dispose();
        ctx.scene.remove(mesh);
      },
    };
  },
};
