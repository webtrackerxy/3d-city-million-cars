import { ACESFilmicToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from "three";

export interface RendererBundle {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** Call on container resize; returns the new size. */
  resize(): { width: number; height: number };
  dispose(): void;
}

export interface RendererOptions {
  antialias?: boolean;
  /** cap the device pixel ratio (benchmarks fix it to 1 for comparability) */
  maxPixelRatio?: number;
  near?: number;
  far?: number;
  fov?: number;
}

/**
 * Standard WebGL2 renderer + scene + camera for pages and benchmarks. MapLibre
 * integration (phase C2) constructs the renderer differently, sharing MapLibre's context.
 */
export function createRenderer(container: HTMLElement, opts: RendererOptions = {}): RendererBundle {
  const renderer = new WebGLRenderer({
    antialias: opts.antialias ?? true,
    powerPreference: "high-performance",
    // needed for GPU timer queries and readbacks in benchmarks
    preserveDrawingBuffer: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio ?? 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";

  const scene = new Scene();
  const camera = new PerspectiveCamera(opts.fov ?? 55, 1, opts.near ?? 0.5, opts.far ?? 20000);

  const resize = (): { width: number; height: number } => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    return { width, height };
  };
  resize();
  const observer = new ResizeObserver(() => resize());
  observer.observe(container);

  return {
    renderer,
    scene,
    camera,
    resize,
    dispose() {
      observer.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
