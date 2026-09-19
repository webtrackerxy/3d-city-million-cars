import { Link } from "react-router";
import { supportsSharedMemory } from "@/data/VehicleBuffer.ts";

export function HomePage() {
  return (
    <main className="page">
      <h1>3D City · 1 Million Cars</h1>
      <p>Development entry points for the traffic visualisation prototype.</p>
      <ul>
        <li>
          <Link to="/">City map</Link> — MapLibre basemap with up to 1,000,000 vehicles in the custom layer
          (London; 100,000 in the other cities), debug overlay, click to inspect. Query parameters:{" "}
          <code>city</code>, <code>vehicles</code>, <code>basemap</code>, <code>buildings</code>,{" "}
          <code>terrain</code>, <code>source=ws</code>, <code>tileset</code>, <code>ground</code>.
        </li>
        <li>
          <Link to="/lod-test">LOD comparison</Link> — the four Porsche LODs side by side with statistics.
        </li>
        <li>
          <Link to="/bench">Benchmarks</Link> — GPU scenarios at 100,000 and 1,000,000 instances with recorded
          results.
        </li>
      </ul>
      <p className="muted">
        Cross-origin isolated (SharedArrayBuffer): {supportsSharedMemory() ? "yes" : "no"} · WebGL2:{" "}
        {typeof WebGL2RenderingContext !== "undefined" ? "yes" : "no"} · WebGPU:{" "}
        {"gpu" in navigator ? "available" : "no"}
      </p>
    </main>
  );
}
