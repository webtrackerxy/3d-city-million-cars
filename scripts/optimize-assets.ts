/**
 * Post-export optimisation of the generated LOD GLBs with glTF-Transform (Phase A3, spec §22).
 *
 *   node scripts/optimize-assets.ts [assets/generated/porsche/manifest.json]
 *
 * For each LOD writes `<name>.opt.glb` next to the raw export with: dedup, prune, weld,
 * vertex-cache reorder, KHR_mesh_quantization (14-bit positions, 10-bit normals) and
 * EXT_meshopt_compression. The raw GLB is kept so the runtime can benchmark decode cost
 * against download size (spec §21: "do not enable every compression technique without
 * measurement"). Sizes are recorded in the manifest under `optimized`.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, prune, weld, reorder, quantize } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";

interface LodEntry {
  id: number;
  file: string;
  bytes: number;
  optimized?: { file: string; bytes: number; ratio: number; steps: string[] };
}

async function main(): Promise<void> {
  const manifestPath = resolve(process.argv[2] ?? "assets/generated/porsche/manifest.json");
  const dir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { lods: LodEntry[] };

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

  const steps = ["dedup", "prune", "weld", "reorder", "quantize(pos14,norm10)", "meshopt"];
  for (const lod of manifest.lods) {
    const input = join(dir, lod.file);
    const output = join(dir, lod.file.replace(/\.glb$/, ".opt.glb"));
    const doc = await io.read(input);
    await doc.transform(
      dedup(),
      prune(),
      weld(),
      reorder({ encoder: MeshoptEncoder }),
      quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
    );
    doc
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    await io.write(output, doc);
    const bytes = statSync(output).size;
    lod.optimized = {
      file: output.slice(dir.length + 1),
      bytes,
      ratio: +(bytes / lod.bytes).toFixed(3),
      steps,
    };
    console.log(
      `LOD${lod.id}: ${(lod.bytes / 1024).toFixed(0).padStart(6)} KB -> ${(bytes / 1024).toFixed(0).padStart(6)} KB ` +
        `(${((100 * bytes) / lod.bytes).toFixed(0)} %)  ${lod.optimized.file}`,
    );
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

await main();
