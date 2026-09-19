/**
 * Development traffic server (phase C5, spec §32–33): runs the road-following
 * simulation for a city and streams vehicle state to WebSocket clients in the format,
 * mode and rate each client asks for, so bandwidth and client cost can be measured.
 *
 *   npx tsx server/traffic-server.ts [--port 8787] [--city tokyo] [--count 100000] [--tick 0.1]
 *
 * Client connects to ws://host:port/?format=binary|json&mode=full|delta|viewport&rate=10
 * [&compress=1]. In viewport mode the client posts JSON {"type":"viewport", "minX",
 * "maxX", "minZ", "maxZ"} in local metres and receives only vehicles inside it, plus a
 * FULL keyframe every `keyframe` seconds (default 2) so off-screen state never goes
 * stale for long. The server logs bytes per second per client.
 *
 * Imports only the pure layers of src/ (simulation, data, geo, types, net).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { cityById } from "@/config/cityConfig.ts";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { LocalFrame } from "@/geo/coordinateSystem.ts";
import { DeltaReference, encodeDelta, encodeFull, encodeJson, encodeViewport } from "@/net/protocol.ts";
import { RoadNetwork } from "@/simulation/RoadNetwork.ts";
import { RoadTraffic } from "@/simulation/RoadTraffic.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const port = Number(arg("port", "8787"));
const city = arg("city", "tokyo");
const count = Number(arg("count", "100000"));
const tick = Number(arg("tick", "0.1"));

const network = JSON.parse(
  readFileSync(resolve(`assets/generated/roads/${city}.json`), "utf8"),
) as RoadNetworkFile;
const frame = new LocalFrame(network.origin);
const roads = new RoadNetwork(network, (lon, lat) => {
  const p = frame.lngLatToLocal({ longitude: lon, latitude: lat });
  return { x: p.x, z: p.z };
});
const buffer = new VehicleBuffer(count);
const traffic = new RoadTraffic(buffer, roads, {
  count,
  tickInterval: tick,
  seed: 11,
  driveOnLeft: cityById(city).driveOnLeft,
});
traffic.start();
let simTimeMs = 0;
let seq = 0;
setInterval(() => {
  traffic.step(tick);
  simTimeMs += Math.round(tick * 1000);
  seq++;
}, tick * 1000);

interface Client {
  ws: WebSocket;
  format: "binary" | "json";
  mode: "full" | "delta" | "viewport";
  rate: number;
  keyframe: number;
  ref: DeltaReference | null;
  viewport: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  lastKeyframeMs: number;
  bytes: number;
  frames: number;
  timer: ReturnType<typeof setInterval>;
}

const clients = new Set<Client>();
const idScratch = new Uint32Array(count);

function sendFrame(c: Client): void {
  if (c.ws.readyState !== c.ws.OPEN || c.ws.bufferedAmount > 8 * 1024 * 1024) return; // drop when the socket is backed up
  const now = simTimeMs;
  let payload: ArrayBuffer | string;
  if (c.format === "json") {
    payload = encodeJson(buffer, count, seq, now);
  } else if (c.mode === "delta") {
    if (!c.ref) {
      c.ref = new DeltaReference(count);
      payload = encodeFull(buffer, count, seq, now);
      c.ref.setFromBuffer(buffer);
    } else {
      const delta = encodeDelta(buffer, c.ref, count, seq, now);
      if (delta) payload = delta;
      else {
        payload = encodeFull(buffer, count, seq, now);
        c.ref.setFromBuffer(buffer);
      }
    }
  } else if (c.mode === "viewport" && c.viewport) {
    const needKeyframe = now - c.lastKeyframeMs >= c.keyframe * 1000;
    if (needKeyframe) {
      payload = encodeFull(buffer, count, seq, now);
      c.lastKeyframeMs = now;
    } else {
      const v = c.viewport;
      let n = 0;
      const { x, z } = buffer;
      for (let i = 0; i < count; i++) {
        const px = x[i] as number;
        const pz = z[i] as number;
        if (px >= v.minX && px <= v.maxX && pz >= v.minZ && pz <= v.maxZ) idScratch[n++] = i;
      }
      payload = encodeViewport(buffer, idScratch, n, seq, now);
    }
  } else {
    payload = encodeFull(buffer, count, seq, now);
  }
  c.ws.send(payload, { binary: typeof payload !== "string" });
  c.bytes += typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
  c.frames++;
}

const wss = new WebSocketServer({
  port,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 1 },
  },
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const format = url.searchParams.get("format") === "json" ? "json" : "binary";
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam === "delta" || modeParam === "viewport" ? modeParam : "full";
  const rate = Math.min(60, Math.max(0.2, Number(url.searchParams.get("rate") ?? "10")));
  const keyframe = Number(url.searchParams.get("keyframe") ?? "2");
  const client: Client = {
    ws,
    format,
    mode,
    rate,
    keyframe,
    ref: null,
    viewport: null,
    lastKeyframeMs: -1e9,
    bytes: 0,
    frames: 0,
    timer: setInterval(() => {
      sendFrame(client);
    }, 1000 / rate),
  };
  clients.add(client);
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");
      const msg = JSON.parse(text) as {
        type: string;
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
      };
      if (msg.type === "viewport")
        client.viewport = { minX: msg.minX, maxX: msg.maxX, minZ: msg.minZ, maxZ: msg.maxZ };
    } catch {
      /* ignore */
    }
  });
  ws.on("close", () => {
    clearInterval(client.timer);
    clients.delete(client);
  });
  console.info(
    `client: ${format} ${mode} @ ${rate} Hz (compression ${url.searchParams.get("compress") === "1" ? "on" : "negotiated"})`,
  );
});

setInterval(() => {
  for (const c of clients) {
    if (c.frames === 0) continue;
    console.info(
      `${c.format} ${c.mode} @${c.rate}Hz: ${(c.bytes / 1024 / 5).toFixed(0)} KB/s, ${(c.frames / 5).toFixed(1)} frames/s, ` +
        `${(c.bytes / c.frames / 1024).toFixed(0)} KB/frame, buffered ${(c.ws.bufferedAmount / 1024).toFixed(0)} KB`,
    );
    c.bytes = 0;
    c.frames = 0;
  }
}, 5000);

console.info(
  `traffic server: ws://localhost:${port}  city=${city} vehicles=${count} tick=${tick}s roads=${(roads.totalLength / 1000).toFixed(0)} km`,
);
