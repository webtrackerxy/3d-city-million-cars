/**
 * Builds a HeightField for a square area around a LocalFrame origin from Terrarium raster
 * DEM tiles (AWS open elevation tiles, no key), clamped at sea level like the map's own
 * terrain source; the grid samples the tile pixels. Runs on the main thread once per city
 * load. Unless given, the DEM zoom is the finest level that needs at most MAX_DEM_TILES
 * tiles (zoom 15 for an 8 km area, coarser for larger ones) and the grid spacing grows
 * with the area (10 m up to 10 km, then 1/1000 of the side), so a 20 km area costs about
 * as much as an 8 km one.
 */

import type { LocalFrame } from "@/geo/coordinateSystem.ts";
import { HeightField, tileCoords } from "@/geo/HeightField.ts";
import { TERRARIUM_TILES, fetchTerrariumTile, terrariumElevation } from "./terrariumTile.ts";

export { TERRARIUM_TILES };

export interface LoadHeightFieldOptions {
  /** half-size of the square area in metres */
  halfSize: number;
  /** DEM tile zoom (15 ≈ 4 m/px at mid latitudes, the finest Terrarium level); default: see above */
  zoom?: number;
  /** grid spacing in metres; default 10 m, or 1/1000 of the side for areas over 10 km */
  spacing?: number;
  tileUrl?: string;
}

interface DecodedTile {
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  size: number;
}

async function fetchTile(url: string): Promise<DecodedTile | null> {
  const t = await fetchTerrariumTile(url);
  return t ? { x: 0, y: 0, pixels: t.pixels, size: t.width } : null;
}

/** most DEM tiles fetched for one height field (zoom 15 over 8 km needs about 150) */
const MAX_DEM_TILES = 160;
const FINEST_DEM_ZOOM = 15;
const COARSEST_DEM_ZOOM = 10;

interface TileRange {
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
}

function tileRange(
  c0: { longitude: number; latitude: number },
  c1: { longitude: number; latitude: number },
  zoom: number,
): TileRange {
  const t0 = tileCoords(c0.longitude, c0.latitude, zoom);
  const t1 = tileCoords(c1.longitude, c1.latitude, zoom);
  return {
    minTx: Math.floor(Math.min(t0.x, t1.x)),
    maxTx: Math.floor(Math.max(t0.x, t1.x)),
    minTy: Math.floor(Math.min(t0.y, t1.y)),
    maxTy: Math.floor(Math.max(t0.y, t1.y)),
  };
}

function tileCount(r: TileRange): number {
  return (r.maxTx - r.minTx + 1) * (r.maxTy - r.minTy + 1);
}

export async function loadHeightField(frame: LocalFrame, opts: LoadHeightFieldOptions): Promise<HeightField> {
  const tileUrl = opts.tileUrl ?? TERRARIUM_TILES;
  const half = opts.halfSize;
  const spacing = opts.spacing ?? Math.max(10, Math.round((2 * half) / 1000));
  // corners of the area, then the finest zoom whose tile range stays within budget
  const c0 = frame.localToLngLat({ x: -half, y: 0, z: -half });
  const c1 = frame.localToLngLat({ x: half, y: 0, z: half });
  let zoom = opts.zoom ?? FINEST_DEM_ZOOM;
  if (opts.zoom === undefined) {
    while (zoom > COARSEST_DEM_ZOOM && tileCount(tileRange(c0, c1, zoom)) > MAX_DEM_TILES) zoom--;
  }
  const { minTx, maxTx, minTy, maxTy } = tileRange(c0, c1, zoom);
  const tiles = new Map<string, DecodedTile>();
  const jobs: Promise<void>[] = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const url = tileUrl.replace("{z}", String(zoom)).replace("{x}", String(tx)).replace("{y}", String(ty));
      jobs.push(
        fetchTile(url).then((t) => {
          if (t) tiles.set(`${tx}/${ty}`, { ...t, x: tx, y: ty });
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (tiles.size === 0) throw new Error("no DEM tiles could be loaded");

  const width = Math.ceil((2 * half) / spacing) + 1;
  const height = width;
  const data = new Float32Array(width * height);
  const originX = -half;
  const originZ = -half;
  let missing = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const ll = frame.localToLngLat({ x: originX + col * spacing, y: 0, z: originZ + row * spacing });
      const tc = tileCoords(ll.longitude, ll.latitude, zoom);
      const tx = Math.floor(tc.x);
      const ty = Math.floor(tc.y);
      const tile = tiles.get(`${tx}/${ty}`);
      if (!tile) {
        missing++;
        data[row * width + col] = 0;
        continue;
      }
      const size = tile.size;
      const px = Math.min(size - 1, Math.floor((tc.x - tx) * size));
      const py = Math.min(size - 1, Math.floor((tc.y - ty) * size));
      const o = (py * size + px) * 4;
      const p = tile.pixels;
      data[row * width + col] = terrariumElevation(p[o] as number, p[o + 1] as number, p[o + 2] as number);
    }
  }
  if (missing > 0) console.warn(`height field: ${missing} of ${width * height} samples had no DEM tile`);
  return new HeightField({ originX, originZ, spacing, width, height, data });
}
