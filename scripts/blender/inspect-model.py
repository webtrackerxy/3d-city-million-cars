"""Headless Blender inspection of a vehicle source model (Phase A1).

Usage:
    blender --background <file.blend> --python scripts/blender/inspect-model.py -- \
        --out docs/asset-analysis [--name porsche-911]

Writes <out>.md and <out>.json containing scene hierarchy, mesh/triangle/vertex counts,
materials, textures with estimated GPU memory, world-space bounding box and dimensions,
and per-object statistics sorted by triangle count so the LOD cleanup stage knows what
to cut first. Nothing in the source scene is modified or saved.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="output path without extension")
    parser.add_argument("--name", default=os.path.splitext(os.path.basename(bpy.data.filepath))[0])
    parser.add_argument("--top", type=int, default=40, help="objects listed in the per-object table")
    parser.add_argument(
        "--exclude", nargs="*", default=[],
        help="object names treated as scene junk (lamps, ground planes, backdrops); reported separately",
    )
    return parser.parse_args(argv)


def triangle_count(mesh: bpy.types.Mesh) -> int:
    # Works on every Blender version; avoids the deprecated calc_loop_triangles API.
    return sum(len(poly.vertices) - 2 for poly in mesh.polygons)


def evaluated_mesh_stats(obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph) -> tuple[int, int, int]:
    """(triangles, vertices, polygons) with modifiers applied."""
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        return triangle_count(mesh), len(mesh.vertices), len(mesh.polygons)
    finally:
        eval_obj.to_mesh_clear()


def world_bbox(objs: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    for obj in objs:
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    return lo, hi


def material_info(mat: bpy.types.Material) -> dict:
    info = {
        "name": mat.name,
        "users": mat.users,
        "useNodes": mat.node_tree is not None,
        "renderMethod": getattr(mat, "surface_render_method", getattr(mat, "blend_method", None)),
        "nodeTypes": {},
        "imageTextures": [],
        "principled": None,
    }
    if mat.node_tree:
        counts: dict[str, int] = defaultdict(int)
        for node in mat.node_tree.nodes:
            counts[node.bl_idname] += 1
            if node.bl_idname == "ShaderNodeTexImage" and node.image:
                info["imageTextures"].append(node.image.name)
            if node.bl_idname == "ShaderNodeBsdfPrincipled":
                def val(name: str):
                    sock = node.inputs.get(name)
                    if sock is None:
                        return None
                    if sock.is_linked:
                        return "linked"
                    v = sock.default_value
                    return list(v) if hasattr(v, "__len__") else v
                info["principled"] = {
                    k: val(k) for k in ("Base Color", "Metallic", "Roughness", "Alpha", "Transmission Weight", "Emission Strength")
                }
        info["nodeTypes"] = dict(counts)
    return info


def image_info(img: bpy.types.Image) -> dict:
    w, h = img.size
    channels = img.channels or 4
    base_bytes = w * h * channels
    abs_path = bpy.path.abspath(img.filepath) if img.filepath else None
    return {
        "name": img.name,
        "filepath": abs_path,
        "fileExists": bool(abs_path and os.path.exists(abs_path)),
        "packed": img.packed_file is not None,
        "hasData": img.has_data,
        "width": w,
        "height": h,
        "channels": channels,
        "colorspace": img.colorspace_settings.name,
        "users": img.users,
        "gpuBytesNoMip": base_bytes,
        "gpuBytesWithMip": int(base_bytes * 4 / 3),
    }


def excluded_collections() -> set[str]:
    """Names of collections excluded from the active view layer (their objects never render)."""
    out: set[str] = set()

    def walk(lc: bpy.types.LayerCollection, parent_excluded: bool) -> None:
        excluded = parent_excluded or lc.exclude
        if excluded:
            out.add(lc.collection.name)
        for child in lc.children:
            walk(child, excluded)

    walk(bpy.context.view_layer.layer_collection, False)
    return out


def hierarchy(obj: bpy.types.Object, depth: int, lines: list[str]) -> None:
    kind = obj.type
    extra = f" [{obj.data.name}]" if obj.type == "MESH" else ""
    lines.append(f"{'  ' * depth}- {obj.name} ({kind}){extra}")
    for child in sorted(obj.children, key=lambda o: o.name):
        hierarchy(child, depth + 1, lines)


def fmt(n: float) -> str:
    return f"{n:,.0f}" if abs(n) >= 100 else f"{n:,.3f}"


def main() -> None:
    args = parse_args()
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()

    objects = list(bpy.data.objects)
    mesh_objs = [o for o in objects if o.type == "MESH"]
    type_counts: dict[str, int] = defaultdict(int)
    for o in objects:
        type_counts[o.type] += 1
    excluded_colls = excluded_collections()
    in_scene = {o.name for o in scene.objects}
    junk = set(args.exclude)

    def renders(obj: bpy.types.Object) -> bool:
        if obj.name not in in_scene or obj.hide_render:
            return False
        colls = obj.users_collection
        return not colls or any(c.name not in excluded_colls and not c.hide_render for c in colls)

    per_object = []
    total_tris = total_verts = total_polys = 0
    raw_tris = raw_verts = 0
    asset_tris = asset_verts = 0  # renderable and not junk: what the LOD pipeline starts from
    for obj in mesh_objs:
        tris, verts, polys = evaluated_mesh_stats(obj, depsgraph)
        total_tris += tris
        total_verts += verts
        total_polys += polys
        raw_tris += triangle_count(obj.data)
        raw_verts += len(obj.data.vertices)
        is_asset = renders(obj) and obj.name not in junk
        if is_asset:
            asset_tris += tris
            asset_verts += verts
        lo, hi = world_bbox([obj])
        dims = hi - lo
        per_object.append(
            {
                "name": obj.name,
                "mesh": obj.data.name,
                "parent": obj.parent.name if obj.parent else None,
                "triangles": tris,
                "vertices": verts,
                "polygons": polys,
                "materials": [s.material.name if s.material else None for s in obj.material_slots],
                "modifiers": [
                    f"{m.type}({m.levels}/{m.render_levels})" if m.type == "SUBSURF" else m.type
                    for m in obj.modifiers
                ],
                "collections": [c.name for c in obj.users_collection],
                "renders": renders(obj),
                "junk": obj.name in junk,
                "asset": is_asset,
                "location": [round(v, 4) for v in obj.matrix_world.translation],
                "scale": [round(v, 4) for v in obj.matrix_world.to_scale()],
                "rotationEulerDeg": [round(v, 2) for v in map(lambda r: r * 57.29578, obj.matrix_world.to_euler())],
                "dimensions": [round(v, 4) for v in dims],
                "uvLayers": [uv.name for uv in obj.data.uv_layers],
                "hasCustomNormals": bool(getattr(obj.data, "has_custom_normals", False)),
            }
        )
    per_object.sort(key=lambda d: d["triangles"], reverse=True)

    asset_objs = [o for o in mesh_objs if renders(o) and o.name not in junk]
    lo, hi = world_bbox(mesh_objs) if mesh_objs else (Vector(), Vector())
    dims = hi - lo
    alo, ahi = world_bbox(asset_objs) if asset_objs else (Vector(), Vector())
    adims = ahi - alo
    materials = [material_info(m) for m in bpy.data.materials if m.users > 0]
    images = [image_info(i) for i in bpy.data.images if i.users > 0 and i.type == "IMAGE"]
    tex_bytes = sum(i["gpuBytesWithMip"] for i in images)

    unique_meshes = {o.data.name for o in mesh_objs}
    shared_meshes = [m for m in unique_meshes if sum(1 for o in mesh_objs if o.data.name == m) > 1]

    report = {
        "name": args.name,
        "blendFile": bpy.data.filepath,
        "blenderVersion": bpy.app.version_string,
        "units": {"system": scene.unit_settings.system, "scaleLength": scene.unit_settings.scale_length},
        "counts": {
            "objects": len(objects),
            "objectsByType": dict(type_counts),
            "meshObjects": len(mesh_objs),
            "uniqueMeshDatablocks": len(unique_meshes),
            "sharedMeshDatablocks": shared_meshes,
            "trianglesEvaluated": total_tris,
            "verticesEvaluated": total_verts,
            "polygonsEvaluated": total_polys,
            "trianglesRaw": raw_tris,
            "verticesRaw": raw_verts,
            "materials": len(materials),
            "images": len(images),
            "assetObjects": len(asset_objs),
            "assetTriangles": asset_tris,
            "assetVertices": asset_verts,
            "excludedCollections": sorted(excluded_colls),
            "junkObjects": sorted(junk & {o.name for o in objects}),
        },
        "boundingBox": {
            "min": [round(v, 4) for v in lo],
            "max": [round(v, 4) for v in hi],
            "dimensions": [round(v, 4) for v in dims],
            "center": [round(v, 4) for v in (lo + hi) / 2],
        },
        "assetBoundingBox": {
            "min": [round(v, 4) for v in alo],
            "max": [round(v, 4) for v in ahi],
            "dimensions": [round(v, 4) for v in adims],
            "center": [round(v, 4) for v in (alo + ahi) / 2],
        },
        "textureMemory": {"bytesNoMip": sum(i["gpuBytesNoMip"] for i in images), "bytesWithMip": tex_bytes},
        "materials": materials,
        "images": images,
        "objects": per_object,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out + ".json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    lines = [
        f"# Asset Analysis: {args.name}",
        "",
        f"Generated by `scripts/blender/inspect-model.py` with Blender {bpy.app.version_string}.",
        f"Source: `{os.path.relpath(bpy.data.filepath)}`",
        "",
        "## Totals",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| Objects | {len(objects)} |",
        f"| Mesh objects | {len(mesh_objs)} |",
        f"| Unique mesh datablocks | {len(unique_meshes)} |",
        f"| Triangles (modifiers applied) | {total_tris:,} |",
        f"| Vertices (modifiers applied) | {total_verts:,} |",
        f"| Triangles (raw mesh data) | {raw_tris:,} |",
        f"| Vertices (raw mesh data) | {raw_verts:,} |",
        f"| Materials in use | {len(materials)} |",
        f"| Images in use | {len(images)} |",
        f"| Texture GPU memory (RGBA8, with mipmaps) | {tex_bytes / 1e6:,.1f} MB |",
        f"| Unit system | {scene.unit_settings.system}, scale {scene.unit_settings.scale_length} |",
        f"| **Asset objects** (render and not junk) | {len(asset_objs)} |",
        f"| **Asset triangles** | {asset_tris:,} |",
        f"| **Asset vertices** | {asset_verts:,} |",
        "",
        "Junk objects excluded from asset totals: " + (", ".join(sorted(junk)) or "none")
        + ". Collections excluded from the view layer: " + (", ".join(sorted(excluded_colls)) or "none") + ".",
        "",
        "## Bounding box (world space, Blender axes: X right, Y depth, Z up)",
        "",
        "| | X | Y | Z |",
        "| --- | ---: | ---: | ---: |",
        f"| all objects min | {lo.x:.3f} | {lo.y:.3f} | {lo.z:.3f} |",
        f"| all objects max | {hi.x:.3f} | {hi.y:.3f} | {hi.z:.3f} |",
        f"| all objects size | {dims.x:.3f} | {dims.y:.3f} | {dims.z:.3f} |",
        f"| **asset min** | {alo.x:.3f} | {alo.y:.3f} | {alo.z:.3f} |",
        f"| **asset max** | {ahi.x:.3f} | {ahi.y:.3f} | {ahi.z:.3f} |",
        f"| **asset size** | {adims.x:.3f} | {adims.y:.3f} | {adims.z:.3f} |",
        "",
        "Object types: " + ", ".join(f"{k}: {v}" for k, v in sorted(type_counts.items())),
        "",
        "## Materials",
        "",
        "| Material | Users | Render method | Image textures | Base colour | Metal | Rough | Alpha | Transmission |",
        "| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for m in materials:
        p = m["principled"] or {}
        def cell(k: str) -> str:
            v = p.get(k)
            if v is None:
                return "-"
            if isinstance(v, list):
                return "(" + ", ".join(f"{c:.2f}" for c in v[:3]) + ")"
            return str(v) if isinstance(v, str) else f"{v:.2f}"
        lines.append(
            f"| {m['name']} | {m['users']} | {m['renderMethod']} | {', '.join(m['imageTextures']) or '-'} | "
            f"{cell('Base Color')} | {cell('Metallic')} | {cell('Roughness')} | {cell('Alpha')} | {cell('Transmission Weight')} |"
        )
    lines += [
        "",
        "## Images",
        "",
        "| Image | Size | Channels | Colorspace | File | Packed | Users | GPU MB (mip) |",
        "| --- | ---: | ---: | --- | --- | --- | ---: | ---: |",
    ]
    for i in sorted(images, key=lambda d: d["gpuBytesWithMip"], reverse=True):
        status = "packed" if i["packed"] else ("found" if i["fileExists"] else "MISSING")
        lines.append(
            f"| {i['name']} | {i['width']}×{i['height']} | {i['channels']} | {i['colorspace']} | {status} | "
            f"{'yes' if i['packed'] else 'no'} | {i['users']} | {i['gpuBytesWithMip'] / 1e6:.1f} |"
        )
    lines += [
        "",
        f"## Objects by triangle count (top {min(args.top, len(per_object))} of {len(per_object)})",
        "",
        "Percentages are of the asset total. Status: asset = counted; junk = excluded by `--exclude`;"
        " hidden = not rendered in the source scene.",
        "",
        "| Object | Status | Triangles | Vertices | % of asset | Materials | Modifiers | Dimensions |",
        "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
    ]
    for o in per_object[: args.top]:
        pct = 100 * o["triangles"] / asset_tris if asset_tris and o["asset"] else 0
        status = "asset" if o["asset"] else ("junk" if o["junk"] else "hidden")
        lines.append(
            f"| {o['name']} | {status} | {o['triangles']:,} | {o['vertices']:,} | {pct:.1f}% | "
            f"{', '.join(str(m) for m in o['materials']) or '-'} | {', '.join(o['modifiers']) or '-'} | "
            f"{'×'.join(f'{d:.2f}' for d in o['dimensions'])} |"
        )
    lines += ["", "## Hierarchy", "", "```text"]
    for root in sorted((o for o in objects if o.parent is None), key=lambda o: o.name):
        hierarchy(root, 0, lines)
    lines += ["```", ""]

    with open(args.out + ".md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"[inspect-model] {total_tris:,} triangles, {total_verts:,} vertices, {len(mesh_objs)} mesh objects, "
          f"{len(materials)} materials, {len(images)} images -> {args.out}.md/.json")


if __name__ == "__main__":
    main()
