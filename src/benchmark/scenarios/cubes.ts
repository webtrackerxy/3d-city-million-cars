/**
 * Benchmarks 1 and 2 (spec §35): 100k cubes, static; moving via CPU matrix updates
 * (the path we want to avoid, measured on purpose); moving via the GPU state texture.
 */

import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
} from "three";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { SyntheticTraffic } from "@/simulation/SyntheticTraffic.ts";
import { InstancedVehicleMaterial } from "@/rendering/InstancedVehicleMaterial.ts";
import { VehicleStateTexture } from "@/rendering/VehicleStateTexture.ts";
import { VehicleAttributeTexture } from "@/rendering/VehicleAttributeTexture.ts";
import { DEFAULT_LOD_CONFIG } from "@/config/lodConfig.ts";
import { applyCameraPreset } from "../cameras.ts";
import type { Scenario, ScenarioContext, ScenarioHandle } from "../types.ts";

const CAR_SIZE: [number, number, number] = [1.85, 1.3, 4.5];
const PALETTE = [0xd9d9d9, 0x1f1f1f, 0x8a8f99, 0xb3261e, 0x1f4fa3, 0xe0b53c, 0x2f6b3a, 0xffffff].map(
  (c) => new Color(c),
);

function addLights(ctx: ScenarioContext): void {
  const hemi = new HemisphereLight(0xdfe8ff, 0x3a3630, 0.9);
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(400, 800, 450);
  ctx.scene.add(hemi, sun);
  ctx.scene.background = new Color(0x9fb4c8);
}

function makeTraffic(count: number): { buffer: VehicleBuffer; traffic: SyntheticTraffic } {
  const buffer = new VehicleBuffer(count);
  const traffic = new SyntheticTraffic(buffer, { count, areaSize: 3000, seed: 7 });
  return { buffer, traffic };
}

const dummy = new Object3D();

function writeMatrices(mesh: InstancedMesh, buffer: VehicleBuffer): void {
  const { x, y, z, heading } = buffer;
  for (let i = 0; i < buffer.count; i++) {
    dummy.position.set(x[i] as number, (y[i] as number) + CAR_SIZE[1] / 2, z[i]);
    dummy.rotation.set(0, Math.PI - (heading[i] as number), 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export const cubesStatic: Scenario = {
  id: "cubes-static",
  title: "Benchmark 1: static cubes",
  description: "One InstancedMesh of car-sized boxes. Matrices uploaded once. Measures raw instancing cost.",
  defaults: { count: 100000, view: "city" },
  setup(ctx): ScenarioHandle {
    addLights(ctx);
    applyCameraPreset(ctx.camera, ctx.params.view);
    const { buffer } = makeTraffic(ctx.params.count);
    const mesh = new InstancedMesh(new BoxGeometry(...CAR_SIZE), new MeshLambertMaterial(), buffer.count);
    mesh.frustumCulled = false;
    for (let i = 0; i < buffer.count; i++) mesh.setColorAt(i, PALETTE[buffer.color[i] as number] as Color);
    writeMatrices(mesh, buffer);
    ctx.scene.add(mesh);
    return {
      update() {
        /* static */
      },
      dispose() {
        mesh.geometry.dispose();
        mesh.material.dispose();
        ctx.scene.remove(mesh);
      },
    };
  },
};

export const cubesMovingCpu: Scenario = {
  id: "cubes-moving-cpu",
  title: "Benchmark 2a: moving cubes, CPU matrices",
  description:
    "Simulation at 10 Hz, CPU interpolation every frame: one setMatrixAt per vehicle and a 64-byte-per-vehicle instanceMatrix upload each frame (6.4 MB at 100,000).",
  defaults: { count: 100000, view: "city" },
  setup(ctx): ScenarioHandle {
    addLights(ctx);
    applyCameraPreset(ctx.camera, ctx.params.view);
    const { buffer, traffic } = makeTraffic(ctx.params.count);
    traffic.start();
    const mesh = new InstancedMesh(new BoxGeometry(...CAR_SIZE), new MeshLambertMaterial(), buffer.count);
    mesh.frustumCulled = false;
    for (let i = 0; i < buffer.count; i++) mesh.setColorAt(i, PALETTE[buffer.color[i] as number] as Color);
    writeMatrices(mesh, buffer);
    ctx.scene.add(mesh);
    let cpuMs = 0;
    let frames = 0;
    return {
      update(dt) {
        traffic.tick(dt);
        const t0 = performance.now();
        writeMatrices(mesh, buffer); // no interpolation: positions jump at 10 Hz, matrices rebuilt every frame
        cpuMs += performance.now() - t0;
        frames++;
      },
      stats: () => ({ matrixUpdateMsPerFrame: +(cpuMs / Math.max(1, frames)).toFixed(3) }),
      dispose() {
        traffic.dispose();
        mesh.geometry.dispose();
        mesh.material.dispose();
        ctx.scene.remove(mesh);
      },
    };
  },
};

export const cubesMovingGpu: Scenario = {
  id: "cubes-moving-gpu",
  title: "Benchmark 2b: moving cubes, GPU state texture",
  description:
    "Simulation at 10 Hz packs (x,y,z,heading) into an RGBA32F texture, 16 bytes per vehicle (1.6 MB at 100,000); the vertex shader interpolates. Per-frame CPU work is one uniform.",
  defaults: { count: 100000, view: "city" },
  setup(ctx): ScenarioHandle {
    addLights(ctx);
    applyCameraPreset(ctx.camera, ctx.params.view);
    const { buffer, traffic } = makeTraffic(ctx.params.count);
    traffic.start();
    const state = new VehicleStateTexture(buffer.capacity);
    let simTime = 0;
    state.pushSnapshot(buffer, simTime);

    const geometry = new BoxGeometry(...CAR_SIZE);
    geometry.translate(0, CAR_SIZE[1] / 2, 0);
    const ids = new Float32Array(buffer.count);
    for (let i = 0; i < buffer.count; i++) ids[i] = i;
    geometry.setAttribute("vehicleId", new InstancedBufferAttribute(ids, 1));
    const attributes = new VehicleAttributeTexture(buffer.capacity);
    attributes.upload(buffer);
    const material = new InstancedVehicleMaterial({
      prev: state.prev,
      next: state.next,
      attributes: attributes.texture,
      texWidth: state.width,
      palette: DEFAULT_LOD_CONFIG.palette,
      tintByInstance: true,
    });
    const mesh = new InstancedMesh(geometry, material, buffer.count);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);

    let uploads = 0;
    let packMs = 0;
    return {
      update(dt) {
        const ticks = traffic.tick(dt);
        simTime += dt;
        if (ticks > 0) {
          const t0 = performance.now();
          state.pushSnapshot(buffer, simTime);
          packMs += performance.now() - t0;
          uploads++;
        }
        // render slightly behind the newest snapshot so interpolation always has a target
        material.interpolation = state.factorAt(simTime - traffic.tickInterval);
      },
      stats: () => ({
        snapshotUploads: uploads,
        packMsPerUpload: +(packMs / Math.max(1, uploads)).toFixed(3),
      }),
      dispose() {
        traffic.dispose();
        state.dispose();
        attributes.dispose();
        geometry.dispose();
        material.dispose();
        ctx.scene.remove(mesh);
      },
    };
  },
};
