/**
 * TrafficDataSource fed by the development traffic server over a WebSocket (phase C5).
 * Decodes frames straight into the VehicleBuffer (which may be shared memory the LOD
 * worker reads) and reports each decoded frame's simulation time so the renderer can
 * interpolate between the last two. Optional dead reckoning extrapolates one interval
 * ahead from heading and speed so low update rates still look continuous.
 */

import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import type { TrafficDataSource } from "@/types/vehicle.ts";
import { DeltaReference, FrameKind, decodeFrame, decodeJson } from "./protocol.ts";

export interface WebSocketTrafficOptions {
  url: string;
  format: "binary" | "json";
  mode: "full" | "delta" | "viewport";
  /** frames per second requested from the server */
  rate: number;
  /** extrapolate one interval ahead from heading and speed (dead reckoning) */
  predict?: boolean;
  /** half-size of the viewport subscription box around the camera, metres (viewport mode) */
  viewportRadius?: number;
  onFrame?: (timeSeconds: number, kind: FrameKind | "json") => void;
  onError?: (message: string) => void;
}

export interface NetStats {
  connected: boolean;
  framesPerSecond: number;
  kbPerSecond: number;
  bytesPerFrame: number;
  decodeMs: number;
  lastKind: string;
  frames: number;
}

export class WebSocketTrafficSource implements TrafficDataSource {
  readonly id = "websocket";
  readonly vehicleCount: number;
  readonly tickInterval: number;
  readonly stats: NetStats = {
    connected: false,
    framesPerSecond: 0,
    kbPerSecond: 0,
    bytesPerFrame: 0,
    decodeMs: 0,
    lastKind: "-",
    frames: 0,
  };
  private ws: WebSocket | null = null;
  private ref: DeltaReference | null = null;
  private windowStart = performance.now();
  private windowFrames = 0;
  private windowBytes = 0;
  private decodeAcc = 0;

  constructor(
    private readonly buffer: VehicleBuffer,
    private readonly opts: WebSocketTrafficOptions,
  ) {
    this.vehicleCount = buffer.capacity;
    this.tickInterval = 1 / opts.rate;
    const url = new URL(opts.url);
    url.searchParams.set("format", opts.format);
    url.searchParams.set("mode", opts.mode);
    url.searchParams.set("rate", String(opts.rate));
    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.stats.connected = true;
    };
    ws.onclose = () => {
      this.stats.connected = false;
    };
    ws.onerror = () => {
      opts.onError?.(`WebSocket error (${opts.url})`);
    };
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      this.receive(e.data);
    };
    this.ws = ws;
  }

  private receive(data: ArrayBuffer | string): void {
    const t0 = performance.now();
    let timeMs: number;
    let kind: FrameKind | "json";
    let bytes: number;
    if (typeof data === "string") {
      const h = decodeJson(data, this.buffer);
      timeMs = h.timeMs;
      kind = "json";
      bytes = data.length;
    } else {
      if (this.opts.mode === "delta" && !this.ref) this.ref = new DeltaReference(this.buffer.capacity);
      const h = decodeFrame(data, this.buffer, this.ref);
      timeMs = h.timeMs;
      kind = h.kind;
      bytes = data.byteLength;
    }
    this.buffer.count = this.buffer.capacity;
    if (this.opts.predict) this.extrapolate();
    const decodeMs = performance.now() - t0;
    this.windowFrames++;
    this.windowBytes += bytes;
    this.decodeAcc += decodeMs;
    const s = this.stats;
    s.frames++;
    s.lastKind = kind === "json" ? "json" : (FrameKind[kind] ?? String(kind));
    s.bytesPerFrame = bytes;
    const elapsed = (performance.now() - this.windowStart) / 1000;
    if (elapsed >= 1) {
      s.framesPerSecond = this.windowFrames / elapsed;
      s.kbPerSecond = this.windowBytes / 1024 / elapsed;
      s.decodeMs = this.decodeAcc / this.windowFrames;
      this.windowStart = performance.now();
      this.windowFrames = 0;
      this.windowBytes = 0;
      this.decodeAcc = 0;
    }
    this.opts.onFrame?.(timeMs / 1000, kind);
  }

  /** Dead reckoning: move each vehicle one interval ahead along its heading. */
  private extrapolate(): void {
    const { x, z, heading, speed } = this.buffer;
    const dt = this.tickInterval;
    for (let i = 0; i < this.buffer.count; i++) {
      const d = (speed[i] as number) * dt;
      x[i] = (x[i] as number) + Math.sin(heading[i] as number) * d;
      z[i] = (z[i] as number) - Math.cos(heading[i] as number) * d;
    }
  }

  /** Tell the server which local-metre box the camera looks at (viewport mode). */
  sendViewport(minX: number, maxX: number, minZ: number, maxZ: number): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.opts.mode === "viewport") {
      this.ws.send(JSON.stringify({ type: "viewport", minX, maxX, minZ, maxZ }));
    }
  }

  /** Frames arrive asynchronously; tick() has nothing to advance. */
  tick(): number {
    return 0;
  }

  dispose(): void {
    this.ws?.close();
    this.ws = null;
  }
}
