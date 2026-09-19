import { describe, expect, it } from "vitest";
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { eyeFromViewProjection, rayFromViewProjection } from "./projectionMath.ts";

function cameraVP(): { camera: PerspectiveCamera; vp: Matrix4 } {
  const camera = new PerspectiveCamera(50, 1.6, 1, 5000);
  camera.position.set(123.4, 250, -678.9);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const vp = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { camera, vp };
}

describe("projectionMath", () => {
  it("recovers the eye position from a view-projection matrix", () => {
    const { camera, vp } = cameraVP();
    const eye = { x: 0, y: 0, z: 0 };
    eyeFromViewProjection(vp, eye);
    expect(eye.x).toBeCloseTo(camera.position.x, 6);
    expect(eye.y).toBeCloseTo(camera.position.y, 6);
    expect(eye.z).toBeCloseTo(camera.position.z, 6);
  });

  it("builds a ray through the screen centre that passes through the look-at target", () => {
    const { camera, vp } = cameraVP();
    const origin = { x: 0, y: 0, z: 0 };
    const dir = { x: 0, y: 0, z: 0 };
    rayFromViewProjection(vp, 0, 0, origin, dir);
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    expect(dir.x).toBeCloseTo(forward.x, 6);
    expect(dir.y).toBeCloseTo(forward.y, 6);
    expect(dir.z).toBeCloseTo(forward.z, 6);
    // the target (0,0,0) lies on the ray: distance from ray to origin point ~ 0
    const t = -(origin.x * dir.x + origin.y * dir.y + origin.z * dir.z);
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    expect(Math.hypot(px, py, pz)).toBeLessThan(1e-3);
  });
});
