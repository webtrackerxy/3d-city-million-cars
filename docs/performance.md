# Performance Report

Hardware: **Apple M1 Pro, 16 GB**, Google Chrome 152, ANGLE Metal backend, 60 Hz display.
Runs use `scripts/run-benchmarks.ts` (Playwright driving the installed Chrome), viewport
1600 × 900 at pixel ratio 1, camera preset "city" (350 m altitude looking across a 3 km
square), 3 s warm-up, 10 s recording. Raw results per run are under `docs/benchmarks/`.
Reproduce with `npm run dev` then `npm run bench -- --base http://localhost:<port>`.

Metric definitions: *frame* is the wall-clock interval between frames (vsync-bound at
16.7 ms); *CPU* is JavaScript time for scenario update plus draw submission; *GPU* is
`EXT_disjoint_timer_query_webgl2` time for the frame's draw calls.

## 1. Benchmarks 1 and 2: 100,000 cubes (2026-09-17)

| Scenario | FPS | Frame p50 | Frame p95 | CPU mean | GPU mean | Draw calls | Triangles | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B1 static cubes | 60.0 | 16.66 ms | 17.75 ms | 0.06 ms | 2.53 ms | 1 | 1.2 M | matrices uploaded once |
| B2a moving, CPU matrices | 60.0 | 16.64 ms | 18.63 ms | **6.80 ms** | 2.03 ms | 1 | 1.2 M | 100k `setMatrixAt` + 6.4 MB upload per frame; matrix loop alone 6.43 ms |
| B2b moving, GPU state texture | 60.0 | 16.71 ms | 23.75 ms | **0.44 ms** | 2.59 ms | 1 | 1.2 M | 10 Hz simulation tick + 1.6 MB snapshot pack (0.3 ms per upload); shader interpolation |

Conclusions:

- Instancing 100k objects is not the bottleneck: one draw call, 2.5 ms GPU.
- **Per-frame CPU matrix updates cost 6.8 ms of the 16.7 ms frame budget** before any
  simulation, LOD or map work. This is the path the spec warned about (§34) and it is
  measured, not assumed.
- **The state-texture path costs 0.44 ms per frame**, of which most is the 10 Hz
  simulation step for 100k vehicles. The texture upload itself (two 1.6 MB RGBA32F
  uploads at 10 Hz) shows up as the higher p95; a single-texture ping-pong or
  `texSubImage2D` of only the changed rows would reduce it if it matters later.
- Decision: vehicle transforms live on the GPU (`VehicleStateTexture` +
  `InstancedVehicleMaterial`); the CPU never touches per-vehicle matrices.

## 2. Triangle throughput sweep (2026-09-17)

20,000 static sphere instances, N triangles each, one draw call:

| Triangles per instance | Triangles per frame | FPS | Frame p50 | GPU mean | Sustained rate |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 196 | 3.9 M | 60.0 | 16.7 ms | 2.97 ms | 1.3 G tri/s |
| 1,024 | 20.5 M | 60.0 | 16.6 ms | 9.18 ms | 2.2 G tri/s |
| 5,112 | 102 M | 15.9 | 32.0 ms | 60.5 ms | 1.7 G tri/s |
| 20,022 | 400 M | 4.0 | 120 ms | 187 ms | 2.1 G tri/s |

Conclusions:

- The GPU sustains roughly **2 G triangles/s** on this machine with a trivial material.
  At 60 FPS the whole frame is 16.7 ms, so **~25 M triangles/frame is the hard ceiling
  and ~15 M is the practical vehicle budget** once the basemap, 3D Tiles and a real
  lighting model take their share.
- Applied to the LOD set (146k / 33k / 5.4k / 830 triangles), the budget forces small
  near buckets and a cheap far field. Example allocation within 15 M:

  | Bucket | Instances | Triangles |
  | --- | ---: | ---: |
  | LOD0 | 20 | 2.9 M |
  | LOD1 | 150 | 5.0 M |
  | LOD2 | 800 | 4.3 M |
  | LOD3 | 3,000 | 2.5 M |
  | box (12 tris) | 96,000 | 1.2 M |
  | **Total** | 100,000 | **15.9 M** |

  The spec's illustrative distribution (100 / 1,500 / 12,000 / 86,400) would need
  ~200 M triangles and is ruled out by measurement. Phase B4 tunes the caps by
  projected size and re-measures.

## 3. Benchmarks 3 and 4: real car meshes with runtime LOD (2026-09-17)

Optimised GLBs, 100,000 vehicles in a 3 km square, 10 Hz synthetic traffic, GPU state
texture. The display ran at 120 Hz for these runs, so FPS caps at 120.

| Scenario | Visible / drawn | Buckets LOD0 / 1 / 2 / 3 / box | Triangles | Draw calls | CPU mean | GPU mean | FPS |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| B3 all cars LOD3 (city) | 53,285 | 0 / 0 / 0 / 53,285 / 0 | 44.2 M | 4 | 4.19 ms | **29.3 ms** | 40 |
| B4 bucketed (city, caps 20/150/800/3000) | 53,285 | 0 / 0 / 0 / 3,000 / 50,285 | 3.1 M | 5 | 3.94 ms | 2.7 ms | 120 |
| B4 bucketed (street, caps 20/150/800/3000) | 27,101 | 6 / 34 / 475 / 3,000 / 23,586 | 7.3 M | 25 | 3.48 ms | 2.7 ms | 120 |
| B4 bucketed (street, caps 20/300/1500/8000) | 27,101 | 6 / 34 / 475 / 6,093 / 20,493 | 9.9 M | 25 | 3.38 ms | 5.1 ms | 120 |

CPU mean includes the LOD bucketing pass, measured separately at **3.1–3.7 ms per frame
for 100k vehicles** (frustum test, projected size, hysteresis, counting sort, id
scatter). Frustum culling removes 47 % of the vehicles at the city preset and 73 % at
street level before any drawing.

Conclusions:

- **The LOD manager is what makes 100k feasible.** Drawing every visible car at LOD3
  costs 29 ms of GPU (40 FPS); the bucketed set draws the same scene in 2.7 ms.
- **Caps work as designed.** At street level the six nearest cars get LOD0, the next 34
  LOD1, 475 LOD2 (the size threshold, not the cap, limits LOD2 here), 3,000 LOD3, and the
  rest are boxes; draw calls stay at 25 regardless of vehicle count.
- **Headroom is real.** Widening LOD3 to 8,000 raises GPU time to 5.1 ms for 9.9 M
  triangles; the practical 15 M budget leaves room for the basemap and 3D Tiles.
  Recommended starting caps for C1: 20 / 300 / 1,500 / 8,000.
- **Bucketing cost is now the largest CPU item** (3.5 ms). Options if it matters once
  the map and simulation share the main thread: run it every second frame (positions
  change little between frames), move it to the traffic worker (it only needs the SoA
  buffer and 24 floats of camera state), or cull by coarse grid cells first.
- **Not yet covered:** LOD popping is controlled by threshold hysteresis but not by cap
  hysteresis; vehicles at a cap boundary can alternate between two LODs as they move.
  A visual check (`docs/previews/bench-cars-lod-street.png`) shows correct headings,
  tints and LOD placement.

## 4. C2: MapLibre integration (2026-09-17, overlay readings)

`/map` page, Tokyo origin, OpenFreeMap Liberty style with extruded buildings, 100,000
synthetic vehicles, default LOD caps 20/300/1500/8000, 1400 × 800 viewport, 60 Hz
display. Readings from the debug overlay at the initial view (zoom 14.5, pitch 60°):

| Metric | Value |
| --- | ---: |
| FPS / frame | 60 / 16.7 ms |
| Custom layer render (bucketing + Three draw submission) | 2.3 ms |
| of which LOD bucketing | 2.1 ms |
| Simulation tick (100k, 10 Hz, amortised per frame) | 0.35 ms |
| Visible / culled | 2,032 / 97,968 |
| Buckets LOD0 / 1 / 2 / 3 / box | 0 / 0 / 328 / 1,704 / 0 |
| Draw calls (vehicle layer) | 9 |
| Triangles (vehicle layer) | 3.2 M |

Conclusions:

- The basemap, extruded buildings and labels coexist with the vehicle layer at 60 FPS;
  depth is shared, so cars behind buildings are hidden.
- The layer's cost is dominated by bucketing (2.1 of 2.3 ms). The Three.js draw
  submission is negligible at 9 draw calls.
- Vehicles currently ignore roads (synthetic straight-line traffic), so many sit inside
  building footprints; phase C4 replaces this with road-following traffic.
- Two integration pitfalls worth recording: MapLibre 6's worker URL must be given
  explicitly under Vite (`setWorkerUrl`), and the dev server needs a
  `Cross-Origin-Resource-Policy` header alongside COOP/COEP for worker scripts.

## 5. C3: 3D Tiles (2026-09-17, overlay readings)

Tokyo, PLATEAU Chiyoda-ku 2023 LOD1 buildings (b3dm, textured) through
`3d-tiles-renderer`, error target 12 px, default LRU cache, basemap extrusions hidden,
100,000 vehicles, 1400 × 800 viewport, 60 Hz display.

| View | Layer render | of which bucketing | Tiles visible / active | Tile cache | Vehicle buckets (LOD0/1/2/3/box) | Draw calls | Triangles | FPS |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Overview (zoom 14.5, pitch 60°) | 4.2 ms | 3.9 ms | 14 / 15 | 40 MB | 0 / 0 / 0 / 0 / 49,702 | 15 | 0.9 M | 60 |
| Street (zoom 17.8, pitch 72°) | 3.0 ms | 2.8 ms | 7 / 15 | 40 MB | 0 / 0 / 292 / 4,090 / 14,047 | 17 | 5.3 M | 60 |

Conclusions:

- Tiles add two to three draw calls per visible tile and no measurable CPU cost beyond
  `tiles.update()`; the layer is still dominated by vehicle bucketing, which scales with
  the number of in-frustum vehicles (3.9 ms with 50k in view).
- Depth is shared: buildings occlude vehicles and vehicles occlude nothing they should
  not (`docs/previews/map-page-tiles-street.png`).
- Vertical alignment depends on the dataset's height reference; PLATEAU uses ellipsoid
  heights, so `groundHeight` = 36 m puts Marunouchi's ground on the vehicle plane.
- The bucketing pass at 50k in-frustum vehicles is the item to move off the main thread
  in C4, ahead of the road-following traffic that will also run there.

## 6. C4: road-following traffic in a Web Worker (2026-09-17, probe readings)

Tokyo, 100,000 vehicles on the OSM road graph (548 km of directed edges in a 4 km
square), PLATEAU tiles on, street view (zoom 17.5, pitch 70°), 1400 × 800, 120 Hz display.
Simulation (10 Hz) and LOD bucketing run in `traffic.worker.ts` over SharedArrayBuffers;
the main thread uploads packed snapshots and copies bucket id lists.

| Metric | Main thread (C3, local bucketing) | Worker mode (C4) |
| --- | ---: | ---: |
| Custom layer render | 3.0 ms | **0.23 ms** |
| of which LOD bucketing | 2.8 ms | 0 (worker: 1.3 ms) |
| Traffic glue per frame (snapshot/bucket polling) | 0.35 ms (sim on main) | 0.01 ms |
| Worker simulation tick (100k road vehicles) | — | 2.8 ms per 100 ms tick |
| Visible / in frustum | 18,429 | 16,712 |
| Buckets LOD0 / 1 / 2 / 3 / box | 0 / 0 / 292 / 4,090 / 14,047 | 0 / 0 / 378 / 3,259 / 13,075 |
| Draw calls / triangles | 17 / 5.3 M | 20 / 5.1 M |
| FPS | 60 | 120 |

Conclusions:

- **The main thread is now almost free of vehicle work**: 0.25 ms per frame for 100k
  vehicles including bucket list copies and texture uploads. Everything else on the main
  thread is MapLibre and tiles.
- Road-following simulation costs 2.8 ms per tick in the worker, i.e. ~28 % of one core
  at 10 Hz, leaving room for car-following or signals later.
- Bucketing in the worker runs at the camera message rate (one per frame) with a one to
  two frame lag in LOD assignment, which is invisible in practice.
- Density: 100k vehicles over 548 km is one car every 5.5 m, so queues overlap; there is
  no car-following model yet (documented limitation, see C5+ options in the plan).
- Fallback path: without cross-origin isolation the same RoadTraffic runs on the main
  thread with local bucketing; without a road file the synthetic straight-line traffic
  is used.

## 6a. C6: car following, LOD cap hysteresis, adaptive caps (2026-09-17)

Changes: IDM car following in `RoadTraffic` (per-edge counting sort, leader-first update,
no overtaking, cross-edge gaps), incumbent hysteresis at LOD cap boundaries and a
frame-time-driven cap scale in `VehicleLodManager` (`AdaptiveLod`), road networks
enlarged to an 8 km square (Tokyo 1,553 km) so 100k vehicles have ~15 m each.

| Metric | Before (C4) | After (C6) |
| --- | ---: | ---: |
| Worker simulation tick, 100k vehicles | 2.8 ms | 7.1–8.4 ms per 100 ms tick |
| Worker bucketing | 1.3 ms | 0.9–1.9 ms |
| Main-thread layer | 0.23 ms | 0.20 ms |
| Queues overlapping | yes (5.5 m spacing) | no: vehicles keep gap ≥ 2 m + 1 s headway |

Car following triples the simulation cost but stays at 8 % of one core at 10 Hz. The
adaptive cap scale never left 1.0 on this machine (frames stay under 13 ms); it exists
for weaker GPUs and is visible in the overlay as "caps ×". Incumbent hysteresis costs
nothing measurable.

## 7. C5: network feed

See `docs/network.md`: JSON 268 Mbit/s and 12 ms decode per frame at 10 Hz versus binary
FULL 91 Mbit/s / 0.4 ms, DELTA 46 Mbit/s, and viewport subscription 2–9 Mbit/s at 10 Hz;
1–2 Hz full state with dead reckoning ≈ 9 Mbit/s. The map stays at 60 FPS with the
network feed and worker bucketing (layer 0.25 ms).

## 8. One million vehicles, London (2026-09-19)

Apple M1 Pro, headless Chrome at 60 Hz, dev server, London, terrain on, OSM extrusions,
worker simulation. Reproduce with `node tooling/scale-probe.mjs london <counts>` and
`node tooling/flow-probe.mjs london <counts>`.

**Engine cost does not limit the fleet.** On the original 8 km network (1,828 km of
directed lanes) the unchanged engine already ran 1,000,000 vehicles at 60 FPS:

| Vehicles | FPS | Layer, main thread | Worker tick (of 100 ms) | LOD bucketing |
| --- | ---: | ---: | ---: | ---: |
| 100,000 | 60 | 0.1 ms | 8.5–8.7 ms | 1.1–1.7 ms |
| 250,000 | 60 | 0.1–0.2 ms | 18 ms | 2.6–3.8 ms |
| 500,000 | 60 | 0.1–0.6 ms | 22–24 ms | 4.9–7.3 ms |
| 1,000,000 | 60 | 0.1–0.2 ms, about 3 ms on snapshot frames | 46–52 ms | 8–19 ms |

A sweep over zoom levels at 1,000,000 found at most 135,000 vehicles on screen (1.6 M
triangles, all boxes); below zoom 13.6 every vehicle is under 1.5 px and culled. Street
level peaked at 12.5 M triangles. The one new cost is uploading the 16 MB state texture,
about 3 ms on the frames that receive a snapshot, ten times a second.

**Road space does.** At 6.5 m per stopped car (4.5 m car, 2 m gap) the 8 km networks
jam at about 104,000 (Hong Kong), 161,000 (New York), 281,000 (London) and 316,000
(Tokyo) vehicles. A million on London's 8 km network spawned 1.8 m apart and froze.

**London at 20 km.** Four 10 km Overpass tiles: 68,251 ways, 288,563 nodes, 534,485
directed edges, 10,098 km of directed lanes (jam at about 1.55 M), a 17 MB file (4 MB
gzip). Ready in 4.2–4.5 s on localhost at every count.

| Vehicles | FPS | Layer | Worker tick | Bucketing | Mean speed | Stopped | Crawling (< 3 m/s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 60 | 0.1–0.2 ms | 14–15 ms | 0.9–1.0 ms | 26.2 km/h | 0.2 % | 0.8 % |
| 250,000 | 60 | 0.1–0.4 ms | 25–26 ms | 2.1–2.5 ms | 24.2 km/h | 1.1 % | 2.6 % |
| 500,000 | 60 | 0.1 ms | 44–45 ms | 4.1–4.8 ms | 18.6 km/h | 7.4 % | 12.8 % |
| 1,000,000 | 60 | 0.1–0.2 ms | 75–79 ms | 8.1–9.4 ms | 7.2 km/h | 29.8 % | 41.8 % |

Flow speeds are after 30 s, once queues have formed. A million is congested stop-and-go
but moving; half a million flows freely.

The larger graph costs the worker about 6 ms per tick even at 100,000 (edge-indexed
passes over 534,485 edges), and scattering vehicles over three times more edges makes each
one slower to update. At 1,000,000 the tick uses 75–79 % of its 100 ms budget, which
leaves little headroom on a slower CPU: there the simulation would run slower than real
time rather than drop frames. Visiting only occupied edges, or splitting edges across two
workers, is the next optimisation.

**Adaptive caps at 120 Hz.** On the live site in a visible window on the 120 Hz display,
the adaptive cap scale fell from 1.00 to its 0.10 floor within 20 s at 1,000,000 vehicles
while the frame rate held at 122–126 FPS. Each 16 MB snapshot upload makes one frame
late and the next one early; the controller took the shortest interval, about 4 ms, as
the display period, so the healthy 8.3 ms mean read as 50 % too slow. Estimating the
period as the 20th percentile of the window's intervals fixed it: caps stay at 1.00 for a
minute at 121–127 FPS, and the existing stall tests still shrink them. Reproduce with
`HEADED=1 node tooling/adaptive-probe.mjs <url> 60`.

**Tokyo and New York at a million (2026-09-21).** Same method, same machine. Tokyo's
20 km square holds 12,007 km of directed lanes; New York needed 26 km, because half a
20 km square around Midtown is water and the 6,525 km left is bumper to bumper at a
million.

| City | Square | Directed lanes | Lane per car at 1 M | Mean speed | Stopped | Worker tick | FPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| London | 20 km | 10,098 km | 10.1 m | 7.2 km/h | 29.8 % | 75–79 ms | 60 |
| Tokyo | 20 km | 12,007 km | 12.0 m | 9.8 km/h | 19.8 % | 76–84 ms | 60 |
| New York | 26 km | 11,344 km | 11.3 m | 10.4 km/h | 13.5 % | 69–72 ms | 60 |

Main-thread layer time stayed at 0.1–0.2 ms in all three. Road files are 15–17 MB, about
4 MB compressed, and a city is ready 5–10 s after load on localhost.

The height field for 20 km uses DEM zoom 13 (64 tiles) and a 20 m grid (1001 × 1001),
chosen automatically so it costs no more than the 8 km field (zoom 15, 144 tiles, 10 m).

## 9. Benchmarks at 1,000,000 instances (2026-09-19)

The GPU scenarios at 100,000 and 1,000,000 instances in one session: Google Chrome
(ANGLE Metal, Apple M1 Pro), 1600 × 900 at pixel ratio 1, camera preset "city" unless
noted, 10 s recorded after 3 s warm-up. The vehicles drive synthetic traffic in a 3 km
square, and LOD selection runs on the main thread. Reproduce with
`npm run bench -- --base http://localhost:5175 --only cubes-static,cubes-moving-cpu,cubes-moving-gpu,cars-lod3,cars-lod --count 1000000`.

| Scenario | FPS 100k → 1M | CPU per frame 100k → 1M | GPU per frame 100k → 1M | Triangles 100k → 1M |
| --- | ---: | ---: | ---: | ---: |
| B1 static cubes | 60 → 59.6 | 0.05 → 0.06 ms | 2.6 → 18.2 ms | 1.2 M → 12 M |
| B2a moving cubes, CPU matrices | 60 → 4.3 | 6.9 → 117.6 ms | 2.0 → 15.8 ms | 1.2 M → 12 M |
| B2b moving cubes, GPU state texture | 60 → 44.5 | 0.4 → 5.6 ms | 2.7 → 18.5 ms | 1.2 M → 12 M |
| B3 all cars at LOD3 | 40 → 4.0 | 4.3 → 135.5 ms | 29.2 → 324.6 ms | 44 M → 443 M |
| B4 bucketed LODs, city view | 60 → 6.9 | 4.1 → 74.7 ms | 3.9 → 20.8 ms | 4.7 M → 13.0 M |
| B4 bucketed LODs, street view | 60 → 7.8 | 3.6 → 65.2 ms | 5.0–10.2 → 26.1 ms | 9.9 M → 30.7 M |

- **Instancing itself scales linearly.** A million static cubes still run at the display
  rate; the GPU cost grows with the triangles, 2.6 to 18.2 ms.
- **Per-vehicle CPU work does not.** CPU matrices spend 68 ms per frame on updates at a
  million. The GPU state texture keeps the CPU at 5.6 ms, of which 2.8 ms is packing the
  16 MB snapshot, and holds 44.5 FPS against the GPU limit.
- **Main-thread LOD selection fails at a million.** Bucketing costs 33–38 ms per frame,
  and with 530,000 cars in view of a 3 km square every cap fills: 27.5 M triangles of
  LOD meshes plus boxes, 26 ms of GPU time. The shipped app avoids both. It buckets in the
  traffic worker (8–19 ms there, 0.1–0.2 ms left on the main thread), and London's 20 km
  road network spreads the fleet so at most about 25,000 cars are in view (§8).
- **The full-cap triangle budget is 27.5 M, not about 10 M.** Earlier street-view
  measurements never filled every cap. `AdaptiveLod` is what keeps a scene this dense at
  an acceptable frame rate on this GPU.

## 10. Open measurements

- B4 follow-ups: cap hysteresis for popping; bucketing at half rate or in the worker;
  `BatchedMesh` as an alternative container (its per-instance matrices conflict with the
  state-texture design, so it is a low priority).
- A4: `/lod-test` decode time of `.opt.glb` (meshopt) versus raw.
- Reduced configurations (integrated GPU, Windows laptop) once the pipeline is stable,
  now including 1,000,000 vehicles in London, where the worker tick is the tight budget.
