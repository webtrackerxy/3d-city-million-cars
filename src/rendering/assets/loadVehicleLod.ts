/**
 * Load one LOD GLB and return instancing-ready geometry per material.
 *
 * - Handles raw and optimised (`KHR_mesh_quantization` + `EXT_meshopt_compression`) files.
 * - Folds every node's world matrix into its geometry, which is what the quantised files
 *   need (the dequantisation scale/offset lives on the node) and what instancing needs
 *   (one geometry per material, no scene graph).
 * - Converts quantised integer positions to Float32 before transforming; normals keep
 *   their storage type because the fold is a uniform scale + translation.
 */

import { BufferAttribute, Float32BufferAttribute, Mesh, type BufferGeometry, type Material } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { deinterleaveGeometry } from "three/addons/utils/BufferGeometryUtils.js";

export interface LodPrimitive {
  /** canonical material name from the pipeline (paint, window, ...) */
  material: string;
  geometry: BufferGeometry;
  triangles: number;
  vertices: number;
  /** the material object GLTFLoader built (MeshStandardMaterial); useful for the viewer */
  sourceMaterial: Material;
}

export interface LoadedLod {
  url: string;
  primitives: LodPrimitive[];
  triangles: number;
  vertices: number;
  bytes: number;
  /** network + parse time in ms as measured around GLTFLoader.parse */
  loadMs: number;
  parseMs: number;
}

let loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

function toFloat32Positions(attr: BufferAttribute): Float32BufferAttribute {
  if (attr.array instanceof Float32Array && !attr.normalized) return attr;
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  return new Float32BufferAttribute(out, 3);
}

export async function loadVehicleLod(url: string): Promise<LoadedLod> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const t1 = performance.now();
  const gltf = await getLoader().parseAsync(bytes, "");
  const t2 = performance.now();

  gltf.scene.updateMatrixWorld(true);
  const primitives: LodPrimitive[] = [];
  gltf.scene.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    const mesh = obj as Mesh<BufferGeometry, Material>;
    const geometry = mesh.geometry.clone();
    // meshopt-encoded files arrive with interleaved vertex streams; instancing wants plain attributes
    deinterleaveGeometry(geometry);
    const pos = geometry.getAttribute("position");
    if (!(pos instanceof BufferAttribute)) throw new Error(`${url}: interleaved positions are not supported`);
    geometry.setAttribute("position", toFloat32Positions(pos));
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingSphere();
    const index = geometry.getIndex();
    const vertices = geometry.getAttribute("position").count;
    const triangles = Math.floor((index ? index.count : vertices) / 3);
    primitives.push({
      material: mesh.material.name || "unnamed",
      geometry,
      triangles,
      vertices,
      sourceMaterial: mesh.material,
    });
  });
  primitives.sort((a, b) => b.triangles - a.triangles);
  return {
    url,
    primitives,
    triangles: primitives.reduce((s, p) => s + p.triangles, 0),
    vertices: primitives.reduce((s, p) => s + p.vertices, 0),
    bytes: bytes.byteLength,
    loadMs: t1 - t0,
    parseMs: t2 - t1,
  };
}
