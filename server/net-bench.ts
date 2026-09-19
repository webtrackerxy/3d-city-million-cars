/**
 * Codec benchmark (phase C5): sizes and encode/decode cost of the wire formats for
 * N vehicles of real road traffic, including deflate-compressed sizes. Prints a
 * Markdown table for docs/network.md.
 *
 *   npx tsx server/net-bench.ts [--count 100000] [--city tokyo]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { LocalFrame } from "@/geo/coordinateSystem.ts";
import {
  DeltaReference,
  decodeFrame,
  decodeJson,
  encodeDelta,
  encodeFull,
  encodeJson,
  encodeViewport,
} from "@/net/protocol.ts";
import { RoadNetwork } from "@/simulation/RoadNetwork.ts";
import { RoadTraffic } from "@/simulation/RoadTraffic.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const count = Number(arg("count", "100000"));
const city = arg("city", "tokyo");
const network = JSON.parse(
  readFileSync(resolve(`assets/generated/roads/${city}.json`), "utf8"),
) as RoadNetworkFile;
const frame = new LocalFrame(network.origin);
const roads = new RoadNetwork(network, (lon, lat) => {
  const p = frame.lngLatToLocal({ longitude: lon, latitude: lat });
  return { x: p.x, z: p.z };
});
const buffer = new VehicleBuffer(count);
const traffic = new RoadTraffic(buffer, roads, { count, seed: 11 });
traffic.start();
for (let i = 0; i < 20; i++) traffic.step(0.1); // warm the simulation so speeds are realistic

function time<T>(fn: () => T, runs = 5): { result: T; ms: number } {
  let best = Number.POSITIVE_INFINITY;
  let result = fn();
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    result = fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { result, ms: best };
}

const rows: string[] = [];
const dst = new VehicleBuffer(count);
const kb = (b: number) => (b / 1024).toFixed(0);
const mbit = (b: number, hz: number) => ((b * 8 * hz) / 1e6).toFixed(1);

// JSON full
{
  const enc = time(() => encodeJson(buffer, count, 1, 0));
  const bytes = Buffer.byteLength(enc.result);
  const dec = time(() => decodeJson(enc.result, dst));
  const z = deflateSync(Buffer.from(enc.result), { level: 1 }).length;
  rows.push(
    `| JSON full | ${kb(bytes)} KB | ${kb(z)} KB | ${enc.ms.toFixed(1)} ms | ${dec.ms.toFixed(1)} ms | ${mbit(bytes, 1)} / ${mbit(bytes, 10)} |`,
  );
}
// binary full
{
  const enc = time(() => encodeFull(buffer, count, 1, 0));
  const bytes = enc.result.byteLength;
  const dec = time(() => decodeFrame(enc.result, dst, null));
  const z = deflateSync(Buffer.from(enc.result), { level: 1 }).length;
  rows.push(
    `| binary FULL (12 B) | ${kb(bytes)} KB | ${kb(z)} KB | ${enc.ms.toFixed(1)} ms | ${dec.ms.toFixed(1)} ms | ${mbit(bytes, 1)} / ${mbit(bytes, 10)} |`,
  );
}
// binary delta at 10 Hz and 1 Hz (delta magnitude depends on the interval)
for (const interval of [0.1, 1.0]) {
  const senderRef = new DeltaReference(count);
  const receiverRef = new DeltaReference(count);
  decodeFrame(encodeFull(buffer, count, 1, 0), dst, receiverRef);
  senderRef.setFromBuffer(buffer);
  for (let i = 0; i < Math.round(interval / 0.1); i++) traffic.step(0.1);
  const enc = time(() => {
    const ref = new DeltaReference(count);
    ref.xCm.set(senderRef.xCm);
    ref.zCm.set(senderRef.zCm);
    ref.heading.set(senderRef.heading);
    return encodeDelta(buffer, ref, count, 2, 100) as ArrayBuffer;
  });
  const bytes = enc.result.byteLength;
  const dec = time(() => {
    const ref = new DeltaReference(count);
    ref.xCm.set(receiverRef.xCm);
    ref.zCm.set(receiverRef.zCm);
    ref.heading.set(receiverRef.heading);
    return decodeFrame(enc.result, dst, ref);
  });
  const z = deflateSync(Buffer.from(enc.result), { level: 1 }).length;
  rows.push(
    `| binary DELTA (6 B), ${interval} s step | ${kb(bytes)} KB | ${kb(z)} KB | ${enc.ms.toFixed(1)} ms | ${dec.ms.toFixed(1)} ms | ${mbit(bytes, 1)} / ${mbit(bytes, 10)} |`,
  );
}
// viewport subset: 15 % of vehicles (typical street view in-frustum share)
{
  const n = Math.round(count * 0.15);
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) ids[i] = i;
  const enc = time(() => encodeViewport(buffer, ids, n, 1, 0));
  const bytes = enc.result.byteLength;
  const dec = time(() => decodeFrame(enc.result, dst, null));
  const z = deflateSync(Buffer.from(enc.result), { level: 1 }).length;
  rows.push(
    `| binary VIEWPORT (16 B), 15 % of vehicles | ${kb(bytes)} KB | ${kb(z)} KB | ${enc.ms.toFixed(1)} ms | ${dec.ms.toFixed(1)} ms | ${mbit(bytes, 1)} / ${mbit(bytes, 10)} |`,
  );
}

console.info(
  `Codec benchmark, ${count.toLocaleString()} vehicles on ${city} roads (Node ${process.version}, best of 5)\n`,
);
console.info("| Format | Bytes/frame | Deflated (level 1) | Encode | Decode | Mbit/s at 1 Hz / 10 Hz |");
console.info("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) console.info(r);
