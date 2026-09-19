# Network Design and Measurements (phase C5)

How 100,000 vehicle updates reach the browser (spec §32–33, plan §H). Everything below
is measured with the development traffic server (`server/traffic-server.ts`, road
simulation at 10 Hz) streaming to the `/map` page over a WebSocket on localhost, Tokyo
road network, 100,000 vehicles, Apple M1 Pro, Chrome 152. Reproduce with
`npm run server` then `/map?source=ws&format=…&mode=…&rate=…`.

## 1. Wire formats (`src/net/protocol.ts`)

| Frame | Bytes per vehicle | Content |
| --- | ---: | --- |
| binary FULL | 12 | i32 x cm, i32 z cm, u16 heading (1/65536 turn), u8 speed (0.5 m/s), u8 type/colour; ordered by id |
| binary DELTA | 6 (+16 per correction) | i16 dx cm, i16 dz cm, i8 dheading (1/256 turn), u8 speed, relative to the previous frame; vehicles that jumped more than ±327 m (respawns) are appended as full corrections |
| binary VIEWPORT | 16 | u32 id + FULL record, only vehicles inside the client's subscription box; a FULL keyframe every 2 s |
| JSON | ~35 | `[id, x, z, heading, speed, typeColour]` arrays with the same rounding |

All frames carry a 16-byte header (magic, kind, correction count, sequence, simulation
time in ms, count). Decoding writes straight into the Structure-of-Arrays
`VehicleBuffer`, which in worker mode is the shared memory the LOD worker buckets from.

## 2. Codec cost in isolation (`npm run net:bench`, Node 24, best of 5)

| Format | Bytes/frame | Deflated (level 1) | Encode | Decode | Mbit/s at 1 Hz / 10 Hz |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON full | 3,463 KB | 1,411 KB | 27.4 ms | 16.3 ms | 28.4 / 283.7 |
| binary FULL (12 B) | 1,172 KB | 826 KB | 2.6 ms | 0.9 ms | 9.6 / 96.0 |
| binary DELTA (6 B), 0.1 s step | 586 KB | 320 KB | 4.3 ms | 0.5 ms | 4.8 / 48.0 |
| binary DELTA (6 B), 1 s step | 588 KB | 443 KB | 4.4 ms | 0.5 ms | 4.8 / 48.2 |
| binary VIEWPORT (16 B), 15 % of vehicles | 234 KB | 164 KB | 0.4 ms | 0.4 ms | 1.9 / 19.2 |

Notes: JSON costs 3× the bytes and 18× the decode time of binary FULL. DELTA halves the
bytes and compresses well at 10 Hz (small deltas) but less at 1 Hz. Deflate on binary
FULL saves only 30 %; the WebSocket `permessage-deflate` extension is therefore worth it
for DELTA, marginal for FULL, and irrelevant for VIEWPORT.

## 3. End to end in the browser (`/map`, street view, worker bucketing)

| Configuration | Received | Bandwidth | Client decode per frame | Map FPS | Layer (main thread) |
| --- | ---: | ---: | ---: | ---: | ---: |
| binary FULL @ 10 Hz | 9.9 frames/s, 1,172 KB/frame | **90.7 Mbit/s** | 0.42 ms | 60 | 0.26 ms |
| binary DELTA @ 10 Hz | 10.1 frames/s, 586 KB/frame | **46.4 Mbit/s** | 0.47 ms | 60 | 0.66 ms |
| JSON @ 10 Hz | 9.9 frames/s, 3,453 KB/frame | **267.7 Mbit/s** | 12.0 ms | 60 | 0.28 ms |
| binary VIEWPORT @ 10 Hz, 1,500 m box | 9.9 frames/s, 883 KB/frame | 70.5 Mbit/s | 0.46 ms | 60 | 0.25 ms |
| binary VIEWPORT @ 10 Hz, 500 m box + 2 s keyframes | 9.9 frames/s, 114 KB/frame avg | **8.8 Mbit/s** | 0.08 ms | 60 | 0.25 ms |
| binary VIEWPORT @ 10 Hz, 250 m box + 2 s keyframes | 9.9 frames/s, 27 KB/frame avg | **2.1 Mbit/s** | 0.03 ms | 60 | 0.25 ms |
| binary FULL @ 1 Hz + dead reckoning | 1.0 frames/s, 1,172 KB/frame | **9.1 Mbit/s** | 2.2 ms (incl. extrapolating 100k) | 50 | 0.32 ms |
| binary DELTA @ 2 Hz + dead reckoning | 2.0 frames/s, 587 KB/frame | **9.2 Mbit/s** | 2.1 ms | 50 | 0.26 ms |

The 10 Hz binary feeds stayed at 60 FPS with no dropped frames on localhost; the server
never had a backed-up socket. The 1–2 Hz rows show a lower frame rate in the probe
window, which coincides with the render-clock resync on each sparse snapshot; smoothing
the resync is a follow-up.

### 3a. Viewport box size

A 1,500 m half-size box around the camera covers most of the 4 km test area, so viewport
mode sent 55k vehicles per frame and gained little. With a 500 m box (`?vpr=500`) the
per-frame payload drops to ~50 KB plus a 1.2 MB keyframe every 2 s (114 KB average), and
with 250 m to 27 KB average: **10 Hz updates for everything near the camera at 2–9
Mbit/s**, while the far field refreshes at 0.5 Hz through the keyframes. The box should
be derived from the frustum and the LOD distance at which vehicles turn into boxes
rather than a fixed radius.

**Frustum-driven box (implemented after the measurements above; the default when
`vpr` is not given):** `VehicleLayer.viewportGroundBox` intersects the four frustum
corner rays with the ground, limited to the distance at which a vehicle falls below half
the LOD3 threshold. Measured at 10 Hz with 2 s keyframes on the 8 km road network:

| View | Box | Bandwidth | Client decode |
| --- | ---: | ---: | ---: |
| Street (zoom 17.5, pitch 70°) | 346 × 402 m | **1.1 Mbit/s** | 0.02 ms |
| Overview (zoom 14.5, pitch 60°) | 2,552 × 2,475 m | **11.6 Mbit/s** | 0.09 ms |

The render-clock slew (instead of snapping) removed the frame-rate dip seen at 1–2 Hz:
the 2 Hz DELTA + dead-reckoning feed now runs at the display rate (118 FPS on the 120 Hz
display) at 9.1 Mbit/s.

## 4. Recommendation

1. **Never JSON for bulk state.** 268 Mbit/s and 12 ms of main-thread parsing per frame
   at 10 Hz; binary FULL is 3× smaller and 25× cheaper to decode.
2. **Practical full-state rate is 1–2 Hz with dead reckoning** (≈ 9 Mbit/s for 100k
   vehicles), which fits a good home connection but not mobile. Vehicles move smoothly
   between snapshots because the renderer interpolates and the client extrapolates one
   interval ahead from heading and speed.
3. **Use DELTA at any rate above 1 Hz** (half the bytes, corrections handle respawns) and
   enable `permessage-deflate` for it (another ~45 % at 10 Hz).
4. **Viewport subscription is the lever for 10 Hz near the camera**: measured 8.8 Mbit/s
   with a 500 m box and 2.1 Mbit/s with 250 m, keyframes included, at 10 Hz. Stream the
   vehicles within the frustum's LOD range at 10 Hz and the rest as 0.5–1 Hz keyframes
   (DELTA-encoded to halve them). That is the configuration to build the production
   feed around; the fixed-radius box in the prototype should become frustum-driven.
5. **Server-side simulation cost is not the limit**: the Node server steps 100k vehicles
   in ~3 ms and encodes a FULL frame in 2.6 ms; one core handles several clients at 10 Hz.
6. WebTransport (datagrams, no head-of-line blocking) is the next transport to evaluate
   once the browser story is settled; the codec is transport-agnostic.

## 5. Implementation notes

- `server/traffic-server.ts` imports only the pure layers of `src/` (`simulation`,
  `data`, `geo`, `net`, `types`); dependency-cruiser enforces it. Run with `tsx`, which
  resolves the `@/` alias.
- `WebSocketTrafficSource` implements `TrafficDataSource`; swapping the synthetic worker
  simulation for the network feed touches only `MapScene`.
- In network mode the worker runs in bucketing-only mode: the main thread decodes into
  the shared buffer and pushes snapshots; the worker keeps producing LOD lists.
- Attributes (type, colour) are re-uploaded on every FULL/JSON frame; DELTA frames
  carry no attributes.
