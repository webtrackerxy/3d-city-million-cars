import type { BenchmarkSummary } from "@/benchmark/Recorder.ts";

function ms(v: number): string {
  return `${v.toFixed(2)} ms`;
}

export function StatsTable({
  summary,
  extra,
}: {
  summary: BenchmarkSummary;
  extra?: Record<string, number | string>;
}) {
  const rows: [string, string][] = [
    ["FPS", summary.fps.toFixed(1)],
    ["Frames", String(summary.frames)],
    ["Frame time mean / p50", `${ms(summary.frameMs.mean)} / ${ms(summary.frameMs.p50)}`],
    [
      "Frame time p95 / p99 / max",
      `${ms(summary.frameMs.p95)} / ${ms(summary.frameMs.p99)} / ${ms(summary.frameMs.max)}`,
    ],
    ["Long frames (> 33 ms)", String(summary.longFrames)],
    ["CPU submit mean / p95", `${ms(summary.cpuMs.mean)} / ${ms(summary.cpuMs.p95)}`],
    [
      "GPU time mean / p95",
      summary.gpuMs ? `${ms(summary.gpuMs.mean)} / ${ms(summary.gpuMs.p95)}` : "n/a (no timer query)",
    ],
    ["Draw calls", summary.drawCalls.toLocaleString()],
    ["Triangles / frame", summary.triangles.toLocaleString()],
    ["JS heap", summary.jsHeapMB === null ? "n/a" : `${summary.jsHeapMB.toFixed(0)} MB`],
    ...Object.entries(extra ?? {}).map(([k, v]): [string, string] => [
      k,
      typeof v === "number" ? v.toLocaleString() : v,
    ]),
  ];
  return (
    <table className="stats">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
