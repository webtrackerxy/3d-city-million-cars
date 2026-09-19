/**
 * Shape of `assets/generated/<vehicle>/manifest.json`, produced by
 * scripts/generate-car-lods.py and enriched by optimize-assets.ts / validate-assets.ts.
 * The application reads asset facts from here instead of hard-coding them (spec §24).
 */

export interface LodBoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface LodGlbStats {
  file: string;
  bytes: number;
  triangles: number;
  vertices: number;
  primitives: number;
  materials: string[];
  textures: number;
  extensionsRequired: string[];
  dimensions: [number, number, number];
  issues: string[];
  warnings: string[];
}

export interface VehicleLodEntry {
  id: number;
  file: string;
  description: string;
  /** triangle count of the raw export (Blender-side) */
  triangles: number;
  vertices: number;
  materials: string[];
  bytes: number;
  boundingBox: LodBoundingBox;
  targetTriangles: [number, number] | null;
  optimized?: { file: string; bytes: number; ratio: number; steps: string[] };
  validation?: { checkedAt: string; raw: LodGlbStats; optimized?: LodGlbStats };
}

export interface VehicleAssetManifest {
  vehicle: string;
  source: { file: string; triangles: number | null };
  convention: { units: string; up: string; forward: string; origin: string; reference: string };
  normalize: { scale: number; translate: [number, number, number] };
  generator: { script: string; config: string; blender: string };
  lods: VehicleLodEntry[];
}

/** Canonical material names emitted by the asset pipeline (scripts/lod-config.json). */
export const VEHICLE_MATERIALS = [
  "paint",
  "window",
  "glass",
  "chrome",
  "dark",
  "rubber",
  "lights",
  "calliper",
  "license",
] as const;
export type VehicleMaterialName = (typeof VEHICLE_MATERIALS)[number];

/** The material the runtime tints per instance. */
export const TINTED_MATERIAL: VehicleMaterialName = "paint";
