import type { MapSceneStats } from "@/map/MapScene.ts";

function trafficLine(stats: MapSceneStats): string {
  if (stats.traffic === "roads") return `OSM roads, ${stats.roadKm.toFixed(0)} km`;
  if (stats.traffic === "network" && stats.net) {
    const n = stats.net;
    return (
      `WebSocket ${n.connected ? "connected" : "connecting"} · ${n.lastKind} · ${n.framesPerSecond.toFixed(1)} frames/s · ` +
      `${n.kbPerSecond.toFixed(0)} KB/s (${((n.kbPerSecond * 8) / 1024).toFixed(1)} Mbit/s) · ` +
      `${(n.bytesPerFrame / 1024).toFixed(0)} KB/frame · decode ${n.decodeMs.toFixed(2)} ms`
    );
  }
  return "synthetic straight lines";
}

/** Development overlay (spec §50). */
export function DebugOverlay({ stats }: { stats: MapSceneStats | null }) {
  if (!stats) return <div className="overlay muted">loading…</div>;
  const [l0 = 0, l1 = 0, l2 = 0, l3 = 0, box = 0] = stats.lodCounts;
  return (
    <div className="overlay">
      <div>
        <b>{stats.fps.toFixed(0)} FPS</b> · {stats.frameMs.toFixed(1)} ms frame · layer{" "}
        {stats.layerMs.toFixed(1)} ms
        {stats.mode === "worker"
          ? ` · main-thread traffic glue ${stats.simulationMs.toFixed(2)} ms · worker: tick ${stats.workerTickMs.toFixed(1)} ms, bucketing ${stats.workerBucketMs.toFixed(1)} ms`
          : ` · bucketing ${stats.bucketingMs.toFixed(1)} ms · sim ${stats.simulationMs.toFixed(2)} ms (main thread)`}
      </div>
      <div>
        traffic: {trafficLine(stats)} · LOD in{" "}
        {stats.mode === "worker" ? "Web Worker (SharedArrayBuffer)" : "main thread"}
      </div>
      <div>
        vehicles {stats.vehicles.toLocaleString()} · visible {stats.visible.toLocaleString()} · culled{" "}
        {stats.culled.toLocaleString()} (frustum {stats.outsideFrustum.toLocaleString()})
      </div>
      <div>
        LOD0 {l0} · LOD1 {l1} · LOD2 {l2.toLocaleString()} · LOD3 {l3.toLocaleString()} · box{" "}
        {box.toLocaleString()} · caps ×{stats.lodCapScale.toFixed(2)}
        {stats.viewportBox
          ? ` · viewport ${(stats.viewportBox.maxX - stats.viewportBox.minX).toFixed(0)}×${(stats.viewportBox.maxZ - stats.viewportBox.minZ).toFixed(0)} m`
          : ""}
      </div>
      <div>
        {stats.drawCalls} draw calls · {stats.triangles.toLocaleString()} triangles · {stats.snapshots}{" "}
        snapshots · {stats.sharedMemory ? "SharedArrayBuffer" : "ArrayBuffer"}
      </div>
      <div>
        {stats.tiles
          ? `3D Tiles: ${stats.tiles.visible} visible · ${stats.tiles.active} active · ` +
            `${stats.tiles.downloading + stats.tiles.parsing + stats.tiles.queued} loading · ` +
            `${stats.tiles.failed} failed · cache ${stats.tiles.cachedMB.toFixed(0)} MB${stats.tiles.cacheFull ? " (full)" : ""}`
          : "3D Tiles: none for this city"}
      </div>
    </div>
  );
}
