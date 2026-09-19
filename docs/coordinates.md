# Coordinate Conventions

This document is the single reference for axes, units, origins and the transforms between
Blender, glTF, Three.js, MapLibre and 3D Tiles. Every vehicle asset and every renderer
module follows it. All sections describe implemented code.

## 1. Summary table

| Space | Units | Up | Vehicle forward | Handedness | Who owns it |
| --- | --- | --- | --- | --- | --- |
| Blender (source and LOD pipeline) | metres | +Z | −Y | right | `scripts/blender/*` |
| glTF / GLB (exported assets) | metres | +Y | +Z | right | glTF 2.0 spec |
| Three.js local scene | metres from the city origin | +Y | +Z (model) | right | `src/rendering/*` |
| MapLibre Mercator | Mercator units [0..1] | (screen) | — | — | `src/map/coordinateSystem.ts` |
| 3D Tiles | ECEF metres (EPSG:4978) | — | — | right | `3d-tiles-renderer` |

Blender → glTF axis mapping (done by the Blender glTF exporter with default settings):
`(x, y, z)_blender → (x, z, −y)_gltf`. Therefore Blender −Y (car nose) becomes glTF +Z,
which is the glTF convention for "front", and Blender +Z (roof) becomes glTF +Y.

## 2. Vehicle asset convention

Applies to every LOD of every vehicle type. The pipeline (`scripts/generate-car-lods.py`)
enforces it; `scripts/validate-assets.ts` checks it.

- **Units:** metres. A Porsche 911 (991) is 4.49 m long, 1.85 m wide, 1.30 m tall.
- **Origin:** on the ground plane (bottom of the tyres), laterally centred, longitudinally
  at the midpoint between the front and rear axles. The renderer rotates the car about
  this point for heading, so the pivot sits between the wheels rather than at the bumper.
- **Forward:** Blender −Y, glTF/Three.js +Z.
- **Up:** Blender +Z, glTF/Three.js +Y.
- **Transforms applied:** every exported mesh has identity location/rotation/scale; the
  geometry itself is in the final position.
- **Materials:** flat-colour Principled BSDF. The body paint material is named `paint`
  so the runtime can override its colour per instance.

### Porsche source normalisation (measured in `docs/asset-analysis.md`)

| Quantity | Source value (modifiers baked) | Normalised |
| --- | ---: | ---: |
| Length (Y extent, body incl. rear diffuser) | 7.571 | 4.49 m |
| Width (X extent, incl. mirrors) | 3.415 | 2.03 m |
| Height (Z extent) | 2.171 | 1.29 m |
| Ground (min Z, tyre bottom) | −1.078 | 0.000 |
| Front axle centre Y (nose is −Y) | −2.094 | −1.242 m |
| Rear axle centre Y | +2.127 | +1.261 m |
| Wheelbase midpoint Y | +0.017 | 0.000 |
| Tyre radius | 0.567 | 0.336 m |

Uniform scale factor **0.593** (= 4.49 / 7.571), anchored on length because vehicle
spacing in traffic depends on it. The resulting width with mirrors (2.03 m) and height
(1.29 m) are within 3 % of the real car (1.98 m, 1.30 m). The extents must be measured
on *baked* geometry: Subdivision Surface cages are larger than their smoothed result,
and an earlier cage-based measurement (8.33 units) gave a scale 9 % too small.
Normalisation is: translate by (0, −0.017, +1.078) in source units, then scale by
0.593 about the world origin, so the wheelbase midpoint sits at X = Y = 0 and the tyres
touch Z = 0, then apply transforms. The car's existing orientation (nose −Y, roof +Z)
already matches the convention.

## 3. Heading in Three.js

The Three.js scene is a local east-north-up frame with a Y-up right-handed basis:

```
+X = east, +Y = up, −Z = north (so +Z = south)
```

A compass heading θ (radians, clockwise from north, as in GPS and SUMO output) points
along the world vector `(sin θ, 0, −cos θ)`. A glTF model's forward is local +Z, which a
rotation of φ about +Y sends to `(sin φ, 0, cos φ)`. Equating the two:

```
rotation.y = π − θ
```

The vehicle shader applies this as a 2-D rotation of the model's XZ coordinates. Altitude
comes from the vehicle's `altitude` field (metres above the origin's ellipsoid height; 0 for
the prototype, terrain sampling later).

## 4. MapLibre ↔ Three.js (implemented in phase C2)

Implemented in `src/map/coordinateSystem.ts` (`LocalFrame`) and `src/map/VehicleLayer.ts`.

- A city origin `(lon0, lat0)` from `src/config/cityConfig.ts` defines the local frame.
  `LocalFrame` computes the origin's Mercator position in float64 and the scale
  `s = 1 / (40075016.686 · cos lat0)` Mercator units per metre (the same formula as
  MapLibre's `meterInMercatorCoordinateUnits()`).
- Vehicle positions are float32 metres `(x east, y up, z south)` from that origin. The
  local → Mercator model matrix is `merc = origin + (s·x, s·z, s·y)`; note the swap of
  y and z because Mercator y points south and its z is altitude.
- Each frame the custom layer receives MapLibre's `defaultProjectionData.mainMatrix`
  (Mercator [0..1] → clip; **not** `modelViewProjectionMatrix`, which expects world-pixel
  units) and multiplies it by the model matrix in float64 (`multiplyMat4`). The result
  becomes the Three.js camera's projection matrix with an identity view matrix, so only
  metre-scale float32 values reach the GPU. Verified: the origin projects to NDC (0, 0)
  at the map centre, +x east moves right, +y up moves up.
- The eye position for LOD selection is recovered from the combined matrix as
  `inverse(VP) · (0, 0, 1, 0)` (`src/map/projectionMath.ts`, unit-tested against a
  Three.js camera); the frustum planes come from the same matrix.
- Picking inverts the same matrix to build a ray in local metres and tests all vehicles
  against it (`VehicleLayer.pick`).
- Mercator scale varies with latitude by `1/cos(lat)`; across a 30 km city this is under
  0.5 % and is absorbed by using the origin's scale everywhere.

## 5. 3D Tiles ↔ Three.js (implemented in phase C3)

Implemented in `src/map/CityTiles.ts` with `3d-tiles-renderer` 0.5.

- Tilesets are ECEF (EPSG:4978). `ReorientationPlugin({ lat, lon, height, up: "+y",
  recenter: true })` with the city origin in **radians** re-bases the tileset so that
  point sits at the Three.js origin with +Y up. Its ENU convention is **X west, Z north**,
  so the tiles group is parented under a half-turn about Y to reach our X east, Z south.
- `height` is the ellipsoid height of the ground at the origin (`groundHeight` in
  `src/config/cityConfig.ts`; Tokyo Marunouchi ≈ 36 m, i.e. ~3 m orthometric plus the
  ~36 m geoid undulation minus the PLATEAU base heights). It is a dataset parameter,
  tunable at runtime with `?ground=` on the map page.
- The tiles group shares the vehicle layer's scene and camera, so depth testing between
  tiles, vehicles and the MapLibre basemap is correct without per-object conversion.
- `3d-tiles-renderer` needs a camera with a meaningful position and fov for its
  screen-space-error metric, so the layer's camera is a `PerspectiveCamera` whose
  projection is `VP · T(eye)` and whose view is `T(−eye)`; the product is still `VP`.
- Basemap fill-extrusion layers are hidden while a tileset is shown so buildings are
  not drawn twice.
- Cesium ion assets (`CesiumIonAuthPlugin`, e.g. Cesium OSM Buildings 96188 for London
  and New York) are clamped to Cesium World Terrain, so `groundHeight` is the terrain's
  ellipsoid height at the origin: EGM96 geoid undulation plus orthometric elevation
  (London ≈ 45.5 + 7 ≈ 52 m, Midtown Manhattan ≈ −32.5 + 15 ≈ −18 m). Verified
  2026-09-18 by sampling loaded tile vertices within 400 m of each origin: the 5th
  percentile height is −0.1 m (New York), −1.6 m (London) and 2.6 m (Tokyo, PLATEAU),
  i.e. building bases meet the road plane. Tune with `?ground=` for other datasets.

## 6. Terrain (height map, `?terrain=1`)

Without terrain the local plane `y = 0` is the ground at the city origin: roads, vehicles
and the 3D Tiles ground (shifted by `groundHeight`) all sit on it. With terrain MapLibre
drapes the basemap over a DEM whose datum is sea level, so the local frame's `y = 0` plane
becomes **sea level** and everything must carry an absolute elevation:

- **DEM.** AWS Terrain Tiles (Terrarium PNG, `r·256 + g + b/256 − 32768` metres) at zoom 14,
  served to MapLibre through the `terrarium0://` protocol (`src/map/terrainProtocol.ts`),
  which clamps every pixel below 0 m to 0 m. The raw tiles carry bathymetry and kilometre-deep
  coastal artefacts (Victoria Harbour showed −8,583 m) that would open trenches in the sea
  and drop tunnel vehicles into them.
- **Height field.** `src/data/loadHeightField.ts` samples the same clamped tiles (zoom 15,
  the finest level, matching MapLibre's terrain mesh) onto a 10 m grid over the traffic
  area once per city load (801 × 801 at 10 m for 8 km, 1001 × 1001 at 20 m for London's
  20 km, from the finest DEM zoom that needs at most about 160 tiles);
  `src/geo/HeightField.ts` samples it bilinearly and is plain data, so the worker gets a copy.
- **Roads.** `RoadNetwork.applyElevation` stores an absolute `nodeY` per node and
  `RoadTraffic.writePositions` interpolates it linearly along the edge, so vehicles follow the
  slope instead of the DEM's per-pixel steps. Network feeds carry no elevation; `MapScene`
  samples the height field for every decoded vehicle.
- **3D Tiles.** Tile heights are absolute (ellipsoid); their `groundHeight` shift is reduced
  by the DEM elevation at the origin so the tile ground at the origin lands on the DEM there.
  Away from the origin the geoid difference is constant and the DEM and tile heights agree to
  DEM accuracy (SRTM/NED, ~10 m grid).

- **Vehicle attitude.** The same grid is uploaded once as an R32F texture and the vehicle
  vertex shader (`InstancedVehicleMaterial`, `uTerrain`) snaps each vehicle's height to the
  bilinear ground and builds an orthonormal basis whose up axis is the terrain normal
  (central differences over ±6 m) with the forward axis as close to the heading as the
  slope allows; on flat ground it equals the plain heading rotation. The grade is clamped
  to 0.25 (1:4) because the DEM has step artefacts at flyovers and reclaimed shorelines (a
  330 % "grade" under Connaught Road West). No per-vehicle data changes, so the worker
  and the network protocol are untouched. Preview: `docs/previews/map-page-hongkong-tilt.png`.

Hong Kong (Central → Mid-Levels → the Peak, 0–523 m on the road network) is the showcase;
Tokyo, London and New York are flat enough that the option changes little. Measured with
100,000 vehicles and OSM extrusions or Cesium OSM Buildings: 60 FPS, layer 0.1–0.3 ms, the
same as without terrain; the height field load adds ~1–2 s (64 tiles + 641k samples).

## 7. Lanes on two-way roads

`scripts/build-roads.ts` emits a two-way OSM way as two directed edges over the same node
geometry, so without correction both directions drive on the centreline. `RoadNetwork`
flags an edge as two-way when its reverse exists (`edgeTwoWay`), and
`RoadTraffic.writePositions` shifts those vehicles `laneOffset` metres (default 1.75, half
a 3.5 m lane) to the side given by `CityConfig.driveOnLeft`: left for Tokyo, London and
Hong Kong, right for New York. In the x-east / z-south frame the left of a unit direction
`(dx, dz)` is `(dz, −dx)`. One-way edges stay centred. Car following still measures gaps
along the edge, so the offset is purely visual and costs nothing per tick.
