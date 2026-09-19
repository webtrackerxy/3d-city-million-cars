/**
 * Main-thread side of the traffic worker: allocates the shared buffers, starts the
 * worker, forwards camera updates and exposes the latest snapshot and bucket results
 * by polling the shared meta block (no per-frame messages back from the worker).
 */

import type { LodConfig } from "@/config/lodConfig.ts";
import { LOD_BUCKET_COUNT } from "@/config/lodConfig.ts";
import { VEHICLE_STRIDE_BYTES, VehicleBuffer } from "@/data/VehicleBuffer.ts";
import type { HeightFieldData } from "@/geo/HeightField.ts";
import type { LodCamera } from "@/lod/VehicleLodManager.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";
import type { WorkerInbound, WorkerOutbound } from "@/workers/traffic.worker.ts";
import { META, META_WORDS, computeLayout, countsIndex, type SharedLayout } from "./sharedLayout.ts";

export interface TrafficWorkerOptions {
  count: number;
  tickInterval: number;
  lodConfig: LodConfig;
  /** omitted = bucket-only worker; the main thread fills `buffer` (e.g. from the network) */
  network?: RoadNetworkFile;
  origin: { longitude: number; latitude: number };
  seed?: number;
  driveOnLeft?: boolean;
  /** terrain for road elevation; copied to the worker */
  heightField?: HeightFieldData;
  onReady?: (info: { roadKm: number; edges: number }) => void;
  onError?: (message: string) => void;
}

export interface BucketResult {
  counts: number[];
  culled: number;
  outsideFrustum: number;
  /** ids for bucket b are ids.subarray(offsets[b], offsets[b] + counts[b]) */
  ids: Float32Array;
  offsets: number[];
}

export class TrafficWorkerClient {
  readonly buffer: VehicleBuffer;
  readonly layout: SharedLayout;
  readonly tickInterval: number;
  private readonly worker: Worker;
  private readonly packed: Float32Array;
  private readonly buckets: Float32Array;
  private readonly meta: Int32Array;
  private lastSnapshotSeq = 0;
  private lastBucketSeq = 0;
  private readonly cameraMessage = {
    type: "camera" as const,
    planes: new Float32Array(24),
    x: 0,
    y: 0,
    z: 0,
    focalPx: 1,
  };
  private readonly bucketResult: BucketResult;
  /** last worker timings, milliseconds */
  tickMs = 0;
  bucketMs = 0;
  ready = false;

  constructor(opts: TrafficWorkerOptions) {
    this.layout = computeLayout(opts.count, opts.lodConfig.caps);
    this.tickInterval = opts.tickInterval;
    const state = new SharedArrayBuffer(opts.count * VEHICLE_STRIDE_BYTES);
    const packed = new SharedArrayBuffer(2 * this.layout.packedSlotSize * 4);
    const buckets = new SharedArrayBuffer(2 * this.layout.bucketSlotSize * 4);
    const meta = new SharedArrayBuffer(META_WORDS * 4);
    this.buffer = new VehicleBuffer(opts.count, state);
    this.buffer.count = opts.count;
    this.packed = new Float32Array(packed);
    this.buckets = new Float32Array(buckets);
    this.meta = new Int32Array(meta);
    this.bucketResult = {
      counts: new Array<number>(LOD_BUCKET_COUNT).fill(0),
      culled: 0,
      outsideFrustum: 0,
      ids: this.buckets.subarray(0, this.layout.bucketSlotSize),
      offsets: this.layout.bucketOffsets,
    };
    this.worker = new Worker(new URL("../workers/traffic.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerOutbound>) => {
      if (e.data.type === "ready") {
        this.ready = true;
        opts.onReady?.({ roadKm: e.data.roadKm, edges: e.data.edges });
      } else {
        opts.onError?.(e.data.message);
      }
    };
    this.worker.onerror = (e) => {
      opts.onError?.(e.message);
    };
    const init: WorkerInbound = {
      type: "init",
      state,
      packed,
      buckets,
      meta,
      layout: this.layout,
      count: opts.count,
      tickInterval: opts.tickInterval,
      lodConfig: opts.lodConfig,
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.heightField ? { heightField: opts.heightField } : {}),
      origin: opts.origin,
      seed: opts.seed ?? 11,
      driveOnLeft: opts.driveOnLeft ?? false,
    };
    // structured clone (not transfer): the scene keeps its copy for picking and network mode
    this.worker.postMessage(init);
  }

  /** Send the current camera; the worker buckets asynchronously. */
  sendCamera(cam: LodCamera): void {
    const m = this.cameraMessage;
    m.planes.set(cam.planes);
    m.x = cam.x;
    m.y = cam.y;
    m.z = cam.z;
    m.focalPx = cam.focalPx;
    this.worker.postMessage(m);
  }

  setCapScale(scale: number): void {
    const msg: WorkerInbound = { type: "capScale", scale };
    this.worker.postMessage(msg);
  }

  setRunning(on: boolean): void {
    const msg: WorkerInbound = { type: "running", running: on };
    this.worker.postMessage(msg);
  }

  /** New packed snapshot since the last call, or null. The view is valid until the next two ticks. */
  takeSnapshot(): { packed: Float32Array; time: number } | null {
    const seq = Atomics.load(this.meta, META.snapshotSeq);
    if (seq === this.lastSnapshotSeq) return null;
    this.lastSnapshotSeq = seq;
    const slot = Atomics.load(this.meta, META.snapshotSlot);
    this.tickMs = Atomics.load(this.meta, META.tickMicros) / 1000;
    const size = this.layout.packedSlotSize;
    return {
      packed: this.packed.subarray(slot * size, (slot + 1) * size),
      time: Atomics.load(this.meta, META.snapshotTimeMs) / 1000,
    };
  }

  /** New bucket assignment since the last call, or null. */
  takeBuckets(): BucketResult | null {
    const seq = Atomics.load(this.meta, META.bucketSeq);
    if (seq === this.lastBucketSeq) return null;
    this.lastBucketSeq = seq;
    const slot = Atomics.load(this.meta, META.bucketSlot);
    const r = this.bucketResult;
    for (let b = 0; b < LOD_BUCKET_COUNT; b++) r.counts[b] = Atomics.load(this.meta, countsIndex(slot, b));
    r.culled = Atomics.load(this.meta, countsIndex(slot, LOD_BUCKET_COUNT));
    r.outsideFrustum = Atomics.load(this.meta, countsIndex(slot, LOD_BUCKET_COUNT + 1));
    this.bucketMs = Atomics.load(this.meta, META.bucketMicros) / 1000;
    const size = this.layout.bucketSlotSize;
    r.ids = this.buckets.subarray(slot * size, (slot + 1) * size);
    return r;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
