/**
 * /map: MapLibre basemap with the vehicle custom layer, debug overlay and vehicle
 * selection (spec §2, §39). All engine state lives in MapScene.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import "maplibre-gl/dist/maplibre-gl.css";
import { BASEMAPS, DEFAULT_BUILDING_OPACITY, basemapById } from "@/config/basemaps.ts";
import { CITIES, cityById } from "@/config/cityConfig.ts";
import {
  MapScene,
  type CameraView,
  type BuildingsMode,
  type MapSceneStats,
  type SelectedVehicle,
} from "@/map/MapScene.ts";
import { DebugOverlay } from "@/components/DebugOverlay.tsx";
type Picked = SelectedVehicle | null;

const COUNTS = [1000, 10000, 50000, 100000, 250000, 500000, 1000000];
/** upper bound for `?vehicles=`; buffers, textures and bucket lists are sized from it */
const MAX_VEHICLES = 1_000_000;

/** a valid `?vehicles=` value, or null to use the city's default */
function requestedCount(param: string | null): number | null {
  const n = Number(param);
  return param !== null && Number.isInteger(n) && n >= 1 && n <= MAX_VEHICLES ? n : null;
}

export function MapPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const [search, setSearch] = useSearchParams();
  const city = cityById(search.get("city"));
  const basemap = basemapById(search.get("basemap"));
  const terrainParam = search.get("terrain");
  const terrain = terrainParam === null ? city.terrain : terrainParam === "1";
  const buildingsParam = search.get("buildings");
  const buildings: BuildingsMode =
    buildingsParam === "tiles" || buildingsParam === "none" ? buildingsParam : "osm";
  // null until the user moves the slider, so each buildings mode keeps its own look
  const [opacityChoice, setOpacityChoice] = useState<number | null>(null);
  const buildingOpacity =
    opacityChoice ?? (buildings === "tiles" ? DEFAULT_BUILDING_OPACITY.tiles : DEFAULT_BUILDING_OPACITY.osm);

  const tilesetUrl = search.get("tileset");
  const ionToken = search.get("ionToken");
  const groundParam = search.get("ground");
  const groundHeight = groundParam === null ? undefined : Number(groundParam);
  const sourceParam = search.get("source");
  const modeParam = search.get("mode");
  const mode: "full" | "delta" | "viewport" =
    modeParam === "delta" || modeParam === "viewport" ? modeParam : "full";
  const network =
    sourceParam === "ws"
      ? {
          url: search.get("ws") ?? "ws://localhost:8787",
          format: search.get("format") === "json" ? ("json" as const) : ("binary" as const),
          mode,
          rate: Number(search.get("rate") ?? "10"),
          predict: search.get("predict") === "1",
          viewportRadius: Number(search.get("vpr") ?? "0"),
        }
      : null;
  const networkKey = JSON.stringify(network);
  // null until the user picks a count, so each city opens at its own default
  const [count, setCount] = useState<number | null>(() => requestedCount(search.get("vehicles")));
  // limited to what this city's road network can hold
  const vehicles = Math.min(count ?? city.defaultVehicles, city.maxVehicles);
  const [running, setRunning] = useState(true);
  const [stats, setStats] = useState<MapSceneStats | null>(null);
  const [picked, setPicked] = useState<Picked>(null);
  const [error, setError] = useState<string | null>(null);

  // camera of the scene being torn down, restored when the rebuild is for the same city
  const lastCameraRef = useRef<{ cityId: string; view: CameraView } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const last = lastCameraRef.current;
    const scene = new MapScene(host, {
      city,
      ...(last?.cityId === city.id ? { initialView: last.view } : {}),
      basemap,
      buildings,
      terrain,
      vehicleCount: vehicles,
      tilesetUrl,
      ionToken,
      network,
      ...(groundHeight !== undefined && Number.isFinite(groundHeight) ? { groundHeight } : {}),
      onStats: setStats,
      onError: setError,
    });
    sceneRef.current = scene;
    return () => {
      lastCameraRef.current = { cityId: city.id, view: scene.camera() };
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `network` is compared through its serialised key
  }, [vehicles, city, basemap, buildings, terrain, tilesetUrl, groundHeight, networkKey, ionToken]);

  // applied after every rebuild too, so a new basemap or city keeps the chosen opacity
  useEffect(() => {
    sceneRef.current?.setBuildingOpacity(buildingOpacity);
  }, [
    buildingOpacity,
    vehicles,
    city,
    basemap,
    buildings,
    terrain,
    tilesetUrl,
    groundHeight,
    networkKey,
    ionToken,
  ]);

  useEffect(() => {
    sceneRef.current?.setRunning(running);
  }, [running, vehicles, city, basemap, buildings, terrain, tilesetUrl, groundHeight, networkKey, ionToken]);

  return (
    <div className="map-page">
      <div
        ref={hostRef}
        className="canvas-host"
        onClick={(e) => {
          setPicked(sceneRef.current?.pick(e.clientX, e.clientY) ?? null);
        }}
      />
      <LivePanel
        picked={picked}
        stats={stats}
        onClose={() => {
          sceneRef.current?.select(-1);
          setPicked(null);
        }}
      />
      <div className="map-controls">
        <label>
          city{" "}
          <select
            value={city.id}
            onChange={(e) => {
              const next = new URLSearchParams(search);
              next.set("city", e.target.value);
              setSearch(next);
              setPicked(null);
            }}
          >
            {Object.values(CITIES).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          basemap{" "}
          <select
            value={basemap.id}
            onChange={(e) => {
              const next = new URLSearchParams(search);
              next.set("basemap", e.target.value);
              setSearch(next);
            }}
          >
            {Object.values(BASEMAPS).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          buildings{" "}
          <select
            value={buildings}
            onChange={(e) => {
              const next = new URLSearchParams(search);
              next.set("buildings", e.target.value);
              setSearch(next);
            }}
          >
            <option value="osm">OSM extrusions</option>
            <option value="tiles">3D Tiles{city.tileset ? "" : " (not configured)"}</option>
            <option value="none">none</option>
          </select>
        </label>
        <label
          className="opacity-control"
          title="Building opacity: lower it to see vehicles behind buildings"
        >
          opacity{" "}
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(buildingOpacity * 100)}
            disabled={buildings === "none"}
            aria-label="Building opacity"
            onChange={(e) => {
              setOpacityChoice(Number(e.target.value) / 100);
            }}
          />
          <span className="opacity-value">{Math.round(buildingOpacity * 100)}%</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={terrain}
            onChange={(e) => {
              const next = new URLSearchParams(search);
              // explicit 0/1 so the choice survives switching between cities with different defaults
              next.set("terrain", e.target.checked ? "1" : "0");
              setSearch(next);
            }}
          />{" "}
          terrain
        </label>
        <label>
          vehicles{" "}
          <select
            value={vehicles}
            onChange={(e) => {
              setCount(Number(e.target.value));
            }}
          >
            {[...new Set([...COUNTS.filter((c) => c <= city.maxVehicles), vehicles])]
              .sort((a, b) => a - b)
              .map((c) => (
                <option key={c} value={c}>
                  {c.toLocaleString()}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setRunning((r) => !r);
          }}
        >
          {running ? "pause" : "resume"}
        </button>
        <span className="muted">click a vehicle to inspect</span>
        {city.tileset?.attribution && !tilesetUrl && (
          <span className="muted">{city.tileset.attribution}</span>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      <DebugOverlay stats={stats} />
    </div>
  );
}

function LivePanel({
  picked,
  stats,
  onClose,
}: {
  picked: Picked;
  stats: MapSceneStats | null;
  onClose: () => void;
}) {
  // prefer the live description from the latest stats (same id), fall back to the click result
  const live = stats?.selected;
  const v = live?.id === picked?.id ? (live ?? picked) : picked;
  if (!v) return null;
  const r = v.render;
  const rows: [string, string][] = [
    ["Position", `${v.latitude.toFixed(6)}, ${v.longitude.toFixed(6)}`],
    ["Local (m)", `${v.x.toFixed(1)}, ${v.z.toFixed(1)}`],
    ["Heading", `${((v.heading * 180) / Math.PI).toFixed(0)}°`],
    ["Speed", `${(v.speed * 3.6).toFixed(0)} km/h`],
    ["Type / colour", `${v.vehicleType} / ${v.colorIndex}`],
  ];
  if (r) {
    rows.push(
      ["LOD bucket", r.bucketName],
      ["Distance", `${r.distance.toFixed(0)} m`],
      ["Projected size", Number.isFinite(r.sizePx) ? `${r.sizePx.toFixed(0)} px` : "∞"],
      [
        "Mesh",
        r.bucket <= 4
          ? `${r.triangles.toLocaleString()} tris · ${r.vertices.toLocaleString()} verts`
          : "not drawn",
      ],
      ["Draw calls", r.primitives.length ? `${r.primitives.length} (${r.primitives.join(", ")})` : "0"],
    );
    if (v.asset) rows.push(["GLB", `${v.asset.file} · ${(v.asset.bytes / 1024).toFixed(0)} KB`]);
  }
  return (
    <aside className="panel vehicle-panel">
      <h2>Vehicle #{v.id}</h2>
      <table className="stats">
        <tbody>
          {rows.map(([k, val]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={onClose}>
        close
      </button>
    </aside>
  );
}
