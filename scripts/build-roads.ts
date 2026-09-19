/**
 * Build a drivable road network per city from OpenStreetMap via the Overpass API
 * (phase C4, spec §31 "road trajectories").
 *
 *   node scripts/build-roads.ts [--city tokyo] [--all] [--size 4000] [--out assets/generated/roads]
 *
 * Output `<out>/<city>.json` (RoadNetworkFile): nodes as [lon, lat] pairs in a flat
 * array, directed edges as [fromNode, toNode, speedMps, highwayClass] in a flat array
 * (one-way streets emit one direction, others both). Geometry stays in WGS84 so the file
 * is independent of the app's local frame; the app converts once at load.
 *
 * City origins are read from src/config/cityConfig.ts by a light regex so this script
 * stays free of src/ imports (dependency rule: scripts are standalone).
 *
 * Data © OpenStreetMap contributors, ODbL. Overpass is a shared free service: areas up
 * to TILE_METRES are one bbox query; larger areas are split into a grid of tiles queried
 * one after another with a pause between them, and ways that cross tile edges are
 * de-duplicated by OSM id. Every query retries politely across mirrors.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface CityOrigin {
  id: string;
  longitude: number;
  latitude: number;
  size: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const HIGHWAY_CLASSES: Record<string, { speedKph: number; rank: number }> = {
  motorway: { speedKph: 80, rank: 0 },
  motorway_link: { speedKph: 50, rank: 1 },
  trunk: { speedKph: 60, rank: 2 },
  trunk_link: { speedKph: 40, rank: 3 },
  primary: { speedKph: 50, rank: 4 },
  primary_link: { speedKph: 35, rank: 5 },
  secondary: { speedKph: 45, rank: 6 },
  secondary_link: { speedKph: 30, rank: 7 },
  tertiary: { speedKph: 40, rank: 8 },
  tertiary_link: { speedKph: 30, rank: 9 },
  unclassified: { speedKph: 30, rank: 10 },
  residential: { speedKph: 30, rank: 11 },
  living_street: { speedKph: 15, rank: 12 },
};

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

function readCities(): CityOrigin[] {
  const src = readFileSync(resolve("src/config/cityConfig.ts"), "utf8");
  const cities: CityOrigin[] = [];
  const re =
    /id:\s*"([a-z]+)"[\s\S]*?origin:\s*\{\s*longitude:\s*(-?[\d.]+),\s*latitude:\s*(-?[\d.]+)\s*\}[\s\S]*?trafficAreaMetres:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    cities.push({ id: m[1] as string, longitude: Number(m[2]), latitude: Number(m[3]), size: Number(m[4]) });
  }
  return cities;
}

function parseMaxspeed(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph)?/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? n * 1.609 : n;
}

/** largest square queried in one Overpass request */
const TILE_METRES = 10000;

async function fetchWays(city: CityOrigin): Promise<OverpassWay[]> {
  const n = Math.max(1, Math.ceil(city.size / TILE_METRES));
  const dLat = city.size / 2 / 111320;
  const dLon = city.size / 2 / (111320 * Math.cos((city.latitude * Math.PI) / 180));
  const south = city.latitude - dLat;
  const west = city.longitude - dLon;
  const byId = new Map<number, OverpassWay>();
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const s0 = south + ((2 * dLat) / n) * row;
      const w0 = west + ((2 * dLon) / n) * col;
      const bbox = `${s0},${w0},${s0 + (2 * dLat) / n},${w0 + (2 * dLon) / n}`;
      if (n > 1) process.stdout.write(`\n  tile ${row * n + col + 1}/${n * n} `);
      for (const way of await fetchBbox(bbox, city.id)) byId.set(way.id, way);
      if (n > 1 && row * n + col + 1 < n * n) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (n > 1) process.stdout.write("\n  ");
  return [...byId.values()];
}

async function fetchBbox(bbox: string, cityId: string): Promise<OverpassWay[]> {
  const classes = Object.keys(HIGHWAY_CLASSES).join("|");
  const query = `[out:json][timeout:180];way["highway"~"^(${classes})$"](${bbox});out geom;`;
  for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length] as string;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "3d-city-million-cars/0.0 (road network builder; github.com/webtrackerxy)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (res.ok) {
        const json = (await res.json()) as { elements: OverpassWay[] };
        return json.elements.filter((e) => e.type === "way" && Array.isArray(e.geometry));
      }
      console.warn(`\n  ${endpoint}: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`\n  ${endpoint}: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`overpass failed for ${cityId} (${bbox})`);
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function build(city: CityOrigin, ways: OverpassWay[]) {
  const nodeIndex = new Map<number, number>();
  const nodes: number[] = [];
  const edges: number[] = [];
  const classIds = Object.keys(HIGHWAY_CLASSES);
  let totalLength = 0;
  let oneWayCount = 0;
  for (const way of ways) {
    const hw = way.tags?.highway ?? "";
    const cls = HIGHWAY_CLASSES[hw];
    if (!cls || way.nodes.length !== way.geometry.length) continue;
    const oneway =
      way.tags?.oneway === "yes" || way.tags?.oneway === "1" || hw === "motorway" || hw === "motorway_link";
    const reversed = way.tags?.oneway === "-1";
    const speedKph = parseMaxspeed(way.tags?.maxspeed) ?? cls.speedKph;
    const speedMps = +(speedKph / 3.6).toFixed(2);
    const classId = classIds.indexOf(hw);
    if (oneway) oneWayCount++;
    const idx: number[] = way.nodes.map((id, i) => {
      let k = nodeIndex.get(id);
      if (k === undefined) {
        k = nodes.length / 2;
        nodeIndex.set(id, k);
        const g = way.geometry[i] as { lat: number; lon: number };
        nodes.push(+g.lon.toFixed(7), +g.lat.toFixed(7));
      }
      return k;
    });
    for (let i = 0; i + 1 < idx.length; i++) {
      const a = idx[i] as number;
      const b = idx[i + 1] as number;
      const ga = way.geometry[i] as { lat: number; lon: number };
      const gb = way.geometry[i + 1] as { lat: number; lon: number };
      const len = haversine(ga.lon, ga.lat, gb.lon, gb.lat);
      if (len < 0.05) continue;
      totalLength += len;
      if (reversed) edges.push(b, a, speedMps, classId);
      else {
        edges.push(a, b, speedMps, classId);
        if (!oneway) edges.push(b, a, speedMps, classId);
      }
    }
  }
  return {
    city: city.id,
    origin: { longitude: city.longitude, latitude: city.latitude },
    sizeMetres: city.size,
    source: "OpenStreetMap via Overpass API, © OpenStreetMap contributors (ODbL)",
    generatedAt: new Date().toISOString(),
    highwayClasses: classIds,
    stats: {
      ways: ways.length,
      nodes: nodes.length / 2,
      directedEdges: edges.length / 4,
      oneWayWays: oneWayCount,
      roadKm: +(totalLength / 1000).toFixed(1),
    },
    nodes,
    edges,
  };
}

async function main(): Promise<void> {
  const out = resolve(arg("out", "assets/generated/roads"));
  mkdirSync(out, { recursive: true });
  const all = process.argv.includes("--all");
  const only = arg("city", "tokyo");
  const sizeOverride = Number(arg("size", "0"));
  const cities = readCities().filter((c) => all || c.id === only);
  if (cities.length === 0) throw new Error(`no city matched (${only})`);
  for (const city of cities) {
    if (sizeOverride > 0) city.size = sizeOverride;
    process.stdout.write(
      `${city.id}: fetching ${city.size} m square around ${city.latitude}, ${city.longitude} … `,
    );
    const t0 = Date.now();
    const ways = await fetchWays(city);
    const network = build(city, ways);
    const file = resolve(out, `${city.id}.json`);
    writeFileSync(file, JSON.stringify(network));
    const kb = (readFileSync(file).length / 1024).toFixed(0);
    console.log(
      `${network.stats.ways} ways, ${network.stats.nodes} nodes, ${network.stats.directedEdges} directed edges, ` +
        `${network.stats.roadKm} km, ${kb} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
  }
}

await main();
