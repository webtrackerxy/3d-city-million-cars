import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { findScenario, scenarios } from "@/benchmark/scenarios/index.ts";
import { parseParams, runBenchmark } from "@/benchmark/runBenchmark.ts";
import type { BenchmarkRun } from "@/benchmark/types.ts";
import type { BenchmarkSummary } from "@/benchmark/Recorder.ts";
import { createRenderer } from "@/rendering/createRenderer.ts";
import { StatsTable } from "@/components/StatsTable.tsx";

/** fleet sizes offered for the vehicle scenarios (the million run is the stress case) */
const FLEET_COUNTS = [100_000, 1_000_000];
const FLEET_MIN = 100_000;

export function BenchIndexPage() {
  return (
    <main className="page">
      <h1>Benchmarks</h1>
      <p>
        Each scenario runs with fixed camera presets and pixel ratio 1. Add <code>?count=</code>,{" "}
        <code>?duration=</code>, <code>?view=street|city|overview</code> or scenario parameters to the URL.
        Results are saved to <code>docs/benchmarks/</code> by the dev server.
      </p>
      <ul>
        {scenarios.map((s) => (
          <li key={s.id}>
            <Link to={`/bench/${s.id}`}>{s.title}</Link> — {s.description}
            {(s.defaults.count ?? 0) >= FLEET_MIN && (
              <>
                {" "}
                Run at{" "}
                {FLEET_COUNTS.map((n, i) => (
                  <span key={n}>
                    {i > 0 && " · "}
                    <Link to={`/bench/${s.id}?count=${String(n)}`}>{n.toLocaleString()}</Link>
                  </span>
                ))}
                .
              </>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

export function BenchPage() {
  const { scenario: id = "" } = useParams();
  const [search] = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<string>("loading");
  const [live, setLive] = useState<BenchmarkSummary | null>(null);
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scenario = findScenario(id);

  useEffect(() => {
    const container = containerRef.current;
    if (!scenario || !container) return;
    const params = parseParams(search, scenario.defaults);
    const bundle = createRenderer(container, { maxPixelRatio: 1, antialias: false, far: 12000 });
    let disposed = false;
    runBenchmark({
      bundle,
      scenario,
      params,
      onProgress: (p, left, summary) => {
        if (disposed) return;
        setPhase(`${p} ${left.toFixed(0)} s`);
        if (summary) setLive(summary);
      },
    })
      .then((result) => {
        if (!disposed) {
          setRun(result);
          setPhase("done");
        }
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      bundle.dispose();
    };
  }, [scenario, search]);

  if (!scenario) {
    return (
      <main className="page">
        <p>
          Unknown scenario <code>{id}</code>. <Link to="/bench">Back to the list</Link>.
        </p>
      </main>
    );
  }

  return (
    <div className="bench">
      <div ref={containerRef} className="canvas-host" />
      <aside className="panel">
        <h2>{scenario.title}</h2>
        <p className="muted">{scenario.description}</p>
        <p>
          <strong>{phase}</strong>
          {error && <span className="error"> {error}</span>}
        </p>
        {run ? (
          <>
            <StatsTable summary={run.summary} extra={run.scenarioStats} />
            <p className="muted">
              {run.gpu} · {run.viewport.width}×{run.viewport.height} @ {run.pixelRatio}x · saved to
              docs/benchmarks/
            </p>
          </>
        ) : (
          live && <StatsTable summary={live} />
        )}
        <p>
          <Link to="/bench">All scenarios</Link>
        </p>
      </aside>
    </div>
  );
}
