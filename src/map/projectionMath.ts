/**
 * Small float64 helpers for working with a full view-projection matrix (local metres
 * → clip space) without a Three.js camera object.
 */

import { Matrix4, Vector4 } from "three";

const tmpInverse = new Matrix4();
const tmpVec = new Vector4();

/**
 * Eye position of a perspective view-projection matrix. The eye is the point that
 * projects to the homogeneous direction (0, 0, 1, 0) in clip space, so it is
 * inverse(VP) · (0, 0, 1, 0) with the w component divided out.
 */
export function eyeFromViewProjection(vp: Matrix4, out: { x: number; y: number; z: number }): void {
  tmpInverse.copy(vp).invert();
  tmpVec.set(0, 0, 1, 0).applyMatrix4(tmpInverse);
  const w = tmpVec.w === 0 ? 1 : tmpVec.w;
  out.x = tmpVec.x / w;
  out.y = tmpVec.y / w;
  out.z = tmpVec.z / w;
}

/**
 * World-space ray through a normalised device coordinate (x, y in [−1, 1]).
 * Writes origin (near-plane point) and a unit direction.
 */
export function rayFromViewProjection(
  vp: Matrix4,
  ndcX: number,
  ndcY: number,
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
): void {
  tmpInverse.copy(vp).invert();
  tmpVec.set(ndcX, ndcY, -1, 1).applyMatrix4(tmpInverse);
  const nx = tmpVec.x / tmpVec.w;
  const ny = tmpVec.y / tmpVec.w;
  const nz = tmpVec.z / tmpVec.w;
  tmpVec.set(ndcX, ndcY, 1, 1).applyMatrix4(tmpInverse);
  const fx = tmpVec.x / tmpVec.w;
  const fy = tmpVec.y / tmpVec.w;
  const fz = tmpVec.z / tmpVec.w;
  let dx = fx - nx;
  let dy = fy - ny;
  let dz = fz - nz;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  origin.x = nx;
  origin.y = ny;
  origin.z = nz;
  direction.x = dx;
  direction.y = dy;
  direction.z = dz;
}
