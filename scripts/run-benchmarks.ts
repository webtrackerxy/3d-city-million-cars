/**
 * Run benchmark scenarios in the locally installed Google Chrome (real GPU, not a
 * software renderer) and write a results table (spec §35, §47, §49).
 *
 *   node scripts/run-benchmarks.ts [--base http://localhost:5175] [--duration 10]
 *        [--only cubes-static,cubes-moving-gpu] [--count 100000] [--view city]
 *        [--out docs/benchmarks/latest.md]
 *
 * Requires the dev server (`npm run dev`) so results are also persisted per run under
 * docs/benchmarks/ by the dev-server endpoint. Each scenario runs in a fresh page.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

interface Summary {
  fps: number;
  frames: number;
  frameMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  cpuMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  gpuMs: { mean: number; p50: number; p95: number; p99: number; max: number } | null;
  drawCalls: number;
  triangles: number;
  longFrames: number;
  jsHeapMB: number | null;
}

interface Run {
  scenario: string;
  params: Record<string, number | string>;
  gpu: string;
  viewport: { width: number; height: number };
  pixelRatio: number;
  summary: Summary;
  scenarioStats: Record<string, number | string>;
}

interface Job {
  scenario: string;
  query: Record<string, string | number>;
  label: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const base = arg("base", "http://localhost:5175");
const duration = Number(arg("duration", "10"));
const warmup = Number(arg("warmup", "3"));
const count = Number(arg("count", "100000"));
const view = arg("view", "city");
const only = arg("only", "").split(",").filter(Boolean);
const out = resolve(arg("out", "docs/benchmarks/latest.md"));

const jobs: Job[] = [
  { scenario: "cubes-static", query: { count }, label: "B1 static cubes" },
  { scenario: "cubes-moving-cpu", query: { count }, label: "B2a moving cubes, CPU matrices" },
  { scenario: "cubes-moving-gpu", query: { count }, label: "B2b moving cubes, GPU state texture" },
  ...[200, 1000, 5000, 20000].map((tris) => ({
    scenario: "triangle-throughput",
    query: { count: 20000, tris },
    label: `throughput 20k × ${tris.toLocaleString()} tris`,
  })),
  { scenario: "cars-lod3", query: { count }, label: "B3 all cars LOD3" },
  { scenario: "cars-lod", query: { count }, label: "B4 bucketed LODs (city)" },
  { scenario: "cars-lod", query: { count, view: "street" }, label: "B4 bucketed LODs (street)" },
  {
    scenario: "cars-lod",
    query: { count, view: "street", cap1: 300, cap2: 1500, cap3: 8000 },
    label: "B4 bucketed LODs (street, wide caps 20/300/1500/8000)",
  },
].filter((j) => only.length === 0 || only.includes(j.scenario));

function fmt(n: number, digits = 1): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    // vsync stays on so runs match real usage; GPU/CPU ms are the discriminating metrics
    args: ["--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const results: (Run & { label: string })[] = [];
  try {
    for (const job of jobs) {
      const page = await context.newPage();
      const q = new URLSearchParams({
        view,
        ...Object.fromEntries(Object.entries(job.query).map(([k, v]) => [k, String(v)])),
        duration: String(duration),
        warmup: String(warmup),
      });
      const url = `${base}/bench/${job.scenario}?${q.toString()}`;
      process.stdout.write(`${job.label} … `);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(url, { waitUntil: "load" });
      const handle = await page.waitForFunction("window.__lastBenchmarkRun ?? null", null, {
        timeout: (duration + warmup + 30) * 1000,
        polling: 500,
      });
      const run = (await handle.jsonValue()) as Run;
      results.push({ ...run, label: job.label });
      const s = run.summary;
      console.log(
        `${fmt(s.fps)} fps, frame p50 ${fmt(s.frameMs.p50, 2)} ms, p95 ${fmt(s.frameMs.p95, 2)} ms, cpu ${fmt(s.cpuMs.mean, 2)} ms, ` +
          `${s.triangles.toLocaleString()} tris, ${s.drawCalls} calls` +
          (s.gpuMs ? `, gpu ${fmt(s.gpuMs.mean, 2)} ms` : "") +
          (errors.length ? `  [${errors.length} console errors: ${errors[0]}]` : ""),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const gpu = results[0]?.gpu ?? "unknown";
  const lines = [
    `# Benchmark results`,
    ``,
    `Generated ${new Date().toISOString()} by \`scripts/run-benchmarks.ts\` in Google Chrome (${gpu}),`,
    `viewport ${results[0]?.viewport.width ?? 0}×${results[0]?.viewport.height ?? 0} @ ${results[0]?.pixelRatio ?? 1}x, ` +
      `${duration} s recorded after ${warmup} s warm-up, camera preset "${view}". Hardware: Apple M1 Pro, 16 GB.`,
    ``,
    `| Scenario | Count | FPS | Frame p50 | Frame p95 | Frame max | CPU submit mean | GPU mean | Draw calls | Triangles / frame | Long frames | JS heap | Notes |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`,
    ...results.map((r) => {
      const s = r.summary;
      const notes = Object.entries(r.scenarioStats)
        .map(([k, v]) => `${k}=${typeof v === "number" ? v.toLocaleString() : v}`)
        .join(", ");
      return (
        `| ${r.label} | ${Number(r.params.count).toLocaleString()} | ${fmt(s.fps)} | ${fmt(s.frameMs.p50, 2)} ms | ` +
        `${fmt(s.frameMs.p95, 2)} ms | ${fmt(s.frameMs.max, 1)} ms | ${fmt(s.cpuMs.mean, 2)} ms | ${s.gpuMs ? `${fmt(s.gpuMs.mean, 2)} ms` : "n/a"} | ` +
        `${s.drawCalls} | ${s.triangles.toLocaleString()} | ${s.longFrames} | ${s.jsHeapMB === null ? "n/a" : `${fmt(s.jsHeapMB, 0)} MB`} | ${notes} |`
      );
    }),
    ``,
  ];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"));
  console.log(`\nwrote ${out}`);
}

await main();
