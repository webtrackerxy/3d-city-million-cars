/**
 * Regular grid of ground elevations over the local frame (metres, y up), sampled
 * bilinearly. Built from Terrarium-encoded raster DEM tiles (see src/data/loadHeightField.ts)
 * and handed to the traffic worker as a transferable Float32Array. Pure: no DOM, no Three.
 */

export interface HeightFieldData {
  /** local x of column 0 and local z of row 0 */
  originX: number;
  originZ: number;
  spacing: number;
  width: number;
  height: number;
  /** row-major elevations in metres above sea level */
  data: Float32Array;
}

export class HeightField {
  readonly originX: number;
  readonly originZ: number;
  readonly spacing: number;
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;

  constructor(d: HeightFieldData) {
    this.originX = d.originX;
    this.originZ = d.originZ;
    this.spacing = d.spacing;
    this.width = d.width;
    this.height = d.height;
    this.data = d.data;
  }

  /** Elevation at local (x, z); clamps to the grid edge. */
  sample(x: number, z: number): number {
    const fx = (x - this.originX) / this.spacing;
    const fz = (z - this.originZ) / this.spacing;
    const cx = Math.min(Math.max(fx, 0), this.width - 1.000001);
    const cz = Math.min(Math.max(fz, 0), this.height - 1.000001);
    const ix = Math.floor(cx);
    const iz = Math.floor(cz);
    const tx = cx - ix;
    const tz = cz - iz;
    const w = this.width;
    const d = this.data;
    const i00 = d[iz * w + ix] as number;
    const i10 = d[iz * w + ix + 1] as number;
    const i01 = d[(iz + 1) * w + ix] as number;
    const i11 = d[(iz + 1) * w + ix + 1] as number;
    return (i00 * (1 - tx) + i10 * tx) * (1 - tz) + (i01 * (1 - tx) + i11 * tx) * tz;
  }

  toData(): HeightFieldData {
    return {
      originX: this.originX,
      originZ: this.originZ,
      spacing: this.spacing,
      width: this.width,
      height: this.height,
      data: this.data,
    };
  }
}

/** Web Mercator tile coordinates (fractional) for a lon/lat at a zoom level. */
export function tileCoords(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const latRad = (latitude * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}
