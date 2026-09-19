import type { PerspectiveCamera } from "three";
import type { ScenarioParams } from "./types.ts";

/** Fixed camera presets so runs are comparable. Area is a 3 km square around the origin. */
export function applyCameraPreset(camera: PerspectiveCamera, view: ScenarioParams["view"]): void {
  switch (view) {
    case "street":
      camera.position.set(-40, 6, 120);
      camera.lookAt(0, 1, -400);
      break;
    case "city":
      camera.position.set(0, 350, 900);
      camera.lookAt(0, 0, -200);
      break;
    case "overview":
      camera.position.set(0, 2200, 2600);
      camera.lookAt(0, 0, 0);
      break;
  }
  camera.updateProjectionMatrix();
}
