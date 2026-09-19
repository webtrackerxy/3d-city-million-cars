/**
 * /lod-test (spec §26): the four LODs side by side with orbit, wireframe, material and
 * variant (raw / optimised) toggles, per-LOD statistics from the manifest and live
 * counts from the renderer. All Three.js work lives in LodViewerScene.
 */

import { useEffect, useRef, useState } from "react";
import { loadManifest, vehicleAssetUrl } from "@/data/loadManifest.ts";
import { loadVehicleLod, type LoadedLod } from "@/rendering/assets/loadVehicleLod.ts";
import { LodViewerScene, type LiveStats, type LodLabelAnchor } from "@/rendering/LodViewerScene.ts";
import type { VehicleAssetManifest, VehicleLodEntry } from "@/types/manifest.ts";

const VEHICLE = "porsche";

type Variant = "raw" | "optimized";

function lodKey(variant: Variant, id: number): string {
  return `${variant}:${id}`;
}

export function LodTestPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<LodViewerScene | null>(null);
  const loadTokenRef = useRef<object>({});
  const [manifest, setManifest] = useState<VehicleAssetManifest | null>(null);
  const [loaded, setLoaded] = useState<Record<string, LoadedLod>>({});
  const [variant, setVariant] = useState<Variant>("raw");
  const [wireframe, setWireframe] = useState(false);
  const [materials, setMaterials] = useState(true);
  const [visible, setVisible] = useState<number | "all">("all");
  const [live, setLive] = useState<LiveStats>({ fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 });
  const [labels, setLabels] = useState<LodLabelAnchor[]>([]);
  const labelFrame = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadManifest(VEHICLE)
      .then(setManifest)
      .catch((e: unknown) => {
        setError(String(e));
      });
  }, []);

  // scene lifetime
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !manifest) return;
    const scene = new LodViewerScene(host, {
      lodIds: manifest.lods.map((l) => l.id),
      onStats: setLive,
      onLabels: (anchors) => {
        // labels move with the orbit; update React at ~30 Hz, not every frame
        if (++labelFrame.current % 2 === 0) setLabels(anchors.map((a) => ({ ...a })));
      },
    });
    sceneRef.current = scene;
    if (import.meta.env.DEV) (window as unknown as { __lodScene?: LodViewerScene }).__lodScene = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, [manifest]);

  // load GLBs for the selected variant
  useEffect(() => {
    if (!manifest) return;
    const token = {};
    loadTokenRef.current = token;
    sceneRef.current?.clearLods();
    void (async () => {
      for (const lod of manifest.lods) {
        const file = variant === "optimized" && lod.optimized ? lod.optimized.file : lod.file;
        try {
          const result = await loadVehicleLod(vehicleAssetUrl(VEHICLE, file));
          if (loadTokenRef.current !== token) return;
          sceneRef.current?.setLod(lod.id, result.primitives);
          setLoaded((prev) => ({ ...prev, [lodKey(variant, lod.id)]: result }));
        } catch (e) {
          if (loadTokenRef.current === token) setError(`${file}: ${String(e)}`);
        }
      }
    })();
  }, [manifest, variant]);

  useEffect(() => {
    sceneRef.current?.setVisible(visible);
  }, [visible, manifest]);
  useEffect(() => {
    sceneRef.current?.setWireframe(wireframe);
  }, [wireframe, manifest]);
  useEffect(() => {
    sceneRef.current?.setMaterials(materials);
  }, [materials, manifest]);

  return (
    <div className="lod-test">
      <div ref={hostRef} className="canvas-host" />
      {labels.map((a) => {
        const lod = manifest?.lods.find((l) => l.id === a.id);
        const result = loaded[lodKey(variant, a.id)];
        if (!a.visible || !lod) return null;
        return (
          <div key={a.id} className="lod-label" style={{ left: a.x, top: a.y }}>
            <b>LOD{a.id}</b>
            <span>
              {(result?.triangles ?? lod.triangles).toLocaleString()} tris ·{" "}
              {(result?.vertices ?? lod.vertices).toLocaleString()} verts
            </span>
            <span>{formatBytes(fileBytes(lod, variant))}</span>
          </div>
        );
      })}
      <aside className="panel">
        <h2>LOD comparison</h2>
        {error && <p className="error">{error}</p>}
        <div className="controls">
          <label>
            Variant{" "}
            <select
              value={variant}
              onChange={(e) => {
                setVariant(e.target.value as Variant);
              }}
            >
              <option value="raw">raw GLB</option>
              <option value="optimized">optimised (quantised + meshopt)</option>
            </select>
          </label>
          <label>
            Show{" "}
            <select
              value={String(visible)}
              onChange={(e) => {
                setVisible(e.target.value === "all" ? "all" : Number(e.target.value));
              }}
            >
              <option value="all">all</option>
              {manifest?.lods.map((l) => (
                <option key={l.id} value={l.id}>
                  LOD{l.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={wireframe}
              onChange={(e) => {
                setWireframe(e.target.checked);
              }}
            />{" "}
            wireframe
          </label>
          <label>
            <input
              type="checkbox"
              checked={materials}
              onChange={(e) => {
                setMaterials(e.target.checked);
              }}
            />{" "}
            materials
          </label>
        </div>
        <table className="stats">
          <thead>
            <tr>
              <th>LOD</th>
              <th>Triangles</th>
              <th>GPU verts</th>
              <th>Prims</th>
              <th>GLB</th>
              <th>Fetch</th>
              <th>Parse</th>
            </tr>
          </thead>
          <tbody>
            {manifest?.lods.map((lod) => {
              const result = loaded[lodKey(variant, lod.id)];
              return (
                <tr key={lod.id}>
                  <td>LOD{lod.id}</td>
                  <td>{(result?.triangles ?? lod.triangles).toLocaleString()}</td>
                  <td>{result ? result.vertices.toLocaleString() : "…"}</td>
                  <td>{result ? result.primitives.length : lod.materials.length}</td>
                  <td>{formatBytes(fileBytes(lod, variant))}</td>
                  <td>{result ? `${result.loadMs.toFixed(0)} ms` : "…"}</td>
                  <td>{result ? `${result.parseMs.toFixed(1)} ms` : "…"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">
          {live.fps.toFixed(0)} FPS · {live.frameMs.toFixed(2)} ms · {live.drawCalls} draw calls ·{" "}
          {live.triangles.toLocaleString()} triangles · texture memory 0 MB (untextured asset)
        </p>
        <p className="muted">
          Drag to orbit, wheel to zoom. Source: {manifest?.source.triangles?.toLocaleString()} triangles.
        </p>
      </aside>
    </div>
  );
}

function fileBytes(lod: VehicleLodEntry, variant: Variant): number {
  return variant === "optimized" && lod.optimized ? lod.optimized.bytes : lod.bytes;
}

function formatBytes(b: number): string {
  return b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(0)} KB`;
}
