/**
 * Validate generated vehicle LOD GLBs against the conventions in docs/coordinates.md
 * and the targets recorded in manifest.json (Phase A3, spec §25).
 *
 *   node scripts/validate-assets.ts [assets/generated/porsche/manifest.json]
 *
 * Checks every LOD (and its .opt.glb variant when present): the file parses, triangle
 * and vertex counts, material and texture counts, bounding box against real-car
 * dimensions, ground contact at Y = 0, lateral centring, identity node transforms, no
 * NaN positions, and that LODs shrink monotonically. Results are written back into the
 * manifest under `validation` and printed as a table. Exits 1 on any error.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NodeIO, getBounds, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

interface LodEntry {
  id: number;
  file: string;
  triangles: number;
  vertices: number;
  targetTriangles?: [number, number] | null;
  optimized?: { file: string; bytes: number };
  validation?: unknown;
}

interface Manifest {
  vehicle: string;
  lods: LodEntry[];
}

interface GlbStats {
  file: string;
  bytes: number;
  triangles: number;
  vertices: number;
  primitives: number;
  materials: string[];
  textures: number;
  extensionsRequired: string[];
  dimensions: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  issues: string[];
  warnings: string[];
}

// Real-vehicle envelope in metres (glTF axes: X width, Y height, Z length). A different
// vehicle type gets its own envelope; these are generous bounds, not exact dimensions.
const ENVELOPE = { width: [1.6, 2.2], height: [1.0, 1.5], length: [4.0, 5.2] } as const;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

async function inspect(path: string, target: [number, number] | null | undefined): Promise<GlbStats> {
  const issues: string[] = [];
  const warnings: string[] = [];
  let doc: Document;
  try {
    doc = await io.read(path);
  } catch (err) {
    return {
      file: path,
      bytes: statSync(path).size,
      triangles: 0,
      vertices: 0,
      primitives: 0,
      materials: [],
      textures: 0,
      extensionsRequired: [],
      dimensions: [0, 0, 0],
      min: [0, 0, 0],
      max: [0, 0, 0],
      issues: [`failed to parse: ${(err as Error).message}`],
      warnings,
    };
  }
  const root = doc.getRoot();
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;
  let nan = 0;
  const materials = new Set<string>();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primitives += 1;
      const position = prim.getAttribute("POSITION");
      if (!position) {
        issues.push(`${mesh.getName()}: primitive without POSITION`);
        continue;
      }
      const count = position.getCount();
      vertices += count;
      const indices = prim.getIndices();
      const mode = prim.getMode();
      if (mode !== 4) warnings.push(`${mesh.getName()}: primitive mode ${mode} is not TRIANGLES`);
      triangles += Math.floor((indices ? indices.getCount() : count) / 3);
      const mat = prim.getMaterial();
      materials.add(mat ? mat.getName() : "(none)");
      const element: number[] = [];
      for (let i = 0; i < count; i++) {
        position.getElement(i, element);
        for (const v of element) if (!Number.isFinite(v)) nan++;
      }
    }
  }
  if (nan > 0) issues.push(`${nan} non-finite position components`);
  // KHR_mesh_quantization stores integer positions and puts the dequantisation
  // scale/offset on the node; that transform is expected. The runtime must fold the
  // node matrix into the geometry before instancing (see docs/coordinates.md §2).
  const quantized = root.listExtensionsRequired().some((e) => e.extensionName === "KHR_mesh_quantization");
  for (const node of quantized ? [] : root.listNodes()) {
    const t = node.getTranslation();
    const r = node.getRotation();
    const s = node.getScale();
    const identity =
      t.every((v) => Math.abs(v) < 1e-6) &&
      Math.abs(r[3] - 1) < 1e-6 &&
      r.slice(0, 3).every((v) => Math.abs(v) < 1e-6) &&
      s.every((v) => Math.abs(v - 1) < 1e-6);
    if (!identity) issues.push(`node ${node.getName()} has a non-identity transform (bake it into the mesh)`);
  }
  const scene = root.listScenes()[0] ?? root.getDefaultScene();
  const bounds = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
  const min = bounds.min as [number, number, number];
  const max = bounds.max as [number, number, number];
  const dims: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const check = (label: string, value: number, [lo, hi]: readonly [number, number]) => {
    if (value < lo || value > hi) issues.push(`${label} ${value.toFixed(3)} m outside [${lo}, ${hi}]`);
  };
  check("width (X)", dims[0], ENVELOPE.width);
  check("height (Y)", dims[1], ENVELOPE.height);
  check("length (Z)", dims[2], ENVELOPE.length);
  if (Math.abs(min[1]) > 0.03) issues.push(`ground contact at Y=${min[1].toFixed(3)}, expected 0`);
  const cx = (min[0] + max[0]) / 2;
  if (Math.abs(cx) > 0.02) issues.push(`not laterally centred: X centre ${cx.toFixed(3)}`);
  const textures = root.listTextures().length;
  if (materials.size > 10) warnings.push(`${materials.size} materials (draw calls per instance bucket)`);
  if (target && (triangles < target[0] || triangles > target[1])) {
    warnings.push(
      `${triangles.toLocaleString()} triangles outside target [${target[0].toLocaleString()}, ${target[1].toLocaleString()}]`,
    );
  }
  return {
    file: path,
    bytes: statSync(path).size,
    triangles,
    vertices,
    primitives,
    materials: [...materials],
    textures,
    extensionsRequired: root.listExtensionsRequired().map((e) => e.extensionName),
    dimensions: dims.map((v) => +v.toFixed(3)) as [number, number, number],
    min: min.map((v) => +v.toFixed(3)) as [number, number, number],
    max: max.map((v) => +v.toFixed(3)) as [number, number, number],
    issues,
    warnings,
  };
}

async function main(): Promise<void> {
  const manifestPath = resolve(process.argv[2] ?? "assets/generated/porsche/manifest.json");
  const dir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  let failed = false;
  let previous = Number.POSITIVE_INFINITY;
  const rows: string[] = [];
  for (const lod of manifest.lods) {
    const variants: { label: string; path: string }[] = [
      { label: `LOD${lod.id}`, path: join(dir, lod.file) },
    ];
    if (lod.optimized && existsSync(join(dir, lod.optimized.file))) {
      variants.push({ label: `LOD${lod.id} opt`, path: join(dir, lod.optimized.file) });
    }
    const results: Record<string, GlbStats> = {};
    for (const v of variants) {
      const stats = await inspect(v.path, lod.targetTriangles);
      results[v.label.endsWith("opt") ? "optimized" : "raw"] = stats;
      if (v.label.endsWith("opt") && results.raw && stats.triangles !== results.raw.triangles) {
        stats.issues.push(
          `optimized triangle count ${stats.triangles} differs from raw ${results.raw.triangles}`,
        );
      }
      const status = stats.issues.length ? "FAIL" : stats.warnings.length ? "warn" : "ok";
      if (stats.issues.length) failed = true;
      rows.push(
        `${v.label.padEnd(9)} ${status.padEnd(5)} ${stats.triangles.toLocaleString().padStart(9)} tris ` +
          `${stats.vertices.toLocaleString().padStart(9)} verts ${String(stats.primitives).padStart(2)} prims ` +
          `${(stats.bytes / 1024).toFixed(0).padStart(6)} KB  ${stats.dimensions.map((d) => d.toFixed(2)).join(" x ")} m` +
          (stats.extensionsRequired.length ? `  [${stats.extensionsRequired.join(", ")}]` : ""),
      );
      for (const w of stats.warnings) rows.push(`          warn: ${w}`);
      for (const i of stats.issues) rows.push(`          FAIL: ${i}`);
    }
    const rawTriangles = results.raw?.triangles ?? 0;
    if (rawTriangles >= previous) {
      failed = true;
      rows.push(`          FAIL: LOD${lod.id} has more triangles than the previous LOD`);
    }
    previous = rawTriangles;
    lod.validation = { checkedAt: new Date().toISOString(), ...results };
  }
  console.log(rows.join("\n"));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nmanifest updated: ${manifestPath}`);
  if (failed) {
    console.error("validation FAILED");
    process.exit(1);
  }
}

await main();
