/**
 * Terrarium DEM tile decoding shared by the height-field builder and the MapLibre
 * protocol that clamps the tiles at sea level. AWS Terrain Tiles carry bathymetry and
 * coastal artefacts (kilometre-deep spikes in Victoria Harbour); the city runs on land,
 * so anything below 0 m becomes 0 m. Browser only (createImageBitmap, OffscreenCanvas).
 */

export const TERRARIUM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** the scheme registered with maplibregl.addProtocol for clamped tiles */
export const CLAMPED_TERRAIN_SCHEME = "terrarium0";

export interface TerrariumTile {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Terrarium RGB → metres. */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Set every pixel below sea level to exactly 0 m (r = 128, g = 0, b = 0). */
export function clampAtSeaLevel(pixels: Uint8ClampedArray): number {
  let changed = 0;
  for (let o = 0; o < pixels.length; o += 4) {
    if ((pixels[o] as number) < 128) {
      pixels[o] = 128;
      pixels[o + 1] = 0;
      pixels[o + 2] = 0;
      changed++;
    }
  }
  return changed;
}

/** Fetch and decode one PNG tile; null when the tile is missing. */
export async function fetchTerrariumTile(url: string, signal?: AbortSignal): Promise<TerrariumTile | null> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  clampAtSeaLevel(pixels);
  return { pixels, width, height };
}

/** Re-encode a decoded tile as PNG bytes for MapLibre's raster-dem source. */
export async function encodeTilePng(tile: TerrariumTile): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(tile.width, tile.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  // copy: ImageData wants a Uint8ClampedArray over a plain ArrayBuffer
  const pixels = new Uint8ClampedArray(tile.pixels);
  ctx.putImageData(new ImageData(pixels, tile.width, tile.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blob.arrayBuffer();
}
