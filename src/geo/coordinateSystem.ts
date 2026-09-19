/**
 * Transformations between WGS84, Web Mercator (MapLibre's world space) and the local
 * metre frame used by the renderer (docs/coordinates.md §4).
 *
 * Local frame: origin at a chosen (lon, lat) on the ground, x east, y up, z south, metres.
 * MapLibre Mercator: x east, y south, both in [0, 1] for the world, z up in the same
 * units; one metre is `meterInMercatorCoordinateUnits()` at the origin latitude.
 *
 * All arithmetic here is float64. The renderer receives one combined projection matrix
 * per frame and float32 metre coordinates; nothing large ever reaches the GPU in float32.
 * No MapLibre import: the Mercator formulas are reproduced so this module stays testable.
 */

const EARTH_CIRCUMFERENCE = 40075016.686; // metres at the equator (MapLibre constant)
const DEG = Math.PI / 180;

export interface LngLat {
  longitude: number;
  latitude: number;
  altitude?: number;
}

export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

export interface MercatorPoint {
  x: number;
  y: number;
  z: number;
}

export function mercatorXFromLng(lng: number): number {
  return (180 + lng) / 360;
}

export function mercatorYFromLat(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

/** Mercator units per metre at a latitude (MapLibre's meterInMercatorCoordinateUnits). */
export function mercatorUnitsPerMetre(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG));
}

export class LocalFrame {
  readonly origin: LngLat;
  readonly originMercator: MercatorPoint;
  /** Mercator units per metre at the origin */
  readonly scale: number;

  constructor(origin: LngLat) {
    this.origin = { longitude: origin.longitude, latitude: origin.latitude, altitude: origin.altitude ?? 0 };
    this.scale = mercatorUnitsPerMetre(origin.latitude);
    this.originMercator = {
      x: mercatorXFromLng(origin.longitude),
      y: mercatorYFromLat(origin.latitude),
      z: (origin.altitude ?? 0) * this.scale,
    };
  }

  lngLatToLocal(p: LngLat, out: LocalPoint = { x: 0, y: 0, z: 0 }): LocalPoint {
    const mx = mercatorXFromLng(p.longitude);
    const my = mercatorYFromLat(p.latitude);
    out.x = (mx - this.originMercator.x) / this.scale;
    out.z = (my - this.originMercator.y) / this.scale;
    out.y = (p.altitude ?? 0) - (this.origin.altitude ?? 0);
    return out;
  }

  localToLngLat(p: LocalPoint): Required<LngLat> {
    const mx = this.originMercator.x + p.x * this.scale;
    const my = this.originMercator.y + p.z * this.scale;
    return {
      longitude: lngFromMercatorX(mx),
      latitude: latFromMercatorY(my),
      altitude: p.y + (this.origin.altitude ?? 0),
    };
  }

  mercatorToLocal(m: MercatorPoint, out: LocalPoint = { x: 0, y: 0, z: 0 }): LocalPoint {
    out.x = (m.x - this.originMercator.x) / this.scale;
    out.z = (m.y - this.originMercator.y) / this.scale;
    out.y = (m.z - this.originMercator.z) / this.scale;
    return out;
  }

  localToMercator(p: LocalPoint, out: MercatorPoint = { x: 0, y: 0, z: 0 }): MercatorPoint {
    out.x = this.originMercator.x + p.x * this.scale;
    out.y = this.originMercator.y + p.z * this.scale;
    out.z = this.originMercator.z + p.y * this.scale;
    return out;
  }

  /**
   * Column-major 4×4 matrix mapping local metres to Mercator world coordinates:
   * merc = origin + (s·x, s·z, s·y). Written into `out` (length 16) in float64.
   */
  modelMatrix(out: Float64Array | number[] = new Float64Array(16)): Float64Array | number[] {
    const s = this.scale;
    const o = this.originMercator;
    out.fill(0);
    out[0] = s; // local x -> merc x
    out[6] = s; // local y -> merc z
    out[9] = s; // local z -> merc y
    out[12] = o.x;
    out[13] = o.y;
    out[14] = o.z;
    out[15] = 1;
    return out;
  }
}

/** out = a · b for column-major 4×4 matrices in float64. */
export function multiplyMat4(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float64Array | number[] = new Float64Array(16),
): Float64Array | number[] {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
