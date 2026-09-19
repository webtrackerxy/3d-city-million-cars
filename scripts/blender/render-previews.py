"""Headless Workbench preview renders of a model from standard views (Phase A1/A3).

Usage:
    blender --background <file.blend> --python scripts/blender/render-previews.py -- \
        --out docs/previews/source [--prefix source] [--exclude Cube Plane ...] [--only boot.011 ...]
        [--size 1200 800] [--wire]

Produces <out>/<prefix>_<view>.png for views: front, rear, left, right, top, three-quarter.
"front" looks along +Y (camera at -Y); verify the car's actual forward axis from the images.
Uses the Workbench engine (fast, deterministic, no GPU path tracing) with material colours.
The scene is not saved.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

VIEWS = {
    # name: (direction the camera looks along, ortho?)
    "front": (Vector((0, 1, 0)), True),
    "rear": (Vector((0, -1, 0)), True),
    "left": (Vector((1, 0, 0)), True),
    "right": (Vector((-1, 0, 0)), True),
    "top": (Vector((0, 0, -1)), True),
    "three-quarter": (Vector((0.6, 0.6, -0.45)).normalized(), False),
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--prefix", default="model")
    p.add_argument("--exclude", nargs="*", default=[])
    p.add_argument("--only", nargs="*", default=[])
    p.add_argument("--size", nargs=2, type=int, default=[1200, 800])
    p.add_argument("--wire", action="store_true", help="overlay wireframe")
    p.add_argument("--views", nargs="*", default=list(VIEWS))
    p.add_argument("--glb", default=None, help="start from an empty scene and import this GLB instead of the open file")
    return p.parse_args(argv)


def bbox(objs: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for o in objs:
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    return lo, hi


def main() -> None:
    args = parse_args()
    if args.glb:
        bpy.ops.wm.read_homefile(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.glb))
    scene = bpy.context.scene
    os.makedirs(args.out, exist_ok=True)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if args.only:
        visible = [o for o in meshes if o.name in args.only]
    else:
        visible = [o for o in meshes if o.name not in args.exclude]
    for o in bpy.data.objects:
        o.hide_render = o not in visible
    if not visible:
        raise SystemExit("no visible mesh objects")

    lo, hi = bbox(visible)
    center = (lo + hi) / 2
    size = hi - lo
    radius = size.length / 2

    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = True
    scene.display.shading.show_object_outline = args.wire
    scene.display.shading.show_backface_culling = False
    scene.render.resolution_x, scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.world = scene.world or bpy.data.worlds.new("preview")
    scene.world.color = (0.85, 0.85, 0.85)
    scene.display_settings.display_device = "sRGB"

    cam_data = bpy.data.cameras.new("preview_cam")
    cam = bpy.data.objects.new("preview_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.clip_start = 0.01
    cam_data.clip_end = radius * 20 + 100

    aspect = args.size[0] / args.size[1]
    for view in args.views:
        direction, ortho = VIEWS[view]
        distance = radius * 4
        cam.matrix_world = Matrix.Translation(center - direction * distance) @ direction.to_track_quat(
            "-Z", "Y"
        ).to_matrix().to_4x4()
        if ortho:
            cam_data.type = "ORTHO"
            # extent of the bbox projected onto the camera's right/up axes
            right = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
            up = cam.matrix_world.to_3x3() @ Vector((0, 1, 0))
            w = sum(abs(right[i]) * size[i] for i in range(3))
            h = sum(abs(up[i]) * size[i] for i in range(3))
            cam_data.ortho_scale = max(w, h * aspect) * 1.08
        else:
            cam_data.type = "PERSP"
            cam_data.lens = 50
            fov = cam_data.angle
            distance = radius / math.sin(fov / 2) * 1.05
            cam.matrix_world = Matrix.Translation(center - direction * distance) @ direction.to_track_quat(
                "-Z", "Y"
            ).to_matrix().to_4x4()
        scene.render.filepath = os.path.join(args.out, f"{args.prefix}_{view}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[render-previews] wrote {scene.render.filepath}")

    print(f"[render-previews] bbox min={tuple(round(v, 3) for v in lo)} max={tuple(round(v, 3) for v in hi)} "
          f"size={tuple(round(v, 3) for v in size)} objects={len(visible)}")


if __name__ == "__main__":
    main()
