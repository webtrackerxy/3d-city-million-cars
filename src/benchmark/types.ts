import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { BenchmarkSummary } from "./Recorder.ts";

export interface ScenarioParams {
  /** number of vehicles / instances */
  count: number;
  /** seconds to record after warm-up */
  duration: number;
  /** seconds of warm-up before recording */
  warmup: number;
  /** camera preset */
  view: "street" | "city" | "overview";
  /** scenario-specific numeric parameters (e.g. triangles per instance) */
  [key: string]: number | string;
}

export interface ScenarioContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  params: ScenarioParams;
}

export interface ScenarioHandle {
  /** called every frame before render */
  update(dt: number, elapsed: number): void;
  /** scenario-specific numbers to include in the report (e.g. state uploads) */
  stats?(): Record<string, number | string>;
  dispose(): void;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  defaults: Partial<ScenarioParams>;
  setup(ctx: ScenarioContext): Promise<ScenarioHandle> | ScenarioHandle;
}

export interface BenchmarkRun {
  name: string;
  scenario: string;
  params: ScenarioParams;
  startedAt: string;
  userAgent: string;
  hardware: string;
  gpu: string;
  pixelRatio: number;
  viewport: { width: number; height: number };
  summary: BenchmarkSummary;
  scenarioStats: Record<string, number | string>;
}
