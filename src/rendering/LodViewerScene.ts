/**
 * Three.js side of the /lod-test page: a row of LOD groups with orbit controls, an
 * environment map, live frame statistics, and toggles for visibility, wireframe and
 * materials. React only calls the methods; no scene object leaks into component state.
 */

import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  type Material,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Vector3 } from "three";
import { Recorder } from "@/benchmark/Recorder.ts";
import { createRenderer, type RendererBundle } from "./createRenderer.ts";
import { RenderLoop } from "./RenderLoop.ts";
import type { LodPrimitive } from "./assets/loadVehicleLod.ts";

export interface LiveStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

/** Screen-space anchor for a label above one LOD's car (CSS pixels in the canvas). */
export interface LodLabelAnchor {
  id: number;
  x: number;
  y: number;
  visible: boolean;
}

export interface LodViewerOptions {
  lodIds: number[];
  spacing?: number;
  onStats?: (stats: LiveStats) => void;
  /** called every frame with the projected label anchors */
  onLabels?: (anchors: LodLabelAnchor[]) => void;
}

interface LodEntry {
  group: Group;
  meshes: Mesh[];
  standard: Material[];
}

const plainMaterial = new MeshBasicMaterial({ color: 0xcfd3da });

export class LodViewerScene {
  private readonly bundle: RendererBundle;
  private readonly controls: OrbitControls;
  private readonly pmrem: PMREMGenerator;
  private readonly recorder: Recorder;
  private readonly loop = new RenderLoop();
  private readonly lods = new Map<number, LodEntry>();
  private visible: number | "all" = "all";
  private wireframe = false;
  private materials = true;
  private readonly anchors: LodLabelAnchor[] = [];
  private readonly projected = new Vector3();

  constructor(host: HTMLElement, opts: LodViewerOptions) {
    const spacing = opts.spacing ?? 3.2;
    this.bundle = createRenderer(host, { near: 0.1, far: 500, fov: 40 });
    const { renderer, scene, camera } = this.bundle;
    scene.background = new Color(0x2b2f3a);
    this.pmrem = new PMREMGenerator(renderer);
    scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.add(new HemisphereLight(0xffffff, 0x444444, 0.6));
    const sun = new DirectionalLight(0xffffff, 1.2);
    sun.position.set(5, 10, 7);
    scene.add(sun);

    const total = opts.lodIds.length;
    camera.position.set(0, 3.5, 9 + total * 1.2);
    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.target.set(0, 0.6, 0);
    this.controls.update();

    opts.lodIds.forEach((id, index) => {
      const group = new Group();
      group.position.x = (index - (total - 1) / 2) * spacing;
      scene.add(group);
      this.lods.set(id, { group, meshes: [], standard: [] });
    });

    this.recorder = new Recorder(renderer);
    for (const id of opts.lodIds) this.anchors.push({ id, x: 0, y: 0, visible: false });
    let acc = 0;
    let frames = 0;
    let accMs = 0;
    this.loop.add((info) => {
      this.controls.update();
      this.recorder.beginFrame();
      renderer.render(scene, camera);
      const s = this.recorder.endFrame();
      if (opts.onLabels) {
        const width = renderer.domElement.clientWidth;
        const height = renderer.domElement.clientHeight;
        let k = 0;
        for (const [id, entry] of this.lods) {
          const anchor = this.anchors[k++];
          if (!anchor) continue;
          this.projected.set(entry.group.position.x, 1.6, entry.group.position.z).project(camera);
          anchor.id = id;
          anchor.x = ((this.projected.x + 1) / 2) * width;
          anchor.y = ((1 - this.projected.y) / 2) * height;
          anchor.visible = entry.group.visible && entry.meshes.length > 0 && Math.abs(this.projected.z) < 1;
        }
        opts.onLabels(this.anchors);
      }
      acc += info.dt;
      frames++;
      accMs += s.frameMs;
      if (acc >= 0.5) {
        opts.onStats?.({
          fps: frames / acc,
          frameMs: accMs / frames,
          drawCalls: s.drawCalls,
          triangles: s.triangles,
        });
        acc = 0;
        frames = 0;
        accMs = 0;
      }
    });
    this.loop.start();
  }

  /** Debug: camera and group placement. */
  describe(): { camera: number[]; target: number[]; groups: Record<number, number[]> } {
    const groups: Record<number, number[]> = {};
    for (const [id, e] of this.lods) groups[id] = e.group.position.toArray();
    return { camera: this.bundle.camera.position.toArray(), target: this.controls.target.toArray(), groups };
  }

  /** Replace the geometry shown for one LOD. */
  setLod(id: number, primitives: LodPrimitive[]): void {
    const entry = this.lods.get(id);
    if (!entry) return;
    entry.group.clear();
    entry.meshes = primitives.map((p) => new Mesh(p.geometry, p.sourceMaterial));
    entry.standard = primitives.map((p) => p.sourceMaterial);
    for (const m of entry.meshes) entry.group.add(m);
    this.applyToggles();
  }

  clearLods(): void {
    for (const entry of this.lods.values()) {
      entry.group.clear();
      entry.meshes = [];
      entry.standard = [];
    }
  }

  setVisible(which: number | "all"): void {
    this.visible = which;
    this.applyToggles();
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyToggles();
  }

  setMaterials(on: boolean): void {
    this.materials = on;
    this.applyToggles();
  }

  private applyToggles(): void {
    plainMaterial.wireframe = this.wireframe;
    for (const [id, entry] of this.lods) {
      entry.group.visible = this.visible === "all" || this.visible === id;
      entry.meshes.forEach((mesh, i) => {
        const std = entry.standard[i];
        if (!std) return;
        mesh.material = this.materials ? std : plainMaterial;
        if ("wireframe" in std) (std as Material & { wireframe: boolean }).wireframe = this.wireframe;
      });
    }
  }

  dispose(): void {
    this.loop.stop();
    this.recorder.dispose();
    this.controls.dispose();
    this.pmrem.dispose();
    this.bundle.dispose();
  }
}
