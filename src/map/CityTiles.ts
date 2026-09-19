/**
 * OGC 3D Tiles buildings for a city, rendered by `3d-tiles-renderer` inside the vehicle
 * layer's Three.js scene (spec §30, docs/coordinates.md §5).
 *
 * Placement: `ReorientationPlugin` moves the tileset so the city origin (lat/lon in
 * radians, `groundHeight` metres above the ellipsoid) sits at the Three.js origin with
 * +Y up, X facing WEST and Z facing NORTH. Our local frame has X east and Z south, so
 * the tiles group is parented under a half-turn about Y.
 */

import { Group, Mesh, type Material, type Object3D, type PerspectiveCamera, type WebGLRenderer } from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
  UnloadTilesPlugin,
} from "3d-tiles-renderer/plugins";

export interface TilesetConfig {
  /** tileset.json URL, or omit and use `ion` */
  url?: string;
  ion?: { assetId: number; token: string };
  /** ellipsoid height (metres) of the ground at the city origin, so tiles sit on y = 0 */
  groundHeight: number;
  /** hide the basemap's fill-extrusion layers while these tiles are shown */
  hideBasemapBuildings?: boolean;
  attribution?: string;
  /** screen-space error target in pixels (3d-tiles-renderer default 16) */
  errorTarget?: number;
  /** LRU cache limit in bytes */
  maxCacheBytes?: number;
  /** building opacity, 0..1 (1 = opaque); change later with CityTiles.setOpacity */
  opacity?: number;
}

/** Make every material under `root` draw at `opacity`, blending only when below 1. */
function applyOpacity(root: Object3D, opacity: number): void {
  const transparent = opacity < 1;
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const materials = (Array.isArray(o.material) ? o.material : [o.material]) as Material[];
    for (const m of materials) {
      if (m.transparent !== transparent) m.needsUpdate = true;
      m.transparent = transparent;
      m.opacity = opacity;
    }
  });
}

export interface TilesStats {
  visible: number;
  active: number;
  inFrustum: number;
  downloading: number;
  parsing: number;
  queued: number;
  failed: number;
  cachedMB: number;
  cacheFull: boolean;
  loaded: boolean;
}

const DEG2RAD = Math.PI / 180;

export class CityTiles {
  readonly group = new Group();
  private opacity: number;
  readonly tiles: TilesRenderer;
  readonly stats: TilesStats = {
    visible: 0,
    active: 0,
    inFrustum: 0,
    downloading: 0,
    parsing: 0,
    queued: 0,
    failed: 0,
    cachedMB: 0,
    cacheFull: false,
    loaded: false,
  };
  private readonly draco: DRACOLoader;
  private readonly ktx2: KTX2Loader;

  constructor(
    readonly config: TilesetConfig,
    origin: { longitude: number; latitude: number },
    renderer: WebGLRenderer,
  ) {
    if (!config.url && !config.ion) throw new Error("tileset needs a url or an ion asset");
    this.tiles = config.url ? new TilesRenderer(config.url) : new TilesRenderer();
    if (config.ion) {
      // resolves the asset endpoint, injects the bearer token and refreshes it
      this.tiles.registerPlugin(
        new CesiumIonAuthPlugin({
          apiToken: config.ion.token,
          assetId: String(config.ion.assetId),
          autoRefreshToken: true,
          useRecommendedSettings: true,
        }),
      );
    }
    this.draco = new DRACOLoader().setDecoderPath("/draco/");
    this.ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
    this.tiles.registerPlugin(
      new GLTFExtensionsPlugin({
        dracoLoader: this.draco,
        ktxLoader: this.ktx2,
        meshoptDecoder: MeshoptDecoder,
      }),
    );
    this.tiles.registerPlugin(
      new ReorientationPlugin({
        lat: origin.latitude * DEG2RAD,
        lon: origin.longitude * DEG2RAD,
        height: config.groundHeight,
        up: "+y",
        recenter: true,
      }),
    );
    this.tiles.registerPlugin(new UnloadTilesPlugin());
    this.tiles.errorTarget = config.errorTarget ?? 12;
    if (config.maxCacheBytes) this.tiles.lruCache.maxBytesSize = config.maxCacheBytes;
    this.tiles.addEventListener("load-tile-set", () => {
      this.stats.loaded = true;
    });
    // tiles stream in as the camera moves; each new one takes the current opacity
    this.opacity = config.opacity ?? 1;
    this.tiles.addEventListener("load-model", (e: { scene: Object3D }) => {
      applyOpacity(e.scene, this.opacity);
    });
    // west/north (plugin) -> east/south (local frame)
    this.group.rotation.y = Math.PI;
    this.group.add(this.tiles.group);
  }

  /** Building opacity for loaded and future tiles, 0..1. */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
    applyOpacity(this.tiles.group, opacity);
  }

  /** Per frame, after the camera matrices are set. */
  update(camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    const tiles = this.tiles;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    // stats and cachedBytes exist at runtime but are not in the package typings
    const raw = (tiles as unknown as { stats: Record<string, number> }).stats;
    const s = this.stats;
    s.visible = raw.visible ?? 0;
    s.active = raw.active ?? 0;
    s.inFrustum = raw.inFrustum ?? 0;
    s.downloading = raw.downloading ?? 0;
    s.parsing = raw.parsing ?? 0;
    s.queued = raw.queued ?? 0;
    s.failed = raw.failed ?? 0;
    s.cachedMB = ((tiles.lruCache as unknown as { cachedBytes?: number }).cachedBytes ?? 0) / 1048576;
    s.cacheFull = tiles.lruCache.isFull();
  }

  dispose(): void {
    this.tiles.dispose();
    this.draco.dispose();
    this.ktx2.dispose();
    this.group.removeFromParent();
  }
}
