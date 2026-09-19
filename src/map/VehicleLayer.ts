/**
 * MapLibre custom layer (renderingMode "3d") that draws the vehicle set and, optionally,
 * the city's 3D Tiles with Three.js on MapLibre's own WebGL2 context, sharing its depth
 * buffer (docs/architecture.md §C, docs/coordinates.md §4–5).
 *
 * Per frame:
 *   1. VP = MapLibre's defaultProjectionData.mainMatrix (Mercator [0..1] → clip, float64)
 *          × LocalFrame.modelMatrix (local metres → Mercator, float64)
 *      computed in float64. The Three camera gets projection = VP · T(eye) and
 *      view = T(−eye), so projection · view = VP while camera.position and fov stay
 *      meaningful for 3d-tiles-renderer's error metric.
 *   2. eye position and frustum for the LOD manager are derived from VP.
 *   3. VehicleLodRenderer.update buckets and draws; tiles update; renderer.resetState()
 *      keeps MapLibre's GL state intact.
 */

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { DirectionalLight, HemisphereLight, Matrix4, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { LodConfig } from "@/config/lodConfig.ts";
import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import type { HeightFieldData } from "@/geo/HeightField.ts";
import type { LodCamera } from "@/lod/VehicleLodManager.ts";
import type { LodPrimitive } from "@/rendering/assets/loadVehicleLod.ts";
import { VehicleLodRenderer } from "@/rendering/VehicleLodRenderer.ts";
import { BUCKET_BOX, BUCKET_CULLED, LOD_BUCKET_COUNT } from "@/config/lodConfig.ts";
import { CityTiles, type TilesetConfig, type TilesStats } from "./CityTiles.ts";
import { multiplyMat4, type LocalFrame } from "@/geo/coordinateSystem.ts";
import { eyeFromViewProjection, rayFromViewProjection } from "./projectionMath.ts";

export interface VehicleLayerOptions {
  id?: string;
  frame: LocalFrame;
  buffer: VehicleBuffer;
  lods: LodPrimitive[][];
  config: LodConfig;
  /** optional 3D Tiles buildings placed at the frame origin */
  tileset?: TilesetConfig;
  /** "local": bucket on this thread each frame; "external": apply lists given via applyBuckets */
  lodMode?: "local" | "external";
  /** called every frame with the camera in local metres (forwarded to the traffic worker) */
  onCamera?: (camera: LodCamera) => void;
  /** terrain grid: vehicles tilt to the ground slope (see InstancedVehicleMaterial) */
  heightField?: HeightFieldData;
}

export interface VehicleRenderInfo {
  bucket: number;
  bucketName: string;
  /** metres from the eye */
  distance: number;
  /** projected bounding-sphere diameter in pixels (the LOD selection metric) */
  sizePx: number;
  /** cost of one instance in the current bucket */
  triangles: number;
  vertices: number;
  /** material primitives drawn (one draw call each per bucket) */
  primitives: string[];
}

export interface ExternalBuckets {
  counts: ArrayLike<number>;
  culled: number;
  outsideFrustum: number;
  ids: Float32Array;
  offsets: ArrayLike<number>;
}

export interface VehicleLayerFrameStats {
  drawCalls: number;
  triangles: number;
  lodCounts: number[];
  culled: number;
  outsideFrustum: number;
  bucketingMs: number;
  renderMs: number;
  tiles: TilesStats | null;
}

export class VehicleLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  readonly frame: LocalFrame;
  /** simulation time (seconds) to render at; set by the owner before triggerRepaint */
  renderTime = 0;
  readonly stats: VehicleLayerFrameStats = {
    drawCalls: 0,
    triangles: 0,
    lodCounts: [0, 0, 0, 0, 0],
    culled: 0,
    outsideFrustum: 0,
    bucketingMs: 0,
    renderMs: 0,
    tiles: null,
  };
  /** Debug: set true to record the raw MapLibre matrices each frame (allocates; dev only). */
  captureMatrices = false;
  lastMatrices: { mvp: number[]; main: number[]; fov: number } = { mvp: [], main: [], fov: 0 };

  private readonly buffer: VehicleBuffer;
  private readonly lods: LodPrimitive[][];
  private readonly config: LodConfig;
  private readonly tilesetConfig: TilesetConfig | null;
  private readonly lodMode: "local" | "external";
  private readonly onCamera: ((camera: LodCamera) => void) | null;
  private readonly heightField: HeightFieldData | null;
  private pendingBuckets: ExternalBuckets | null = null;
  private lastBuckets: ExternalBuckets | null = null;
  private readonly model: Float64Array;
  private readonly vp64 = new Float64Array(16);
  private readonly vp = new Matrix4();
  private readonly eye = { x: 0, y: 0, z: 0 };
  private readonly eyeTranslation = new Matrix4();
  private readonly scene = new Scene();
  // matrices are overwritten every frame; PerspectiveCamera only so fov/position exist for tiles
  private readonly camera = new PerspectiveCamera(60, 1, 1, 1e5);
  private map: MapLibreMap | null = null;
  private renderer: WebGLRenderer | null = null;
  private vehicles: VehicleLodRenderer | null = null;
  private tiles: CityTiles | null = null;

  constructor(opts: VehicleLayerOptions) {
    this.id = opts.id ?? "vehicles";
    this.frame = opts.frame;
    this.buffer = opts.buffer;
    this.lods = opts.lods;
    this.config = opts.config;
    this.tilesetConfig = opts.tileset ?? null;
    this.lodMode = opts.lodMode ?? "local";
    this.onCamera = opts.onCamera ?? null;
    this.heightField = opts.heightField ?? null;
    this.model = opts.frame.modelMatrix() as Float64Array;
    this.camera.matrixAutoUpdate = false;
    this.scene.add(new HemisphereLight(0xdfe8ff, 0x4a4640, 1.0));
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 1, 0.6);
    this.scene.add(sun);
  }

  get lodRenderer(): VehicleLodRenderer | null {
    return this.vehicles;
  }

  get cityTiles(): CityTiles | null {
    return this.tiles;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.vehicles = new VehicleLodRenderer({
      capacity: this.buffer.capacity,
      config: this.config,
      lods: this.lods,
    });
    if (this.heightField) this.vehicles.setHeightField(this.heightField);
    this.vehicles.uploadAttributes(this.buffer);
    this.vehicles.pushSnapshot(this.buffer, this.renderTime);
    this.vehicles.setSelected(this.selectedId);
    this.scene.add(this.vehicles.group);
    if (this.tilesetConfig) {
      this.tiles = new CityTiles(this.tilesetConfig, this.frame.origin, this.renderer);
      this.scene.add(this.tiles.group);
    }
  }

  onRemove(): void {
    this.tiles?.dispose();
    this.tiles = null;
    this.vehicles?.dispose();
    this.vehicles = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  /** Forward a new simulation snapshot (call at the data rate). */
  pushSnapshot(time: number): void {
    this.vehicles?.pushSnapshot(this.buffer, time);
  }

  uploadAttributes(): void {
    this.vehicles?.uploadAttributes(this.buffer);
  }

  /** Upload a packed snapshot produced by the traffic worker. */
  pushPacked(packed: Float32Array, time: number): void {
    this.vehicles?.state.pushPacked(packed, time);
  }

  /** Provide bucket lists produced elsewhere (external LOD mode); applied on the next render. */
  applyBuckets(buckets: ExternalBuckets): void {
    this.pendingBuckets = buckets;
    this.lastBuckets = buckets;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const renderer = this.renderer;
    const vehicles = this.vehicles;
    const map = this.map;
    if (!renderer || !vehicles || !map) return;
    const t0 = performance.now();

    if (this.captureMatrices) {
      this.lastMatrices = {
        mvp: Array.from(options.modelViewProjectionMatrix),
        main: Array.from(options.defaultProjectionData.mainMatrix),
        fov: options.fov,
      };
    }
    // defaultProjectionData.mainMatrix maps Mercator [0..1] coordinates to clip space
    // (modelViewProjectionMatrix expects world-pixel units instead).
    multiplyMat4(options.defaultProjectionData.mainMatrix, this.model, this.vp64);
    this.vp.fromArray(this.vp64);
    eyeFromViewProjection(this.vp, this.eye);
    const canvas = map.getCanvas();
    const fov = options.fov > Math.PI ? (options.fov * Math.PI) / 180 : options.fov; // radians expected
    const focalPx = canvas.height / (2 * Math.tan(fov / 2));

    const camera = this.camera;
    const eye = this.eye;
    camera.position.set(eye.x, eye.y, eye.z);
    camera.matrixWorld.makeTranslation(eye.x, eye.y, eye.z);
    camera.matrixWorldInverse.makeTranslation(-eye.x, -eye.y, -eye.z);
    this.eyeTranslation.makeTranslation(eye.x, eye.y, eye.z);
    camera.projectionMatrix.multiplyMatrices(this.vp, this.eyeTranslation);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.fov = (fov * 180) / Math.PI;
    camera.aspect = canvas.width / canvas.height;
    camera.near = options.nearZ;
    camera.far = options.farZ;

    vehicles.setCamera(this.vp, eye.x, eye.y, eye.z, focalPx);
    this.onCamera?.(vehicles.lodCamera);
    if (this.lodMode === "local") {
      vehicles.update(this.buffer, this.renderTime);
    } else {
      const pending = this.pendingBuckets;
      const last = this.lastBuckets;
      if (last)
        vehicles.updateWithBuckets(pending ? pending.counts : null, last.ids, last.offsets, this.renderTime);
      else vehicles.updateWithBuckets(null, new Float32Array(0), [], this.renderTime);
      this.pendingBuckets = null;
    }
    if (this.tiles) {
      this.tiles.update(camera, renderer);
      this.stats.tiles = this.tiles.stats;
    }

    renderer.resetState();
    renderer.info.reset();
    renderer.render(this.scene, camera);

    const s = this.stats;
    s.drawCalls = renderer.info.render.calls;
    s.triangles = renderer.info.render.triangles;
    if (this.lodMode === "local") {
      for (let i = 0; i < s.lodCounts.length; i++) s.lodCounts[i] = vehicles.manager.stats.counts[i] ?? 0;
      s.culled = vehicles.manager.stats.culled;
      s.outsideFrustum = vehicles.manager.stats.outsideFrustum;
      s.bucketingMs = vehicles.manager.stats.updateMs;
    } else if (this.lastBuckets) {
      for (let i = 0; i < s.lodCounts.length; i++) s.lodCounts[i] = this.lastBuckets.counts[i] ?? 0;
      s.culled = this.lastBuckets.culled;
      s.outsideFrustum = this.lastBuckets.outsideFrustum;
      s.bucketingMs = 0;
    }
    s.renderMs = performance.now() - t0;
  }

  private selectedId = -1;

  /** Draw one vehicle in the highlight colour (−1 clears). */
  setSelected(id: number): void {
    this.selectedId = id;
    this.vehicles?.setSelected(id);
  }

  /** Rendering facts about one vehicle as of the last frame (spec §2 "inspect"). */
  inspect(id: number): VehicleRenderInfo | null {
    const vehicles = this.vehicles;
    if (!vehicles || id < 0 || id >= this.buffer.count) return null;
    let bucket = BUCKET_CULLED;
    if (this.lodMode === "local") {
      bucket = vehicles.manager.bucketOf(id);
    } else if (this.lastBuckets) {
      const { counts, ids, offsets } = this.lastBuckets;
      for (let b = 0; b < LOD_BUCKET_COUNT && bucket === BUCKET_CULLED; b++) {
        const start = offsets[b] ?? 0;
        const n = counts[b] ?? 0;
        for (let k = start; k < start + n; k++) {
          if (ids[k] === id) {
            bucket = b;
            break;
          }
        }
      }
    }
    const dx = (this.buffer.x[id] as number) - this.eye.x;
    const dy = (this.buffer.y[id] as number) - this.eye.y;
    const dz = (this.buffer.z[id] as number) - this.eye.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const focal = vehicles.lodCamera.focalPx;
    const r = this.config.boundingRadius;
    const sizePx = distance > r ? (2 * r * focal) / distance : Infinity;
    const geometry = bucket < LOD_BUCKET_COUNT ? vehicles.bucketGeometry[bucket] : undefined;
    return {
      bucket,
      bucketName: bucket === BUCKET_CULLED ? "culled" : bucket === BUCKET_BOX ? "box" : `LOD${bucket}`,
      distance,
      sizePx,
      triangles: geometry?.triangles ?? 0,
      vertices: geometry?.vertices ?? 0,
      primitives: geometry?.primitives ?? [],
    };
  }

  /**
   * Axis-aligned box (local metres) covering where the current view meets the ground,
   * limited to `maxDistance` from the eye: the four frustum corner rays are intersected
   * with y = 0 (or cut at maxDistance when they miss the ground), plus the eye's own
   * ground point. Used for network viewport subscriptions.
   */
  viewportGroundBox(maxDistance: number, out = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }): typeof out {
    const eye = this.eye;
    let minX = eye.x;
    let maxX = eye.x;
    let minZ = eye.z;
    let maxZ = eye.z;
    const origin = { x: 0, y: 0, z: 0 };
    const dir = { x: 0, y: 0, z: 0 };
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      rayFromViewProjection(this.vp, nx, ny, origin, dir);
      let t = maxDistance;
      if (dir.y < -1e-6) t = Math.min(t, -origin.y / dir.y);
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
    out.minX = minX;
    out.maxX = maxX;
    out.minZ = minZ;
    out.maxZ = maxZ;
    return out;
  }

  /** Debug: project a local-metre point with the last frame's matrix; returns NDC and w. */
  projectLocal(x: number, y: number, z: number): { ndcX: number; ndcY: number; ndcZ: number; w: number } {
    const e = this.vp.elements;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return { ndcX: cx / w, ndcY: cy / w, ndcZ: cz / w, w };
  }

  /**
   * Pick the vehicle nearest to a screen point (CSS pixels), or −1. Tests every vehicle
   * against the pick ray; 100k tests is well under a millisecond.
   */
  pick(clientX: number, clientY: number, radiusMetres = this.config.boundingRadius): number {
    const map = this.map;
    if (!map) return -1;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const origin = { x: 0, y: 0, z: 0 };
    const dir = { x: 0, y: 0, z: 0 };
    rayFromViewProjection(this.vp, ndcX, ndcY, origin, dir);
    const { x, y, z } = this.buffer;
    let best = -1;
    let bestT = Number.POSITIVE_INFINITY;
    const r2 = radiusMetres * radiusMetres;
    for (let i = 0; i < this.buffer.count; i++) {
      const px = (x[i] as number) - origin.x;
      const py = (y[i] as number) + 0.65 - origin.y; // roughly the body centre height
      const pz = (z[i] as number) - origin.z;
      const t = px * dir.x + py * dir.y + pz * dir.z;
      if (t <= 0 || t >= bestT) continue;
      const cx = px - dir.x * t;
      const cy = py - dir.y * t;
      const cz = pz - dir.z * t;
      if (cx * cx + cy * cy + cz * cz <= r2) {
        best = i;
        bestT = t;
      }
    }
    return best;
  }
}
