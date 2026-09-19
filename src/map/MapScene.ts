/**
 * Wires a MapLibre map, the vehicle custom layer, the traffic source and a frame loop
 * together for the /map page. Owns all non-React state; the page only calls methods
 * and receives stats through a callback.
 */

import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type ErrorEvent,
  type LayerSpecification,
} from "maplibre-gl";
// MapLibre 6 resolves its worker relative to its own module URL, which Vite's dependency
// pre-bundling relocates; give it the bundler-resolved URL instead. `?worker&url` (not
// plain `?url`) makes Vite bundle the worker with its sibling chunk: the shipped
// maplibre-gl-worker.mjs imports "./maplibre-gl-shared.mjs", which a plain `?url` copy
// leaves behind, and the module worker then dies on load with no basemap tiles fetched.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(maplibreWorkerUrl);
import type { BasemapConfig } from "@/config/basemaps.ts";
import type { CityConfig } from "@/config/cityConfig.ts";
import { DEFAULT_LOD_CONFIG, type LodConfig } from "@/config/lodConfig.ts";
import { VehicleBuffer, supportsSharedMemory } from "@/data/VehicleBuffer.ts";
import { TERRARIUM_TILES, loadHeightField } from "@/data/loadHeightField.ts";
import { clampedTerrainTiles, registerClampedTerrainProtocol } from "./terrainProtocol.ts";
import type { HeightField } from "@/geo/HeightField.ts";
import { loadManifest } from "@/data/loadManifest.ts";
import { loadVehicleLod, type LodPrimitive } from "@/rendering/assets/loadVehicleLod.ts";
import { RenderLoop } from "@/rendering/RenderLoop.ts";
import { RoadNetwork } from "@/simulation/RoadNetwork.ts";
import { RoadTraffic } from "@/simulation/RoadTraffic.ts";
import { SyntheticTraffic } from "@/simulation/SyntheticTraffic.ts";
import { TrafficWorkerClient } from "@/simulation/TrafficWorkerClient.ts";
import type { SimulationSource } from "@/types/vehicle.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";
import { vehicleAssetUrl } from "@/data/loadManifest.ts";
import type { VehicleState } from "@/types/vehicle.ts";
import { LocalFrame } from "@/geo/coordinateSystem.ts";
import { AdaptiveLod } from "@/lod/AdaptiveLod.ts";
import type { LodCamera } from "@/lod/VehicleLodManager.ts";
import { FrameKind } from "@/net/protocol.ts";
import {
  WebSocketTrafficSource,
  type NetStats,
  type WebSocketTrafficOptions,
} from "@/net/WebSocketTrafficSource.ts";
import type { TilesStats, TilesetConfig } from "./CityTiles.ts";
import { NorthControl } from "./NorthControl.ts";
import { TopDownControl } from "./TopDownControl.ts";
import { VehicleLayer, type VehicleRenderInfo } from "./VehicleLayer.ts";

export interface MapSceneStats {
  fps: number;
  frameMs: number;
  vehicles: number;
  visible: number;
  culled: number;
  outsideFrustum: number;
  lodCounts: number[];
  drawCalls: number;
  triangles: number;
  bucketingMs: number;
  layerMs: number;
  simulationMs: number;
  snapshots: number;
  sharedMemory: boolean;
  tiles: TilesStats | null;
  /** where simulation and LOD bucketing run */
  mode: "worker" | "main";
  traffic: "roads" | "synthetic" | "network";
  roadKm: number;
  workerTickMs: number;
  workerBucketMs: number;
  net: NetStats | null;
  /** current adaptive cap scale (1 = configured caps) */
  lodCapScale: number;
  viewportBox: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  /** the selected vehicle, refreshed with every stats update */
  selected: SelectedVehicle | null;
}

export interface SelectedVehicle extends VehicleState {
  longitude: number;
  latitude: number;
  render: VehicleRenderInfo | null;
  /** LOD asset facts for the current bucket, from manifest.json */
  asset: { file: string; bytes: number } | null;
}

export type BuildingsMode = "tiles" | "osm" | "none";

/** a MapLibre camera, as read back with `MapScene.camera()` */
export interface CameraView {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface MapSceneOptions {
  city: CityConfig;
  /** camera to start from instead of the city's default view (kept across option changes) */
  initialView?: CameraView;
  /** basemap style; defaults to the city's vector style URL */
  basemap?: BasemapConfig;
  /** "tiles": 3D Tiles when configured; "osm": the basemap's extrusions; "none": neither */
  buildings?: BuildingsMode;
  /** opacity of whichever buildings are shown, 0..1; change later with setBuildingOpacity */
  buildingOpacity?: number;
  /** drape the basemap over a DEM and elevate the roads (Terrarium tiles, no key) */
  terrain?: boolean;
  vehicleCount: number;
  /** override the city's tileset URL (e.g. ?tileset=...); "none" disables tiles */
  tilesetUrl?: string | null;
  /** override the tileset ground height for alignment tuning */
  groundHeight?: number;
  /** Cesium ion access token for ion-backed tilesets (else VITE_CESIUM_ION_TOKEN) */
  ionToken?: string | null;
  /** stream vehicle state from the development traffic server instead of simulating locally */
  network?: Omit<WebSocketTrafficOptions, "onFrame" | "onError"> | null;
  /** frame-time-adaptive LOD caps (spec §37); default on */
  adaptiveLod?: boolean;
  vehicle?: string;
  lodConfig?: LodConfig;
  onStats?: (stats: MapSceneStats) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

export class MapScene {
  readonly map: MapLibreMap;
  readonly frame: LocalFrame;
  /** vehicle state: worker-owned shared memory in worker mode, main-thread buffer otherwise */
  buffer: VehicleBuffer;
  private traffic: SimulationSource | null = null;
  private worker: TrafficWorkerClient | null = null;
  private mode: "worker" | "main" = "main";
  private trafficKind: "roads" | "synthetic" | "network" = "synthetic";
  private net: WebSocketTrafficSource | null = null;
  private netTime = -1;
  private netFrameSeen = false;
  private lastViewportSent = 0;
  private readonly adaptive = new AdaptiveLod();
  private readonly viewportBox = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private viewportActive = false;
  private selectedId = -1;
  private lodFiles: { file: string; bytes: number }[] = [];
  private attributesUploaded = false;
  private readonly buildings: BuildingsMode;
  private buildingOpacity: number;
  private heightField: HeightField | null = null;
  private roadKm = 0;
  private readonly loop = new RenderLoop();
  private layer: VehicleLayer | null = null;
  private simTime = 0;
  private snapshots = 0;
  private simMs = 0;
  private disposed = false;
  private readonly opts: MapSceneOptions;

  constructor(container: HTMLElement, opts: MapSceneOptions) {
    this.opts = opts;
    this.frame = new LocalFrame(opts.city.origin);
    this.buffer = new VehicleBuffer(opts.vehicleCount);

    const style = opts.basemap?.style ?? opts.city.styleUrl;
    const deferred = typeof style === "function";
    const buildings = opts.buildings ?? "osm";
    this.buildings = buildings;
    this.buildingOpacity = opts.buildingOpacity ?? 1;
    this.map = new MapLibreMap({
      container,
      style: deferred ? { version: 8, sources: {}, layers: [] } : style,
      center: opts.initialView?.center ?? [
        opts.city.view.center?.longitude ?? opts.city.origin.longitude,
        opts.city.view.center?.latitude ?? opts.city.origin.latitude,
      ],
      zoom: opts.initialView?.zoom ?? opts.city.view.zoom,
      pitch: opts.initialView?.pitch ?? opts.city.view.pitch,
      bearing: opts.initialView?.bearing ?? opts.city.view.bearing,
      maxPitch: 80,
      attributionControl: { compact: true },
    });
    this.map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    this.map.addControl(new NorthControl(), "top-right");
    this.map.addControl(new TopDownControl(), "top-right");
    const onStyle = (): void => {
      this.map.once("style.load", () => {
        void this.addLayer();
      });
    };
    if (deferred) {
      // composed styles (satellite + labels) are built asynchronously, then applied
      style({ extrusions: buildings === "osm" })
        .then((spec) => {
          if (this.disposed) return;
          onStyle();
          this.map.setStyle(spec);
        })
        .catch((err: unknown) => {
          opts.onError?.(`basemap: ${err instanceof Error ? err.message : String(err)}`);
        });
    } else {
      onStyle();
    }
    this.map.on("error", (e: ErrorEvent) => {
      opts.onError?.(e.error.message);
    });
  }

  private async addLayer(): Promise<void> {
    try {
      const vehicle = this.opts.vehicle ?? "porsche";
      const manifest = await loadManifest(vehicle);
      const lods: LodPrimitive[][] = [];
      for (const lod of manifest.lods) {
        const file = lod.optimized ? lod.optimized.file : lod.file;
        lods[lod.id] = (await loadVehicleLod(vehicleAssetUrl(vehicle, file))).primitives;
        this.lodFiles[lod.id] = { file, bytes: lod.optimized ? lod.optimized.bytes : lod.bytes };
      }
      if (this.disposed) return;
      const lodConfig = this.opts.lodConfig ?? DEFAULT_LOD_CONFIG;
      const network = this.opts.network ? null : await this.loadRoads();
      if (this.disposed) return;
      if (this.opts.terrain) {
        try {
          this.heightField = await loadHeightField(this.frame, {
            halfSize: this.opts.city.trafficAreaMetres / 2,
          });
          if (this.disposed) return;
          registerClampedTerrainProtocol();
          this.map.addSource("dem", {
            type: "raster-dem",
            tiles: [clampedTerrainTiles(TERRARIUM_TILES)],
            encoding: "terrarium",
            tileSize: 256,
            maxzoom: 15,
            attribution: "Terrain: AWS Terrain Tiles (Mapzen), SRTM/NED/GMTED",
          });
          this.map.setTerrain({ source: "dem", exaggeration: 1 });
        } catch (err) {
          this.opts.onError?.(`terrain: ${err instanceof Error ? err.message : String(err)}`);
          this.heightField = null;
        }
      }
      if (this.opts.network) {
        // vehicle state arrives over the network; the worker only buckets (when shared memory exists)
        this.trafficKind = "network";
        if (supportsSharedMemory()) {
          this.mode = "worker";
          this.worker = new TrafficWorkerClient({
            count: this.opts.vehicleCount,
            tickInterval: 1 / this.opts.network.rate,
            lodConfig,
            origin: this.opts.city.origin,
            onError: (m) => {
              this.opts.onError?.(`lod worker: ${m}`);
            },
          });
          this.buffer = this.worker.buffer;
        } else {
          this.mode = "main";
          this.buffer.count = this.buffer.capacity;
        }
      } else if (network && supportsSharedMemory()) {
        this.mode = "worker";
        this.trafficKind = "roads";
        this.worker = new TrafficWorkerClient({
          count: this.opts.vehicleCount,
          tickInterval: 0.1,
          lodConfig,
          network,
          origin: this.opts.city.origin,
          driveOnLeft: this.opts.city.driveOnLeft,
          ...(this.heightField ? { heightField: this.heightField.toData() } : {}),
          onReady: (info) => {
            this.roadKm = info.roadKm;
          },
          onError: (m) => {
            this.opts.onError?.(`traffic worker: ${m}`);
          },
        });
        this.buffer = this.worker.buffer;
      } else {
        this.mode = "main";
        if (network) {
          this.trafficKind = "roads";
          const roads = new RoadNetwork(network, (lon, lat) => {
            const p = this.frame.lngLatToLocal({ longitude: lon, latitude: lat });
            return { x: p.x, z: p.z };
          });
          this.roadKm = roads.totalLength / 1000;
          if (this.heightField) roads.applyElevation(this.heightField);
          this.traffic = new RoadTraffic(this.buffer, roads, {
            count: this.opts.vehicleCount,
            seed: 11,
            driveOnLeft: this.opts.city.driveOnLeft,
          });
        } else {
          this.traffic = new SyntheticTraffic(this.buffer, {
            count: this.opts.vehicleCount,
            areaSize: this.opts.city.trafficAreaMetres,
            seed: 7,
          });
        }
        this.traffic.start();
      }
      const tileset = this.resolveTileset();
      const worker = this.worker;
      const layer = new VehicleLayer({
        frame: this.frame,
        buffer: this.buffer,
        lods,
        config: lodConfig,
        lodMode: worker ? "external" : "local",
        ...(worker
          ? {
              onCamera: (cam: LodCamera) => {
                worker.sendCamera(cam);
              },
            }
          : {}),
        ...(tileset ? { tileset } : {}),
        ...(this.heightField ? { heightField: this.heightField.toData() } : {}),
      });
      const showExtrusions = this.buildings === "osm";
      for (const l of this.map.getStyle().layers) {
        if (l.type === "fill-extrusion") {
          this.map.setLayoutProperty(l.id, "visibility", showExtrusions ? "visible" : "none");
        }
      }
      this.applyExtrusionOpacity();
      this.layer = layer;
      if (import.meta.env.DEV) (window as unknown as { __mapScene?: MapScene }).__mapScene = this;
      // below labels: insert before the first symbol layer so text stays readable
      const layers: LayerSpecification[] = this.map.getStyle().layers;
      const firstSymbol = layers.find((l) => l.type === "symbol")?.id;
      this.map.addLayer(layer, firstSymbol);
      if (this.opts.network) {
        this.net = new WebSocketTrafficSource(this.buffer, {
          ...this.opts.network,
          onFrame: (t, kind) => {
            if (this.heightField) this.elevateBuffer(this.heightField);
            if (kind === FrameKind.Full || kind === "json" || !this.netFrameSeen) layer.uploadAttributes();
            this.netFrameSeen = true;
            this.netTime = t;
            this.snapshots++;
            layer.pushSnapshot(t);
          },
          onError: (m) => {
            this.opts.onError?.(m);
          },
        });
      }
      this.startLoop();
      this.opts.onReady?.();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  /** Network feeds carry no elevation: sample the height field for every vehicle. */
  private elevateBuffer(field: HeightField): void {
    const { x, y, z } = this.buffer;
    for (let i = 0; i < this.buffer.count; i++) y[i] = field.sample(x[i] as number, z[i] as number);
  }

  private async loadRoads(): Promise<RoadNetworkFile | null> {
    try {
      const res = await fetch(vehicleAssetUrl("roads", `${this.opts.city.id}.json`));
      if (!res.ok) return null;
      return (await res.json()) as RoadNetworkFile;
    } catch {
      return null;
    }
  }

  /** The current camera, for restoring the view when the scene is rebuilt. */
  camera(): CameraView {
    const c = this.map.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
    };
  }

  /** Opacity of the shown buildings (OSM extrusions or 3D Tiles), 0..1, without a rebuild. */
  setBuildingOpacity(opacity: number): void {
    this.buildingOpacity = opacity;
    if (!this.layer) return; // applied when the layer is added
    this.applyExtrusionOpacity();
    this.layer.cityTiles?.setOpacity(opacity);
  }

  private applyExtrusionOpacity(): void {
    for (const l of this.map.getStyle().layers) {
      if (l.type === "fill-extrusion")
        this.map.setPaintProperty(l.id, "fill-extrusion-opacity", this.buildingOpacity);
    }
  }

  private resolveTileset(): TilesetConfig | null {
    const { city, tilesetUrl, groundHeight } = this.opts;
    if (tilesetUrl === "none" || (this.opts.buildings ?? "osm") !== "tiles") return null;
    const base = city.tileset;
    // with terrain the local y=0 plane is sea level, so the tiles' ground at the origin must
    // land on the DEM elevation there instead of on y=0
    const terrainLift = this.heightField ? this.heightField.sample(0, 0) : 0;
    const common = {
      opacity: this.buildingOpacity,
      groundHeight: (groundHeight ?? base?.groundHeight ?? 0) - terrainLift,
      hideBasemapBuildings: base?.hideBasemapBuildings ?? true,
      ...(base?.attribution ? { attribution: base.attribution } : {}),
      ...(base?.errorTarget ? { errorTarget: base.errorTarget } : {}),
    };
    const url = tilesetUrl ?? base?.url;
    if (url) return { url, ...common };
    if (base?.ion) {
      const env = (import.meta.env as Record<string, string | undefined>).VITE_CESIUM_ION_TOKEN;
      const token = this.opts.ionToken ?? env;
      if (!token) {
        this.opts.onError?.(
          `${city.name}: buildings come from Cesium ion asset ${base.ion.assetId}; set VITE_CESIUM_ION_TOKEN in .env or pass ?ionToken=`,
        );
        return null;
      }
      return { ion: { assetId: base.ion.assetId, token }, ...common };
    }
    return null;
  }

  private startLoop(): void {
    let acc = 0;
    let frames = 0;
    let accMs = 0;
    let last = performance.now();
    this.loop.add((info) => {
      const layer = this.layer;
      if (!layer) return;
      const t0 = performance.now();
      const worker = this.worker;
      const traffic = this.traffic;
      const net = this.net;
      if (net) {
        // network mode: snapshots were pushed by onFrame; keep the render clock one interval behind
        if (this.netTime >= 0) {
          // slew the render clock toward one interval behind the newest snapshot; snap only
          // when it is more than two intervals off (e.g. after a stall)
          const target = this.netTime - net.tickInterval;
          const drift = target - this.simTime;
          if (Math.abs(drift) > 2 * net.tickInterval) this.simTime = target;
          else this.simTime += drift * Math.min(1, info.dt * 2);
        }
        this.simTime += info.dt;
        layer.renderTime = this.simTime;
        if (worker) {
          const buckets = worker.takeBuckets();
          if (buckets) layer.applyBuckets(buckets);
        }
        if (info.now - this.lastViewportSent > 250) {
          this.lastViewportSent = info.now;
          const cam = layer.lodRenderer?.lodCamera;
          const r = this.opts.network?.viewportRadius;
          if (r !== undefined && r > 0) {
            if (cam) net.sendViewport(cam.x - r, cam.x + r, cam.z - r, cam.z + r);
          } else if (cam) {
            // frustum-driven: ground footprint of the view out to the distance where a
            // vehicle drops to the smallest mesh LOD (beyond that it is a box anyway)
            const cfg = this.opts.lodConfig ?? DEFAULT_LOD_CONFIG;
            const maxDistance = (2 * cfg.boundingRadius * cam.focalPx) / (cfg.minPixels[3] * 0.5);
            const box = layer.viewportGroundBox(maxDistance, this.viewportBox);
            net.sendViewport(box.minX, box.maxX, box.minZ, box.maxZ);
          }
          this.viewportActive = true;
        }
      } else if (worker) {
        // worker mode: pull what the worker published since last frame
        const snap = worker.takeSnapshot();
        if (snap) {
          if (!this.attributesUploaded) {
            // the worker spawns vehicles (types, colours) after the layer was created:
            // upload the static attributes once the first snapshot proves they exist
            layer.uploadAttributes();
            this.attributesUploaded = true;
          }
          layer.pushPacked(snap.packed, snap.time);
          this.snapshots++;
          // keep the render clock one tick behind the newest snapshot; resync if it drifts
          const target = snap.time - worker.tickInterval;
          if (Math.abs(this.simTime - target) > worker.tickInterval) this.simTime = target;
        }
        const buckets = worker.takeBuckets();
        if (buckets) layer.applyBuckets(buckets);
        this.simTime += info.dt;
        layer.renderTime = this.simTime;
      } else if (traffic) {
        const ticks = traffic.tick(info.dt);
        this.simTime += info.dt;
        if (ticks > 0) {
          layer.pushSnapshot(this.simTime);
          this.snapshots++;
        }
        // render one tick behind the newest snapshot so interpolation always has a target
        layer.renderTime = this.simTime - traffic.tickInterval;
      }
      this.simMs += performance.now() - t0;
      this.map.triggerRepaint();

      acc += info.dt;
      frames++;
      accMs += info.now - last;
      if (this.opts.adaptiveLod ?? true) {
        const scale = this.adaptive.update(info.now - last, info.dt);
        if (scale !== null) {
          this.worker?.setCapScale(scale);
          layer.lodRenderer?.manager.setCapScale(scale);
        }
      }
      last = info.now;
      if (acc >= 0.5) {
        const s = layer.stats;
        const visible = s.lodCounts.reduce((a, b) => a + b, 0);
        this.lastStats = {
          fps: frames / acc,
          frameMs: accMs / frames,
          vehicles: this.buffer.count,
          visible,
          culled: s.culled,
          outsideFrustum: s.outsideFrustum,
          lodCounts: [...s.lodCounts],
          drawCalls: s.drawCalls,
          triangles: s.triangles,
          bucketingMs: s.bucketingMs,
          layerMs: s.renderMs,
          simulationMs: this.simMs / frames,
          snapshots: this.snapshots,
          sharedMemory: this.buffer.isShared,
          tiles: s.tiles ? { ...s.tiles } : null,
          mode: this.mode,
          traffic: this.trafficKind,
          roadKm: this.roadKm,
          workerTickMs: worker?.tickMs ?? 0,
          workerBucketMs: worker?.bucketMs ?? 0,
          net: net ? { ...net.stats } : null,
          lodCapScale: this.adaptive.scale,
          viewportBox: this.viewportActive ? { ...this.viewportBox } : null,
          selected: this.describe(this.selectedId),
        };
        this.opts.onStats?.(this.lastStats);
        acc = 0;
        frames = 0;
        accMs = 0;
        this.simMs = 0;
      }
    });
    this.loop.start();
  }

  /** Debug: last stats object passed to onStats (dev tooling). */
  lastStats: MapSceneStats | null = null;

  /** Debug access for tooling (dev only). */
  get vehicleLayer(): VehicleLayer | null {
    return this.layer;
  }

  private runningFlag = true;

  get running(): boolean {
    return this.runningFlag;
  }

  setRunning(on: boolean): void {
    this.runningFlag = on;
    this.worker?.setRunning(on);
    if (this.traffic) {
      if (on) this.traffic.start();
      else this.traffic.stop();
    }
  }

  /** Vehicle under a screen point, selected for live inspection, or null. */
  pick(clientX: number, clientY: number): SelectedVehicle | null {
    const id = this.layer?.pick(clientX, clientY) ?? -1;
    this.select(id);
    return this.describe(id);
  }

  select(id: number): void {
    this.selectedId = id;
    this.layer?.setSelected(id);
  }

  /** Current state, geographic position and rendering facts of a vehicle. */
  describe(id: number): SelectedVehicle | null {
    if (id < 0 || id >= this.buffer.count) return null;
    const v = this.buffer.get(id);
    const ll = this.frame.localToLngLat({ x: v.x, y: v.y, z: v.z });
    const render = this.layer?.inspect(id) ?? null;
    const asset =
      render && render.bucket < this.lodFiles.length ? (this.lodFiles[render.bucket] ?? null) : null;
    return { ...v, longitude: ll.longitude, latitude: ll.latitude, render, asset };
  }

  dispose(): void {
    this.disposed = true;
    this.loop.stop();
    this.traffic?.dispose();
    this.net?.dispose();
    this.worker?.dispose();
    this.map.remove(); // removes the custom layer and calls onRemove
  }
}
