/**
 * ShaderMaterial for GPU-instanced vehicles whose transforms come from the state texture.
 *
 * Per-instance attribute: `vehicleId` (float). The vertex shader fetches prev/next
 * (x, y, z, heading) by id, interpolates with `uT`, rotates the model about +Y by
 * (π − heading) as in docs/coordinates.md §3, and applies the mesh's modelMatrix so the
 * same material works inside a MapLibre custom layer. Body colour comes from the
 * attribute texture's colour index through a palette uniform; non-tinted materials use
 * a fixed base colour.
 *
 * With a height field bound (`uTerrain` = 1) the vertex shader samples the ground slope
 * around the vehicle and tilts the body so its up axis follows the terrain normal while
 * keeping the heading; on flat ground the basis reduces to the plain heading rotation.
 *
 * Lighting is a cheap Lambert + hemisphere term: the point is throughput, not PBR.
 */

import { Color, GLSL3, ShaderMaterial, Vector2, Vector3, type Texture } from "three";

export const PALETTE_SIZE = 16;

const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

in float vehicleId;

uniform sampler2D uPrev;
uniform sampler2D uNext;
uniform sampler2D uAttr;
uniform float uT;
uniform int uTexWidth;
uniform float uTintByInstance;
uniform vec3 uBaseColor;
uniform vec3 uPalette[${PALETTE_SIZE}];
uniform float uSelectedId;
uniform vec3 uHighlightColor;
// terrain: R32F elevation grid in local metres (see src/geo/HeightField.ts)
uniform float uTerrain;
uniform sampler2D uHeight;
uniform vec2 uHfOrigin;
uniform float uHfInvSpacing;
uniform ivec2 uHfSize;

out vec3 vNormal;
out vec3 vColor;

const float PI = 3.141592653589793;
const float TWO_PI = 6.283185307179586;
const float MAX_GRADE = 0.25;

mat3 rotationY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c);
}

// bilinear ground height at local (x, z), clamped to the grid
float groundHeight(vec2 xz) {
  vec2 f = clamp((xz - uHfOrigin) * uHfInvSpacing, vec2(0.0), vec2(uHfSize) - 1.001);
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  float h00 = texelFetch(uHeight, i, 0).r;
  float h10 = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
}

// orthonormal basis (right, up, forward) with up = terrain normal, forward as close to
// the heading as the slope allows; equals rotationY(PI - heading) on flat ground
mat3 terrainBasis(mat3 R, vec2 xz) {
  vec3 f = R * vec3(0.0, 0.0, 1.0);
  const float d = 6.0; // metres either side, longer than a car so the grade is smooth
  vec2 g = vec2(groundHeight(xz + vec2(d, 0.0)) - groundHeight(xz - vec2(d, 0.0)),
                groundHeight(xz + vec2(0.0, d)) - groundHeight(xz - vec2(0.0, d))) / (2.0 * d);
  // the DEM has step artefacts at flyovers and reclaimed shorelines; no road is steeper
  // than about 1:4, so clamp the grade before it becomes a tilt
  float len = length(g);
  if (len > MAX_GRADE) g *= MAX_GRADE / len;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 fwd = normalize(f - n * dot(f, n));
  vec3 right = cross(n, fwd);
  return mat3(right, n, fwd);
}

void main() {
  int id = int(vehicleId + 0.5);
  ivec2 tc = ivec2(id % uTexWidth, id / uTexWidth);
  vec4 a = texelFetch(uPrev, tc, 0);
  vec4 b = texelFetch(uNext, tc, 0);
  vec3 p = mix(a.xyz, b.xyz, uT);
  float d = b.w - a.w;
  d -= TWO_PI * floor((d + PI) / TWO_PI);
  float heading = a.w + d * uT;
  mat3 R = rotationY(PI - heading);
  if (uTerrain > 0.5) {
    // sit on the same grid the tilt is computed from (the simulation interpolates
    // elevation between road nodes, which drifts from the ground between them)
    p.y = groundHeight(p.xz) + 0.05;
    R = terrainBasis(R, p.xz);
  }
  vec3 local = R * position + p;
  vec4 world = modelMatrix * vec4(local, 1.0);
  vNormal = normalize(mat3(modelMatrix) * (R * normal));
  int colorIndex = int(texelFetch(uAttr, tc, 0).g * 255.0 + 0.5) % ${PALETTE_SIZE};
  vColor = mix(uBaseColor, uPalette[colorIndex], uTintByInstance);
  if (abs(vehicleId - uSelectedId) < 0.5) vColor = uHighlightColor;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

in vec3 vNormal;
in vec3 vColor;
uniform vec3 uLightDir;
out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  float diffuse = max(dot(n, uLightDir), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 ambient = mix(vec3(0.20, 0.21, 0.24), vec3(0.45, 0.47, 0.52), hemi);
  vec3 c = vColor * (ambient + 0.85 * diffuse);
  outColor = vec4(c, 1.0);
}
`;

/** an R32F elevation grid on the GPU, local metres, row-major from (originX, originZ) */
export interface HeightFieldTexture {
  texture: Texture;
  originX: number;
  originZ: number;
  spacing: number;
  width: number;
  height: number;
}

export interface InstancedVehicleMaterialOptions {
  prev: Texture;
  next: Texture;
  attributes: Texture;
  texWidth: number;
  palette: readonly (readonly [number, number, number])[];
  /** fixed colour for non-tinted materials (glass, rubber, ...) */
  baseColor?: Color;
  /** when true, the palette colour selected by the vehicle's colour index replaces baseColor */
  tintByInstance?: boolean;
}

export class InstancedVehicleMaterial extends ShaderMaterial {
  constructor(opts: InstancedVehicleMaterialOptions) {
    const palette: Vector3[] = [];
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const c = opts.palette[i % Math.max(1, opts.palette.length)] ?? [0.8, 0.8, 0.8];
      palette.push(new Vector3(c[0], c[1], c[2]));
    }
    super({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uPrev: { value: opts.prev },
        uNext: { value: opts.next },
        uAttr: { value: opts.attributes },
        uT: { value: 1 },
        uTexWidth: { value: opts.texWidth },
        uTintByInstance: { value: opts.tintByInstance ? 1 : 0 },
        uBaseColor: { value: opts.baseColor ?? new Color(0.8, 0.8, 0.8) },
        uPalette: { value: palette },
        uSelectedId: { value: -1 },
        uHighlightColor: { value: new Color(1.0, 0.35, 0.05) },
        uLightDir: { value: new Vector3(0.4, 0.8, 0.45).normalize() },
        uTerrain: { value: 0 },
        uHeight: { value: null },
        uHfOrigin: { value: new Vector2() },
        uHfInvSpacing: { value: 1 },
        uHfSize: { value: [1, 1] },
      },
    });
  }

  /** Bind (or clear with null) the elevation grid that tilts vehicles to the ground. */
  setHeightField(field: HeightFieldTexture | null): void {
    const u = this.uniforms;
    (u.uTerrain as { value: number }).value = field ? 1 : 0;
    (u.uHeight as { value: Texture | null }).value = field?.texture ?? null;
    if (field) {
      (u.uHfOrigin as { value: Vector2 }).value.set(field.originX, field.originZ);
      (u.uHfInvSpacing as { value: number }).value = 1 / field.spacing;
      (u.uHfSize as { value: number[] }).value = [field.width, field.height];
    }
  }

  set interpolation(t: number) {
    (this.uniforms.uT as { value: number }).value = t;
  }

  /** Vehicle id drawn in the highlight colour on every primitive, or −1. */
  set selectedId(id: number) {
    (this.uniforms.uSelectedId as { value: number }).value = id;
  }
}
