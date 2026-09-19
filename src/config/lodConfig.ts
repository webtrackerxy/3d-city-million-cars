/**
 * Runtime LOD configuration (spec §28, §29, §37). Values are starting points to be tuned
 * against docs/performance.md; nothing here is hard-coded elsewhere.
 *
 * Buckets are ordered best to worst. A vehicle enters bucket k when its projected
 * bounding-sphere diameter in pixels is at least `minPixels[k] · (1 + hysteresis)` and
 * leaves it when the size drops below `minPixels[k] · (1 − hysteresis)`. Each bucket
 * holds at most `caps[k]` vehicles, filled nearest-first; overflow moves to the next
 * bucket. Anything below the last threshold or outside the frustum is culled.
 */

export interface LodConfig {
  /** projected size thresholds in pixels for LOD0..LOD3 and the far-field box */
  minPixels: readonly [number, number, number, number, number];
  /** instance caps for LOD0..LOD3 (the box bucket is uncapped) */
  caps: readonly [number, number, number, number];
  /** relative hysteresis band applied to thresholds */
  hysteresis: number;
  /** bounding-sphere radius of a vehicle in metres, used for projected size and culling */
  boundingRadius: number;
  /** body paint palette (linear RGB), indexed by VehicleBuffer.color */
  palette: readonly (readonly [number, number, number])[];
}

export const DEFAULT_LOD_CONFIG: LodConfig = {
  minPixels: [220, 70, 18, 5, 1.5],
  // measured in docs/performance.md §3: 9.9 M triangles, 5.1 ms GPU at street level
  caps: [20, 300, 1500, 8000],
  hysteresis: 0.1,
  boundingRadius: 2.6,
  palette: [
    [0.85, 0.85, 0.85], // silver
    [0.05, 0.05, 0.06], // black
    [0.35, 0.37, 0.42], // grey
    [0.55, 0.05, 0.04], // red
    [0.04, 0.12, 0.45], // blue
    [0.9, 0.9, 0.92], // white
    [0.6, 0.45, 0.08], // gold
    [0.06, 0.28, 0.12], // green
    [0.5, 0.2, 0.05], // brown
    [0.02, 0.35, 0.45], // teal
    [0.7, 0.3, 0.02], // orange
    [0.25, 0.02, 0.3], // purple
    [0.75, 0.75, 0.8], // light grey
    [0.12, 0.12, 0.14], // dark grey
    [0.4, 0.05, 0.1], // maroon
    [0.02, 0.2, 0.3], // navy
  ],
};

export const LOD_BUCKET_COUNT = 5; // LOD0..LOD3 + box
export const BUCKET_BOX = 4;
export const BUCKET_CULLED = 5;
