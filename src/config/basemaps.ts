/**
 * Basemap styles selectable on the map page. Each entry is a MapLibre style URL or an
 * inline style specification. Raster imagery servers must send CORS headers because the
 * app is cross-origin isolated (COEP require-corp).
 */

import type { StyleSpecification } from "maplibre-gl";
import { buildHybridStyle } from "./hybridStyle.ts";

export interface BasemapBuildOptions {
  /** include OSM building extrusions from the vector data (buildings=osm) */
  extrusions: boolean;
}

export interface BasemapConfig {
  id: string;
  name: string;
  /** a style URL, an inline style, or a builder that composes one at runtime */
  style: string | StyleSpecification | ((opts: BasemapBuildOptions) => Promise<StyleSpecification>);
  /** the style draws its own 3D buildings (fill-extrusion) that tiles should replace */
  hasExtrusions: boolean;
}

const VECTOR_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const IMAGERY_TILES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];
const IMAGERY_ATTRIBUTION =
  "Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

export const BASEMAPS: Record<string, BasemapConfig> = {
  vector: {
    id: "vector",
    name: "Vector (OpenFreeMap Liberty)",
    style: VECTOR_STYLE,
    hasExtrusions: true,
  },
  satellite: {
    id: "satellite",
    name: "Satellite + labels",
    style: (o) =>
      buildHybridStyle({
        labelStyleUrl: VECTOR_STYLE,
        imageryTiles: IMAGERY_TILES,
        imageryAttribution: IMAGERY_ATTRIBUTION,
        includeExtrusions: o.extrusions,
      }),
    hasExtrusions: true,
  },
  imagery: {
    id: "imagery",
    name: "Satellite only",
    // no labels, but the vector source still supplies the OSM building extrusions
    style: (o) =>
      buildHybridStyle({
        labelStyleUrl: VECTOR_STYLE,
        imageryTiles: IMAGERY_TILES,
        imageryAttribution: IMAGERY_ATTRIBUTION,
        includeExtrusions: o.extrusions,
        includeLabels: false,
      }),
    hasExtrusions: true,
  },
};

/**
 * Building opacity each buildings mode starts at, before the user moves the slider. The
 * OSM value matches the `fill-extrusion-opacity` OpenFreeMap Liberty paints its
 * extrusions with, so the default look is unchanged; 3D Tiles start opaque.
 */
export const DEFAULT_BUILDING_OPACITY = { osm: 0.8, tiles: 1 } as const;

export const DEFAULT_BASEMAP_ID = "vector";

export function basemapById(id: string | null | undefined): BasemapConfig {
  return (id ? BASEMAPS[id] : undefined) ?? (BASEMAPS[DEFAULT_BASEMAP_ID] as BasemapConfig);
}
