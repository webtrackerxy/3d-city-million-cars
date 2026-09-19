/**
 * Draws a VehicleBuffer through the LOD manager: one instanced mesh per (bucket,
 * material primitive), all reading the same state/attribute textures, each bucket with
 * its own vehicle-id attribute rewritten from the manager's lists every update.
 *
 * Draw calls per frame = Σ primitives over non-empty buckets, independent of vehicle
 * count. No per-vehicle JavaScript objects; the id lists are Float32Arrays.
 */

import {
  BoxGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  type BufferGeometry,
  type PerspectiveCamera,
} from "three";
import { BUCKET_BOX, LOD_BUCKET_COUNT, type LodConfig } from "@/config/lodConfig.ts";
import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { TINTED_MATERIAL } from "@/types/manifest.ts";
import type { HeightFieldData } from "@/geo/HeightField.ts";
import { InstancedVehicleMaterial, type HeightFieldTexture } from "./InstancedVehicleMaterial.ts";
import { VehicleAttributeTexture } from "./VehicleAttributeTexture.ts";
import { VehicleLodManager, type LodCamera } from "@/lod/VehicleLodManager.ts";
import { VehicleStateTexture } from "./VehicleStateTexture.ts";
import type { LodPrimitive } from "./assets/loadVehicleLod.ts";

export interface VehicleLodRendererOptions {
  capacity: number;
  config: LodConfig;
  /** primitives per LOD (index 0..3); a missing LOD falls back to the next available one */
  lods: LodPrimitive[][];
  /** car-sized box for the far field, metres (w, h, l) */
  boxSize?: [number, number, number];
}

interface BucketDraw {
  ids: InstancedBufferAttribute;
  geometries: InstancedBufferGeometry[];
  meshes: Mesh[];
  triangles: number;
}

const tmpMatrix = new Matrix4();
const tmpFrustum = new Frustum();

export class VehicleLodRenderer {
  readonly group = new Group();
  readonly manager: VehicleLodManager;
  readonly state: VehicleStateTexture;
  readonly attributes: VehicleAttributeTexture;
  readonly trianglesPerBucket: number[] = [];
  /** per bucket: what one instance costs and which primitives it is drawn with */
  readonly bucketGeometry: { triangles: number; vertices: number; primitives: string[] }[] = [];
  private readonly buckets: BucketDraw[] = [];
  private readonly materials: InstancedVehicleMaterial[] = [];
  private heightField: HeightFieldTexture | null = null;
  private readonly planes = new Float32Array(24);
  private readonly camera: LodCamera = { x: 0, y: 0, z: 0, planes: this.planes, focalPx: 1 };

  constructor(opts: VehicleLodRendererOptions) {
    this.manager = new VehicleLodManager(opts.capacity, opts.config);
    this.state = new VehicleStateTexture(opts.capacity);
    this.attributes = new VehicleAttributeTexture(opts.capacity);

    const boxSize = opts.boxSize ?? [1.85, 1.3, 4.5];
    const box = new BoxGeometry(...boxSize);
    box.translate(0, boxSize[1] / 2, 0);
    const boxPrimitive: LodPrimitive = {
      material: TINTED_MATERIAL,
      geometry: box,
      triangles: 12,
      vertices: 24,
      sourceMaterial: new MeshStandardMaterial(),
    };

    for (let b = 0; b < LOD_BUCKET_COUNT; b++) {
      const cap = this.manager.buckets[b]?.capacity ?? 0;
      const ids = new InstancedBufferAttribute(new Float32Array(cap), 1);
      ids.setUsage(DynamicDrawUsage);
      const primitives = b === BUCKET_BOX ? [boxPrimitive] : this.primitivesFor(opts.lods, b);
      const draw: BucketDraw = { ids, geometries: [], meshes: [], triangles: 0 };
      for (const p of primitives) {
        const geometry = this.instanced(p.geometry, ids);
        const material = this.materialFor(p, opts.config);
        const mesh = new Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.visible = false;
        mesh.name = `lod${b}:${p.material}`;
        draw.geometries.push(geometry);
        draw.meshes.push(mesh);
        draw.triangles += p.triangles;
        this.group.add(mesh);
      }
      this.buckets.push(draw);
      this.trianglesPerBucket.push(draw.triangles);
      this.bucketGeometry.push({
        triangles: draw.triangles,
        vertices: primitives.reduce((sum, p) => sum + p.vertices, 0),
        primitives: primitives.map((p) => p.material),
      });
    }
  }

  private primitivesFor(lods: LodPrimitive[][], bucket: number): LodPrimitive[] {
    for (let b = bucket; b < lods.length; b++) {
      const prims = lods[b];
      if (prims && prims.length > 0) return prims;
    }
    for (let b = bucket - 1; b >= 0; b--) {
      const prims = lods[b];
      if (prims && prims.length > 0) return prims;
    }
    return [];
  }

  private instanced(source: BufferGeometry, ids: InstancedBufferAttribute): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.setIndex(source.getIndex());
    for (const name of Object.keys(source.attributes)) g.setAttribute(name, source.getAttribute(name));
    g.setAttribute("vehicleId", ids);
    g.instanceCount = 0;
    g.boundingSphere = source.boundingSphere;
    return g;
  }

  private materialFor(p: LodPrimitive, config: LodConfig): InstancedVehicleMaterial {
    const src = p.sourceMaterial as Partial<MeshStandardMaterial>;
    const base = src.color instanceof Color ? src.color.clone() : new Color(0.8, 0.8, 0.8);
    const material = new InstancedVehicleMaterial({
      prev: this.state.prev,
      next: this.state.next,
      attributes: this.attributes.texture,
      texWidth: this.state.width,
      palette: config.palette,
      baseColor: base,
      tintByInstance: p.material === TINTED_MATERIAL,
    });
    material.setHeightField(this.heightField);
    this.materials.push(material);
    return material;
  }

  /** Tilt vehicles to the ground described by the grid (null: keep them level). */
  setHeightField(field: HeightFieldData | null): void {
    this.heightField?.texture.dispose();
    this.heightField = null;
    if (field) {
      const tex = new DataTexture(field.data, field.width, field.height, RedFormat, FloatType);
      tex.internalFormat = "R32F";
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      tex.needsUpdate = true;
      this.heightField = { texture: tex, ...field };
    }
    for (const m of this.materials) m.setHeightField(this.heightField);
  }

  /** Highlight one vehicle (all its primitives, whatever LOD bucket it is in), or −1. */
  setSelected(id: number): void {
    for (const m of this.materials) m.selectedId = id;
  }

  /** Upload static attributes (type, colour) after vehicles are (re)assigned. */
  uploadAttributes(buffer: VehicleBuffer): void {
    this.attributes.upload(buffer);
  }

  /** Push a new simulation snapshot (call at the data rate, not per frame). */
  pushSnapshot(buffer: VehicleBuffer, time: number): void {
    this.state.pushSnapshot(buffer, time);
  }

  /**
   * Fill a LodCamera from a view-projection matrix (local metres → clip), the eye
   * position in local metres, and the focal length in pixels. Used by both the
   * standalone Three.js camera path and the MapLibre custom layer.
   */
  setCamera(viewProjection: Matrix4, eyeX: number, eyeY: number, eyeZ: number, focalPx: number): void {
    tmpFrustum.setFromProjectionMatrix(viewProjection);
    for (let i = 0; i < 6; i++) {
      const plane = tmpFrustum.planes[i];
      if (!plane) continue;
      this.planes[i * 4] = plane.normal.x;
      this.planes[i * 4 + 1] = plane.normal.y;
      this.planes[i * 4 + 2] = plane.normal.z;
      this.planes[i * 4 + 3] = plane.constant;
    }
    const cam = this.camera;
    cam.x = eyeX;
    cam.y = eyeY;
    cam.z = eyeZ;
    cam.focalPx = focalPx;
  }

  /** Convenience for a Three.js perspective camera in the vehicles' frame. */
  setCameraFromThree(camera: PerspectiveCamera, viewportHeight: number): void {
    camera.updateMatrixWorld();
    tmpMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const focal = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.setCamera(tmpMatrix, camera.position.x, camera.position.y, camera.position.z, focal);
  }

  /** The camera last passed to setCamera*, e.g. to forward to a worker. */
  get lodCamera(): LodCamera {
    return this.camera;
  }

  /** Per frame (local mode): bucket vehicles on this thread, then update interpolation and draws. */
  update(buffer: VehicleBuffer, renderTime: number): void {
    this.manager.update(buffer, this.camera);
    this.setInterpolation(renderTime);
    for (let b = 0; b < LOD_BUCKET_COUNT; b++) {
      const bucket = this.manager.buckets[b];
      if (bucket) this.writeBucket(b, bucket.ids, 0, bucket.count);
    }
  }

  /**
   * Per frame (external mode): apply bucket lists produced elsewhere (the traffic worker).
   * `ids` holds every bucket's ids at `offsets[b]`; a null `counts` keeps the last lists.
   */
  updateWithBuckets(
    counts: ArrayLike<number> | null,
    ids: Float32Array,
    offsets: ArrayLike<number>,
    renderTime: number,
  ): void {
    this.setInterpolation(renderTime);
    if (!counts) return;
    for (let b = 0; b < LOD_BUCKET_COUNT; b++) {
      this.writeBucket(
        b,
        ids,
        offsets[b] ?? 0,
        Math.min(counts[b] ?? 0, this.manager.buckets[b]?.capacity ?? 0),
      );
    }
  }

  private setInterpolation(renderTime: number): void {
    const t = this.state.factorAt(renderTime);
    for (const m of this.materials) m.interpolation = t;
  }

  private writeBucket(b: number, ids: Float32Array, offset: number, n: number): void {
    const draw = this.buckets[b];
    if (!draw) return;
    if (n > 0) {
      (draw.ids.array as Float32Array).set(ids.subarray(offset, offset + n));
      draw.ids.addUpdateRange(0, n);
      draw.ids.needsUpdate = true;
    }
    for (const g of draw.geometries) g.instanceCount = n;
    for (const m of draw.meshes) m.visible = n > 0;
  }

  dispose(): void {
    this.heightField?.texture.dispose();
    for (const draw of this.buckets) for (const g of draw.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.state.dispose();
    this.attributes.dispose();
    this.group.removeFromParent();
  }
}
