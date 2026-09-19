/**
 * Builds a "satellite + labels" MapLibre style at runtime: a raster imagery layer under
 * the symbol (label and shield) layers of a vector style. The vector style supplies its
 * sources, glyphs and sprite; label paint is adjusted for legibility over imagery.
 */

import type {
  FillExtrusionLayerSpecification,
  LayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";

export interface HybridStyleOptions {
  /** vector style URL whose symbol layers become the labels */
  labelStyleUrl: string;
  imageryTiles: string[];
  imageryAttribution: string;
  imageryMaxZoom?: number;
  /** also carry the vector style's fill-extrusion (OSM building) layers */
  includeExtrusions?: boolean;
  /** carry the vector style's symbol layers (labels, shields); default true */
  includeLabels?: boolean;
}

const styleCache = new Map<string, Promise<StyleSpecification>>();

async function fetchStyle(url: string): Promise<StyleSpecification> {
  let cached = styleCache.get(url);
  if (!cached) {
    cached = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`style ${url}: HTTP ${res.status}`);
      return (await res.json()) as StyleSpecification;
    });
    styleCache.set(url, cached);
  }
  return cached;
}

function legibleOverImagery(layer: SymbolLayerSpecification): SymbolLayerSpecification {
  const paint = { ...(layer.paint ?? {}) };
  if (layer.layout?.["text-field"] !== undefined) {
    paint["text-color"] = "#ffffff";
    paint["text-halo-color"] = "rgba(0, 0, 0, 0.85)";
    paint["text-halo-width"] = 1.4;
    paint["text-halo-blur"] = 0.4;
  }
  return { ...layer, paint };
}

export async function buildHybridStyle(opts: HybridStyleOptions): Promise<StyleSpecification> {
  const vector = await fetchStyle(opts.labelStyleUrl);
  const labels: LayerSpecification[] =
    opts.includeLabels === false
      ? []
      : vector.layers
          .filter((l): l is SymbolLayerSpecification => l.type === "symbol")
          .map(legibleOverImagery);
  const extrusions: LayerSpecification[] = opts.includeExtrusions
    ? vector.layers.filter((l): l is FillExtrusionLayerSpecification => l.type === "fill-extrusion")
    : [];
  return {
    version: 8,
    ...(vector.glyphs ? { glyphs: vector.glyphs } : {}),
    ...(vector.sprite ? { sprite: vector.sprite } : {}),
    sources: {
      ...vector.sources,
      imagery: {
        type: "raster",
        tiles: opts.imageryTiles,
        tileSize: 256,
        maxzoom: opts.imageryMaxZoom ?? 19,
        attribution: opts.imageryAttribution,
      },
    },
    layers: [{ id: "imagery", type: "raster", source: "imagery" }, ...extrusions, ...labels],
  };
}
