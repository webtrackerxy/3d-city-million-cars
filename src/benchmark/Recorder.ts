/**
 * Frame-time recorder for benchmarks and the debug overlay (spec §35, §49, §50).
 *
 * Collects per-frame CPU frame time, renderer draw calls and triangles, JS heap (Chrome
 * only) and, when the WebGL2 `EXT_disjoint_timer_query_webgl2` extension is available,
 * GPU time per frame. Produces a summary with percentiles.
 */

import type { WebGLRenderer } from "three";

export interface FrameSample {
  /** wall-clock interval since the previous frame began (what FPS is made of) */
  frameMs: number;
  /** JavaScript time between beginFrame and endFrame (scene update + draw submission) */
  cpuMs: number;
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
}

export interface BenchmarkSummary {
  frames: number;
  seconds: number;
  fps: number;
  frameMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  cpuMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  gpuMs: { mean: number; p50: number; p95: number; p99: number; max: number } | null;
  drawCalls: number;
  triangles: number;
  longFrames: number;
  jsHeapMB: number | null;
}

interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx] as number;
}

function stats(values: number[]): { mean: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  readonly results: number[] = [];
  private lastResult: number | null = null;

  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  private constructor(gl: WebGL2RenderingContext, ext: TimerExt) {
    this.gl = gl;
    this.ext = ext;
  }

  begin(): void {
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Poll finished queries; returns the latest GPU time in ms if any completed. */
  poll(): number | null {
    const gl = this.gl;
    while (this.pending.length > 0) {
      const q = this.pending[0] as WebGLQuery;
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!available) break;
      this.pending.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this.lastResult = ns / 1e6;
        this.results.push(this.lastResult);
      }
      gl.deleteQuery(q);
    }
    return this.lastResult;
  }

  dispose(): void {
    for (const q of this.pending) this.gl.deleteQuery(q);
    this.pending.length = 0;
  }
}

export class Recorder {
  private readonly samples: FrameSample[] = [];
  private readonly gpu: GpuTimer | null;
  private frameStart = 0;
  private previousFrameStart = 0;
  private recordingStart = 0;
  private recordingEnd = 0;
  recording = false;

  constructor(private readonly renderer: WebGLRenderer) {
    const gl = renderer.getContext();
    this.gpu = gl instanceof WebGL2RenderingContext ? GpuTimer.create(gl) : null;
  }

  get hasGpuTimer(): boolean {
    return this.gpu !== null;
  }

  /** Call before rendering the frame. */
  beginFrame(): void {
    this.previousFrameStart = this.frameStart;
    this.frameStart = performance.now();
    this.renderer.info.reset();
    this.gpu?.begin();
  }

  /** Call after rendering the frame. */
  endFrame(): FrameSample {
    this.gpu?.end();
    const gpuMs = this.gpu?.poll() ?? null;
    const now = performance.now();
    const sample: FrameSample = {
      frameMs: this.previousFrameStart > 0 ? this.frameStart - this.previousFrameStart : 0,
      cpuMs: now - this.frameStart,
      gpuMs,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
    if (this.recording) {
      this.samples.push(sample);
      this.recordingEnd = now;
    }
    return sample;
  }

  start(): void {
    this.samples.length = 0;
    if (this.gpu) this.gpu.results.length = 0;
    this.recordingStart = performance.now();
    this.recordingEnd = this.recordingStart;
    this.recording = true;
  }

  stop(): BenchmarkSummary {
    this.recording = false;
    return this.summary();
  }

  summary(): BenchmarkSummary {
    const frameMs = this.samples.map((s) => s.frameMs).filter((v) => v > 0);
    const cpuMs = this.samples.map((s) => s.cpuMs);
    const seconds = (this.recordingEnd - this.recordingStart) / 1000;
    const gpuValues = this.gpu?.results ?? [];
    const last = this.samples[this.samples.length - 1];
    const mem = (performance as PerformanceWithMemory).memory;
    return {
      frames: this.samples.length,
      seconds,
      fps: seconds > 0 ? this.samples.length / seconds : 0,
      frameMs: stats(frameMs),
      cpuMs: stats(cpuMs),
      gpuMs: gpuValues.length > 0 ? stats(gpuValues) : null,
      drawCalls: last?.drawCalls ?? 0,
      triangles: last?.triangles ?? 0,
      longFrames: frameMs.filter((v) => v > 33.4).length,
      jsHeapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
    };
  }

  dispose(): void {
    this.gpu?.dispose();
  }
}
