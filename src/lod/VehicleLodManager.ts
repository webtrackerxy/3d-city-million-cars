/**
 * Runtime LOD selection (spec §28, §29, §34, §37): assigns every vehicle to a bucket
 * (LOD0..LOD3, far-field box, or culled) from its projected size on screen, with
 * hysteresis and nearest-first caps, and writes per-bucket vehicle-id lists that the
 * renderer feeds to instanced draws.
 *
 * Pure typed-array code: no Three.js dependency, no allocation per update, O(n):
 *
 *   pass 1   per vehicle: frustum test, projected size, desired bucket (with hysteresis
 *            against the bucket it had last frame), log-size bin; global bin histogram
 *   ordering counting sort of visible vehicles by bin, largest first
 *   pass 2   walk vehicles largest-first; each takes its desired bucket or the next one
 *            with free capacity, so caps fill nearest-first (ties within a bin, about a
 *            3 % size band, resolve by vehicle index). A vehicle that already held a
 *            bucket last frame is sorted one bin (~3 %) larger than it is, so a newcomer
 *            must be clearly bigger to displace it: hysteresis at the cap boundary.
 */

import { BUCKET_BOX, BUCKET_CULLED, LOD_BUCKET_COUNT, type LodConfig } from "@/config/lodConfig.ts";
import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";

const BIN_COUNT = 256;
const BIN_MIN_PX = 0.25;
const BIN_MAX_PX = 16384;
const LOG_MIN = Math.log2(BIN_MIN_PX);
const LOG_RANGE = Math.log2(BIN_MAX_PX) - LOG_MIN;

export interface LodCamera {
  /** camera position in the vehicles' coordinate frame */
  x: number;
  y: number;
  z: number;
  /** six frustum planes as (nx, ny, nz, d) with n·p + d ≥ 0 inside */
  planes: Float32Array;
  /** pixels per metre at 1 m distance: viewportHeight / (2 · tan(fov/2)) */
  focalPx: number;
}

export interface LodBucket {
  ids: Float32Array;
  count: number;
  capacity: number;
}

export interface LodStats {
  counts: number[];
  /** vehicles not drawn: outside the frustum, below the smallest threshold, or overflowed every bucket */
  culled: number;
  outsideFrustum: number;
  updateMs: number;
}

export class VehicleLodManager {
  readonly buckets: LodBucket[];
  readonly stats: LodStats = {
    counts: new Array<number>(LOD_BUCKET_COUNT).fill(0),
    culled: 0,
    outsideFrustum: 0,
    updateMs: 0,
  };
  /** current bucket per vehicle, for hysteresis (BUCKET_CULLED when never seen) */
  private readonly current: Uint8Array;
  private readonly bin: Uint8Array;
  private readonly desired: Uint8Array;
  private readonly order: Uint32Array;
  private readonly histogram = new Uint32Array(BIN_COUNT);
  private readonly offsets = new Uint32Array(BIN_COUNT);
  private readonly caps: number[];
  /** bins of size advantage given to incumbents at a cap boundary */
  capHysteresisBins = 1;
  /** multiplier applied to all caps (adaptive LOD, spec §37); 1 = configured caps */
  private capScale = 1;
  private readonly effectiveCaps: number[];

  constructor(
    readonly capacity: number,
    readonly config: LodConfig,
  ) {
    this.caps = [...config.caps, capacity];
    this.effectiveCaps = [...this.caps];
    this.buckets = this.caps.map((cap) => ({ ids: new Float32Array(cap), count: 0, capacity: cap }));
    this.current = new Uint8Array(capacity).fill(BUCKET_CULLED);
    this.bin = new Uint8Array(capacity);
    this.desired = new Uint8Array(capacity);
    this.order = new Uint32Array(capacity);
  }

  /** Scale the LOD0..LOD3 caps (0.1–1); the box bucket is never scaled. */
  setCapScale(scale: number): void {
    this.capScale = Math.min(1, Math.max(0.1, scale));
    for (let k = 0; k < LOD_BUCKET_COUNT - 1; k++) {
      this.effectiveCaps[k] = Math.max(1, Math.round((this.caps[k] as number) * this.capScale));
    }
  }

  get currentCapScale(): number {
    return this.capScale;
  }

  update(buffer: VehicleBuffer, cam: LodCamera): LodStats {
    const t0 = performance.now();
    const n = buffer.count;
    const { x: px, y: py, z: pz } = buffer;
    const { minPixels, hysteresis, boundingRadius: r } = this.config;
    const planes = cam.planes;
    const hist = this.histogram;
    const desired = this.desired;
    const bins = this.bin;
    const current = this.current;
    hist.fill(0);
    let outside = 0;
    let visible = 0;

    // pass 1
    for (let i = 0; i < n; i++) {
      const vx = px[i] as number;
      const vy = py[i] as number;
      const vz = pz[i] as number;
      let inside = true;
      for (let k = 0; k < 24; k += 4) {
        if (
          (planes[k] as number) * vx +
            (planes[k + 1] as number) * vy +
            (planes[k + 2] as number) * vz +
            (planes[k + 3] as number) <
          -r
        ) {
          inside = false;
          break;
        }
      }
      if (!inside) {
        desired[i] = BUCKET_CULLED;
        current[i] = BUCKET_CULLED;
        outside++;
        continue;
      }
      const dx = vx - cam.x;
      const dy = vy - cam.y;
      const dz = vz - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const size = dist > r ? (2 * r * cam.focalPx) / dist : BIN_MAX_PX;

      let raw = BUCKET_CULLED;
      for (let k = 0; k < LOD_BUCKET_COUNT; k++) {
        if (size >= (minPixels[k] as number)) {
          raw = k;
          break;
        }
      }
      const cur = current[i] as number;
      let want = raw;
      if (cur < BUCKET_CULLED) {
        if (raw < cur) {
          // promotion needs the size above the enter threshold of the better bucket
          if (size < (minPixels[raw] as number) * (1 + hysteresis)) want = cur;
        } else if (raw > cur) {
          // demotion needs the size below the leave threshold of the current bucket
          if (size >= (minPixels[cur] as number) * (1 - hysteresis)) want = cur;
        }
      }
      desired[i] = want;
      if (want === BUCKET_CULLED) {
        current[i] = BUCKET_CULLED;
        continue;
      }
      let b = ((Math.log2(size) - LOG_MIN) / LOG_RANGE) * BIN_COUNT;
      // incumbency bonus: staying in the same bucket sorts ~3 % larger (cap hysteresis)
      if (cur === want) b += this.capHysteresisBins;
      b = b < 0 ? 0 : b >= BIN_COUNT ? BIN_COUNT - 1 : b;
      const bi = b | 0;
      bins[i] = bi;
      hist[bi] = (hist[bi] as number) + 1;
      visible++;
    }

    // counting sort: largest bin first
    const offsets = this.offsets;
    let acc = 0;
    for (let b = BIN_COUNT - 1; b >= 0; b--) {
      offsets[b] = acc;
      acc += hist[b] as number;
    }
    const order = this.order;
    for (let i = 0; i < n; i++) {
      if ((desired[i] as number) === BUCKET_CULLED) continue;
      const bi = bins[i] as number;
      order[offsets[bi] as number] = i;
      offsets[bi] = (offsets[bi] as number) + 1;
    }

    // pass 2: largest first, spill to the next bucket with capacity
    const buckets = this.buckets;
    const caps = this.effectiveCaps;
    for (const bucket of buckets) bucket.count = 0;
    let overflowCulled = 0;
    for (let o = 0; o < visible; o++) {
      const i = order[o] as number;
      let b = desired[i] as number;
      while (b < LOD_BUCKET_COUNT && (buckets[b] as LodBucket).count >= (caps[b] as number)) b++;
      if (b >= LOD_BUCKET_COUNT) {
        current[i] = BUCKET_CULLED;
        overflowCulled++;
        continue;
      }
      const bucket = buckets[b] as LodBucket;
      bucket.ids[bucket.count++] = i;
      current[i] = b;
    }

    const stats = this.stats;
    for (let k = 0; k < LOD_BUCKET_COUNT; k++) stats.counts[k] = (buckets[k] as LodBucket).count;
    stats.culled = n - visible + overflowCulled;
    stats.outsideFrustum = outside;
    stats.updateMs = performance.now() - t0;
    return stats;
  }

  /** Bucket the vehicle was assigned to in the last update (BUCKET_CULLED if not drawn). */
  bucketOf(id: number): number {
    return id >= 0 && id < this.capacity ? (this.current[id] as number) : BUCKET_CULLED;
  }

  /** Approximate triangles submitted for the current assignment, given triangles per bucket. */
  triangleEstimate(trianglesPerBucket: readonly number[]): number {
    let total = 0;
    for (let k = 0; k < LOD_BUCKET_COUNT; k++)
      total += (this.buckets[k] as LodBucket).count * (trianglesPerBucket[k] ?? 0);
    return total;
  }
}

export { BUCKET_BOX };
