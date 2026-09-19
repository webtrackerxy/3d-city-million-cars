/**
 * Drives one scenario: warm-up, timed recording, summary, optional persistence through
 * the dev server (`POST /__bench/record`, see tooling/vite-plugin-project-assets.ts).
 */

import { Vector2 } from "three";
import type { RendererBundle } from "@/rendering/createRenderer.ts";
import { RenderLoop } from "@/rendering/RenderLoop.ts";
import { Recorder, type BenchmarkSummary } from "./Recorder.ts";
import type { BenchmarkRun, Scenario, ScenarioParams } from "./types.ts";

declare global {
  interface Window {
    /** last completed run, read by scripts/run-benchmarks.ts through Playwright */
    __lastBenchmarkRun?: BenchmarkRun;
  }
}

export interface RunOptions {
  bundle: RendererBundle;
  scenario: Scenario;
  params: ScenarioParams;
  onProgress?: (
    phase: "warmup" | "recording" | "done",
    secondsLeft: number,
    live: BenchmarkSummary | null,
  ) => void;
  persist?: boolean;
}

export function gpuDescription(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
  return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
}

export async function runBenchmark(opts: RunOptions): Promise<BenchmarkRun> {
  const { bundle, scenario, params } = opts;
  const { renderer, scene, camera } = bundle;
  const handle = await scenario.setup({ renderer, scene, camera, params });
  const recorder = new Recorder(renderer);
  const loop = new RenderLoop();
  const warmupEnd = params.warmup;
  const recordEnd = params.warmup + params.duration;

  const run = await new Promise<BenchmarkRun>((resolve) => {
    let started = false;
    loop.add((info) => {
      recorder.beginFrame(); // CPU window covers scenario update + draw submission
      handle.update(info.dt, info.elapsed);
      renderer.render(scene, camera);
      recorder.endFrame();
      if (!started && info.elapsed >= warmupEnd) {
        started = true;
        recorder.start();
      }
      if (info.frame % 15 === 0) {
        const phase = started ? "recording" : "warmup";
        const left = started ? recordEnd - info.elapsed : warmupEnd - info.elapsed;
        opts.onProgress?.(phase, Math.max(0, left), started ? recorder.summary() : null);
      }
      if (info.elapsed >= recordEnd) {
        loop.stop();
        const summary = recorder.stop();
        const size = renderer.getSize(new Vector2());
        resolve({
          name: `${scenario.id}-${params.count}`,
          scenario: scenario.id,
          params,
          startedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
          hardware: "Apple M1 Pro 16 GB",
          gpu: gpuDescription(renderer.getContext()),
          pixelRatio: renderer.getPixelRatio(),
          viewport: { width: size.x, height: size.y },
          summary,
          scenarioStats: handle.stats?.() ?? {},
        });
      }
    });
    loop.start();
  });

  opts.onProgress?.("done", 0, run.summary);
  handle.dispose();
  recorder.dispose();
  window.__lastBenchmarkRun = run;

  if (opts.persist ?? true) {
    try {
      await fetch("/__bench/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(run),
      });
    } catch (err) {
      console.warn("benchmark result not persisted", err);
    }
  }
  return run;
}

export function parseParams(search: URLSearchParams, defaults: Partial<ScenarioParams>): ScenarioParams {
  const params: ScenarioParams = {
    count: 100000,
    duration: 15,
    warmup: 3,
    view: "city",
    ...defaults,
  };
  for (const [key, raw] of search) {
    if (key === "view") {
      if (raw === "street" || raw === "city" || raw === "overview") params.view = raw;
      continue;
    }
    const n = Number(raw);
    params[key] = Number.isFinite(n) ? n : raw;
  }
  return params;
}
