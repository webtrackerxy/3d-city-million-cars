# 3D City With a Million Moving Cars

A web-based traffic digital twin prototype: a MapLibre GL basemap, a Three.js custom
layer that draws up to 1,000,000 GPU-instanced vehicles with automatic level of detail,
OGC 3D Tiles buildings, road-following traffic simulated in a Web Worker, and a binary
network protocol for streaming vehicle state from a server.

**Live demo:** [3d-city-million-cars.vercel.app](https://3d-city-million-cars.vercel.app)



https://github.com/user-attachments/assets/3d848dfa-1190-43e1-b38a-05c0a8d0221b



- `docs/system-design.md` — architecture, threads and shared memory, the frame, level of
  detail, simulation, deployment and failure modes.
- `docs/performance.md`, `docs/network.md` — measurements.
- `docs/coordinates.md` — units, axes, origins and the transforms between Blender, glTF,
  Three.js, MapLibre and 3D Tiles.

## What it does

| Area | Delivered |
| --- | --- |
| Vehicle assets | Porsche 911 source (653k triangles) → LOD0 146k / LOD1 33k / LOD2 5.4k / LOD3 830 triangles through a repeatable Blender pipeline, quantised + meshopt GLBs, validator, `/lod-test` viewer with labels |
| Rendering | Structure-of-Arrays vehicle state in shared memory, GPU state-texture interpolation, projected-size LOD buckets with hysteresis and adaptive caps, one instanced draw per bucket and material |
| Map | MapLibre custom layer with float64 coordinate handling, five cities (London, Tokyo, New York, Hong Kong, New Delhi), vector or satellite basemaps, click to inspect a vehicle (position, speed, LOD, mesh cost, draw calls), selected vehicle highlighted |
| Buildings | 3D Tiles via `3d-tiles-renderer`: PLATEAU (open) for Tokyo, Cesium OSM Buildings via Cesium ion for London, New York and Hong Kong |
| Traffic | OpenStreetMap road graphs per city, IDM car following, simulation and LOD bucketing in a Web Worker over `SharedArrayBuffer` |
| Network | FULL / DELTA / VIEWPORT binary frames and JSON, a WebSocket traffic server, frustum-driven viewport subscription, dead reckoning |
| Measurement | `/bench` scenarios, a Playwright runner, GPU timer queries |

Headline numbers on an Apple M1 Pro (details in `docs/performance.md`): 1,000,000
road-following vehicles in London, Tokyo or New York at 60 FPS, 0.1–0.2 ms of
main-thread time per frame for the vehicle layer, 75–79 ms per 100 ms simulation tick in
the worker. At 100,000 vehicles with 3D Tiles the layer takes 0.2–0.5 ms and the tick
7–8 ms; the network feed needs 1–12 Mbit/s with viewport subscription at 10 Hz versus
268 Mbit/s for JSON.

## Quick start

```bash
npm install
npm run dev          # Vite prints the port (5173 if free); open the URL, the map is the landing page
```

Optional:

- **Cesium ion buildings (London, New York, Hong Kong, New Delhi):** create a free account at
  https://ion.cesium.com, copy an access token into `.env` as
  `VITE_CESIUM_ION_TOKEN=...` (template in `.env.example`; `.env` is git-ignored), or pass
  `?ionToken=...` on the URL, then choose "3D Tiles" in the buildings selector (or
  `?buildings=tiles`). OSM extrusions are the default and need no key.
- **Network feed:** `npm run server` starts the traffic server on `ws://localhost:8787`;
  then open `/?source=ws&format=binary&mode=viewport&rate=10`.
- **Blender pipeline:** Blender 5.2 LTS (`brew install --cask blender@lts`) and the Porsche
  source model from Sketchfab in `assets/source/porsche/` (login required; see its
  `LICENSE.md`). Only needed to regenerate the LOD assets, which are committed.

Requirements: Node 24 or newer, a WebGL2 browser (Chrome recommended: the benchmark
runner and diagnostics use the installed Chrome through Playwright).

## Pages and URL parameters

| Page | Purpose |
| --- | --- |
| `/` | the city map (also `/map`); the opacity slider beside the buildings selector fades the OSM extrusions or 3D Tiles so vehicles behind them show through (OSM starts at 80 %, tiles at 100 %); changing the basemap, buildings, terrain or vehicle count keeps the camera, switching city resets it; under the zoom buttons a north arrow rotates with the view and points the map north when clicked (tilt kept), and the control below it looks straight down and restores the tilt on a second click |
| `/about` | overview and links |
| `/lod-test` | the four LODs side by side with statistics and floating labels |
| `/bench` | benchmark scenarios |

Map parameters (combine freely):

| Parameter | Values | Effect |
| --- | --- | --- |
| `city` | `london` (default), `tokyo`, `newyork`, `hongkong`, `newdelhi` | city origin, roads, tileset |
| `vehicles` | `1` to `1000000` | fleet size, capped at what the city's roads hold: London, Tokyo (20 km networks) and New York (26 km) default to and allow 1,000,000; Hong Kong and New Delhi default to and allow 100,000 on 8 km networks |
| `basemap` | `vector` (default), `satellite`, `imagery` | OpenFreeMap Liberty vector style; Esri World Imagery with the vector style's labels and road shields composed on top; imagery without labels (OSM building extrusions still available) |
| `buildings` | `osm` (default), `tiles`, `none` | the basemap's OpenStreetMap extrusions (also on the satellite basemaps); 3D Tiles buildings when the city has a tileset; or no buildings |
| `terrain` | `1` / `0` | drape the basemap over a DEM (AWS Terrarium tiles clamped at sea level, no key) and elevate the road network so vehicles follow the ground and tilt with its slope; on by default in every city (`?terrain=0` turns it off); Hong Kong shows it best |
| `tileset` | a `tileset.json` URL, or `none` | override or disable the 3D Tiles buildings (CORS required) |
| `ground` | metres | ellipsoid height of the ground at the origin, to align a dataset with the road plane |
| `ionToken` | token | Cesium ion access token (or `VITE_CESIUM_ION_TOKEN`) |
| `source=ws` | with `ws`, `format=binary\|json`, `mode=full\|delta\|viewport`, `rate`, `predict=1`, `vpr` | stream vehicle state from the traffic server instead of simulating locally |

Basemap sources: OpenFreeMap (OpenMapTiles, OpenStreetMap data) for the vector style and
labels; Esri World Imagery for satellite tiles, which is suitable for development and
demos but whose terms restrict production use.

## Commands

```bash
npm run dev               # dev server
npm run check             # typecheck (app + scripts + server) + eslint + prettier + dependency-cruiser + vitest
npm run build             # production build to dist/ (assets/generated copied to dist/vehicles)
npm run bench -- --base http://localhost:<port>   # run all benchmark scenarios in Chrome, write docs/benchmarks/latest.md
npm run probe -- <url> <png> [zoom pitch bearing]  # jump the map to a view, print stats, screenshot
node tooling/scale-probe.mjs london 100000 1000000   # frame, worker and LOD cost per fleet size
node tooling/flow-probe.mjs london 100000 1000000    # mean speed and share of stopped cars per fleet size
npm run diag -- <url> <png>                        # console output + screenshot of any page
npm run server            # traffic WebSocket server (Tokyo, 100k vehicles, 10 Hz)
npm run net:bench         # codec sizes and encode/decode cost for 100k vehicles
npm run roads             # rebuild assets/generated/roads/<city>.json from OpenStreetMap (Overpass)
npm run assets            # Blender: generate LODs -> optimise -> validate -> previews
```

## Layout

```
assets/source/<vehicle>/      untouched downloads + LICENSE.md + source-manifest.json (model itself is git-ignored)
assets/generated/<vehicle>/   car_lodN.glb, car_lodN.opt.glb, manifest.json
assets/generated/roads/       <city>.json road graphs from OpenStreetMap (ODbL)
scripts/                      Blender pipeline (generate-car-lods.py, lod-config.json, blender/*), Node tooling (*.ts)
server/                       traffic-server.ts (WebSocket) and net-bench.ts, run with tsx
src/types, src/config         leaf types and configuration (cities, basemaps + hybrid style builder, LOD)
src/geo, src/lod              pure Mercator/local-frame maths and LOD selection (worker-importable)
src/data                      VehicleBuffer (Structure of Arrays over SharedArrayBuffer), manifest loading
src/simulation, src/workers   road network, IDM traffic, shared-memory layout, traffic worker + client
src/net                       wire protocol and WebSocketTrafficSource
src/rendering                 render loop, state texture, instanced material, LOD renderer, GLB loading
src/map                       LocalFrame integration, VehicleLayer (MapLibre custom layer), CityTiles, MapScene
src/pages, src/components     React UI only; no per-vehicle state in React
tooling/                      Vite plugin (asset routes, benchmark persistence), Playwright utilities
docs/                         system design, coordinate conventions, measurements
```

## Conventions

Vehicle assets are metres with the origin on the ground at the wheelbase midpoint,
forward +Z and up +Y in glTF/Three.js. Vehicle positions are float32 metres from a
per-city origin; everything geographic is computed in float64. Canonical material
names are `paint`, `window`, `glass`, `chrome`, `dark`, `rubber`, `lights`, `calliper`,
`license`; the runtime tints `paint` per vehicle. Details in `docs/coordinates.md`.

## Data and licences

- Porsche 911 Carrera 4S by Lionsharp Studios, CC BY 4.0 (`assets/source/porsche/LICENSE.md`).
- Road graphs: © OpenStreetMap contributors, ODbL.
- Tokyo buildings: PLATEAU (MLIT Japan), CC BY 4.0. London and New York buildings: Cesium
  OSM Buildings, © OpenStreetMap contributors, via Cesium ion under its terms (also Hong Kong
  and New Delhi).
- Basemaps: OpenFreeMap / OpenMapTiles; Esri World Imagery under Esri's terms.
- Terrain: AWS Terrain Tiles (Terrarium), derived from SRTM, NED, GMTED and others; see
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md.

## Deploy

The app needs cross-origin isolation, because vehicle state lives in a `SharedArrayBuffer`
shared with the traffic worker. `vercel.json` sets the three headers that requires
(`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`)
on every response, and rewrites unknown paths to `index.html` for the client routes. Any
other host must send the same headers; without them the app still runs, but the simulation
and level-of-detail selection move onto the main thread and cost frame time.

```sh
npm run build          # dist/ is self-contained: app, decoders, vehicle LODs, road graphs
vercel --prod          # or connect the repository in the Vercel dashboard
```

Set `VITE_CESIUM_ION_TOKEN` in the host's environment to enable the Cesium 3D Tiles
buildings for London, New York, Hong Kong and New Delhi. Without it those cities fall back to
OpenStreetMap extrusions, which is the default anyway; Tokyo's PLATEAU tiles need no token.

