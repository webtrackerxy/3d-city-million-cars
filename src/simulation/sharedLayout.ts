/**
 * Shared-memory layout between the main thread and the traffic worker (phase C4).
 *
 * Four SharedArrayBuffers:
 *   state   VehicleBuffer backing store (SoA, worker writes, main reads for picking)
 *   packed  two slots of RGBA32F (x, y, z, heading) snapshots for the GPU state texture
 *   buckets two slots of LOD bucket id lists (Float32) laid out per bucket capacity
 *   meta    Int32 control words written with Atomics (sequence numbers, slots, timings)
 *
 * Producer protocol: write the data slot, then Atomics.store the sequence word. Consumer:
 * Atomics.load the sequence; if it changed, read the slot named in the meta block.
 */

import { LOD_BUCKET_COUNT } from "@/config/lodConfig.ts";

export const META_WORDS = 32;
export const META = {
  snapshotSeq: 0,
  snapshotSlot: 1,
  snapshotTimeMs: 2,
  tickMicros: 3,
  bucketSeq: 4,
  bucketSlot: 5,
  bucketMicros: 6,
  running: 7,
  /** counts for slot 0 start here, slot 1 at countsBase + LOD_BUCKET_COUNT + 1 */
  countsBase: 8,
  countsStride: LOD_BUCKET_COUNT + 2, // LOD counts + culled + outsideFrustum
} as const;

export interface SharedLayout {
  capacity: number;
  /** bucket capacities LOD0..LOD3 and box (= capacity) */
  caps: number[];
  /** offset of each bucket's ids inside one bucket slot */
  bucketOffsets: number[];
  /** floats per bucket slot */
  bucketSlotSize: number;
  /** floats per packed snapshot slot (capacity × 4) */
  packedSlotSize: number;
}

export function computeLayout(capacity: number, lodCaps: readonly number[]): SharedLayout {
  const caps = [...lodCaps.slice(0, LOD_BUCKET_COUNT - 1), capacity];
  const bucketOffsets: number[] = [];
  let total = 0;
  for (const cap of caps) {
    bucketOffsets.push(total);
    total += cap;
  }
  return { capacity, caps, bucketOffsets, bucketSlotSize: total, packedSlotSize: capacity * 4 };
}

export function countsIndex(slot: number, bucket: number): number {
  return META.countsBase + slot * META.countsStride + bucket;
}
