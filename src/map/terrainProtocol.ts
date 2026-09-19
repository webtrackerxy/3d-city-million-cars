/**
 * MapLibre protocol `terrarium0://<https url>` that serves Terrarium tiles clamped at sea
 * level (see src/data/terrariumTile.ts), so the draped basemap and the vehicles share one
 * surface with no bathymetry trenches. Registered once per page.
 */

import { addProtocol } from "maplibre-gl";
import { CLAMPED_TERRAIN_SCHEME, encodeTilePng, fetchTerrariumTile } from "@/data/terrariumTile.ts";

let registered = false;

export function registerClampedTerrainProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol(CLAMPED_TERRAIN_SCHEME, async (params, abort) => {
    const url = params.url.slice(CLAMPED_TERRAIN_SCHEME.length + 3);
    const tile = await fetchTerrariumTile(url, abort.signal);
    if (!tile) throw new Error(`terrain tile missing: ${url}`);
    return { data: await encodeTilePng(tile) };
  });
}

/** Tile URL template for the clamped source. */
export function clampedTerrainTiles(template: string): string {
  return `${CLAMPED_TERRAIN_SCHEME}://${template}`;
}
