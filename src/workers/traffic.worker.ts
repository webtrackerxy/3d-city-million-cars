/**
 * Traffic worker (phase C4, spec §9 "worker architecture"): owns the road network, the
 * RoadTraffic simulation and the LOD bucketing, all over shared memory. The main thread
 * never touches per-vehicle state; it uploads packed snapshots and copies bucket id
 * lists that this worker produces.
 */

import type { LodConfig } from "@/config/lodConfig.ts";
import { LOD_BUCKET_COUNT } from "@/config/lodConfig.ts";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { LocalFrame } from "@/geo/coordinateSystem.ts";
import { HeightField, type HeightFieldData } from "@/geo/HeightField.ts";
import { VehicleLodManager, type LodCamera } from "@/lod/VehicleLodManager.ts";
import { RoadNetwork } from "@/simulation/RoadNetwork.ts";
import { RoadTraffic } from "@/simulation/RoadTraffic.ts";
import { META, countsIndex, type SharedLayout } from "@/simulation/sharedLayout.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";

export interface WorkerInitMessage {
  type: "init";
  state: SharedArrayBuffer;
  packed: SharedArrayBuffer;
  buckets: SharedArrayBuffer;
  meta: SharedArrayBuffer;
  layout: SharedLayout;
  count: number;
  tickInterval: number;
  lodConfig: LodConfig;
  /** omitted = bucket-only mode: the main thread writes vehicle state itself */
  network?: RoadNetworkFile;
  origin: { longitude: number; latitude: number };
  seed: number;
  driveOnLeft?: boolean;
  /** optional terrain: road nodes are elevated relative to the origin */
  heightField?: HeightFieldData;
}

export interface WorkerCameraMessage {
  type: "camera";
  planes: Float32Array;
  x: number;
  y: number;
  z: number;
  focalPx: number;
}

export interface WorkerRunningMessage {
  type: "running";
  running: boolean;
}

export interface WorkerCapScaleMessage {
  type: "capScale";
  scale: number;
}

export type WorkerInbound =
  WorkerInitMessage | WorkerCameraMessage | WorkerRunningMessage | WorkerCapScaleMessage;

export interface WorkerReadyMessage {
  type: "ready";
  roadKm: number;
  edges: number;
}

export interface WorkerErrorMessage {
  type: "error";
  message: string;
}

export type WorkerOutbound = WorkerReadyMessage | WorkerErrorMessage;

const scope = self as unknown as {
  postMessage(message: WorkerOutbound): void;
  onmessage: ((e: MessageEvent<WorkerInbound>) => void) | null;
};

let buffer: VehicleBuffer | null = null;
let traffic: RoadTraffic | null = null;
let lod: VehicleLodManager | null = null;
let layout: SharedLayout | null = null;
let packed: Float32Array | null = null;
let buckets: Float32Array | null = null;
let meta: Int32Array | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let simTime = 0;
let snapshotSeq = 0;
let bucketSeq = 0;
let latestCamera: WorkerCameraMessage | null = null;
let bucketScheduled = false;
const camera: LodCamera = { x: 0, y: 0, z: 0, planes: new Float32Array(24), focalPx: 1 };

function init(msg: WorkerInitMessage): void {
  layout = msg.layout;
  buffer = new VehicleBuffer(layout.capacity, msg.state);
  packed = new Float32Array(msg.packed);
  buckets = new Float32Array(msg.buckets);
  meta = new Int32Array(msg.meta);
  lod = new VehicleLodManager(layout.capacity, msg.lodConfig);
  if (!msg.network) {
    buffer.count = msg.count;
    scope.postMessage({ type: "ready", roadKm: 0, edges: 0 });
    return;
  }
  const frame = new LocalFrame(msg.origin);
  const network = new RoadNetwork(msg.network, (lon, lat) => {
    const p = frame.lngLatToLocal({ longitude: lon, latitude: lat });
    return { x: p.x, z: p.z };
  });
  if (msg.heightField) network.applyElevation(new HeightField(msg.heightField));
  traffic = new RoadTraffic(buffer, network, {
    count: msg.count,
    tickInterval: msg.tickInterval,
    seed: msg.seed,
    driveOnLeft: msg.driveOnLeft ?? false,
  });
  traffic.start();
  Atomics.store(meta, META.running, 1);
  publishSnapshot(0);
  timer = setInterval(() => {
    if (!traffic || !meta) return;
    if (Atomics.load(meta, META.running) === 1) {
      traffic.step(traffic.tickInterval);
      simTime += traffic.tickInterval;
      publishSnapshot(traffic.lastStepMs);
    }
  }, msg.tickInterval * 1000);
  scope.postMessage({ type: "ready", roadKm: network.totalLength / 1000, edges: network.edgeCount });
}

function publishSnapshot(tickMs: number): void {
  if (!buffer || !packed || !meta || !layout) return;
  const slot = (snapshotSeq + 1) % 2;
  const view = packed.subarray(slot * layout.packedSlotSize, (slot + 1) * layout.packedSlotSize);
  buffer.packStateInto(view);
  Atomics.store(meta, META.snapshotSlot, slot);
  Atomics.store(meta, META.snapshotTimeMs, Math.round(simTime * 1000));
  Atomics.store(meta, META.tickMicros, Math.round(tickMs * 1000));
  snapshotSeq++;
  Atomics.store(meta, META.snapshotSeq, snapshotSeq);
}

function runBucketing(): void {
  bucketScheduled = false;
  const cam = latestCamera;
  if (!cam || !buffer || !lod || !buckets || !meta || !layout) return;
  camera.planes.set(cam.planes);
  camera.x = cam.x;
  camera.y = cam.y;
  camera.z = cam.z;
  camera.focalPx = cam.focalPx;
  const stats = lod.update(buffer, camera);
  const slot = (bucketSeq + 1) % 2;
  const base = slot * layout.bucketSlotSize;
  for (let b = 0; b < LOD_BUCKET_COUNT; b++) {
    const bucket = lod.buckets[b];
    if (!bucket) continue;
    buckets.set(bucket.ids.subarray(0, bucket.count), base + (layout.bucketOffsets[b] as number));
    Atomics.store(meta, countsIndex(slot, b), bucket.count);
  }
  Atomics.store(meta, countsIndex(slot, LOD_BUCKET_COUNT), stats.culled);
  Atomics.store(meta, countsIndex(slot, LOD_BUCKET_COUNT + 1), stats.outsideFrustum);
  Atomics.store(meta, META.bucketSlot, slot);
  Atomics.store(meta, META.bucketMicros, Math.round(stats.updateMs * 1000));
  bucketSeq++;
  Atomics.store(meta, META.bucketSeq, bucketSeq);
}

scope.onmessage = (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init":
        init(msg);
        break;
      case "camera":
        latestCamera = msg; // coalesce: only the newest camera is bucketed
        if (!bucketScheduled) {
          bucketScheduled = true;
          setTimeout(runBucketing, 0);
        }
        break;
      case "capScale":
        lod?.setCapScale(msg.scale);
        break;
      case "running":
        if (meta) Atomics.store(meta, META.running, msg.running ? 1 : 0);
        if (traffic) {
          if (msg.running) traffic.start();
          else traffic.stop();
        }
        break;
    }
  } catch (err) {
    if (timer) clearInterval(timer);
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
