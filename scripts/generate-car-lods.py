"""Generate vehicle LOD GLBs from the high-detail Blender source (Phases A2/A3).

Usage (from the project root):
    blender --background --python scripts/generate-car-lods.py -- \
        --config scripts/lod-config.json [--lods 0 1 2 3] [--out assets/generated/porsche]

For every LOD in the config the script reloads the source file, so each LOD is derived
from the untouched master, then:

    1. deletes scene junk                      6. remaps materials to the canonical set
    2. adjusts Subdivision Surface levels      7. runs the configured decimate sequence
    3. bakes all modifiers into mesh data      8. welds coincident vertices
    4. normalises scale/origin (see docs/coordinates.md)
    5. builds procedural wheels, drops/keeps objects
                                               9. joins into one object, smooths by angle
                                              10. exports a GLB and records stats in manifest.json

The source file is never saved. Everything is driven by the config; nothing vehicle
specific is hard-coded here.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import math
import os
import sys
import time
from typing import Any

import bmesh
import bpy
from mathutils import Matrix, Vector

GENERATED_TAG = "lodgen_generated"   # created by this script: survives keep/drop filters
NO_DECIMATE_TAG = "lodgen_nodecimate"  # already minimal (procedural wheels): skip decimate/weld


# --------------------------------------------------------------------------- helpers


def log(msg: str) -> None:
    print(f"[generate-car-lods] {msg}", flush=True)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--config", required=True)
    p.add_argument("--out", default=None, help="override the config's output directory")
    p.add_argument("--lods", nargs="*", type=int, default=None, help="subset of LOD ids to build")
    return p.parse_args(argv)


def project_root(config_path: str) -> str:
    # config lives in <root>/scripts/
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(config_path)), ".."))


def mesh_objects() -> list[bpy.types.Object]:
    return [o for o in bpy.data.objects if o.type == "MESH"]


def match_any(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(name, p) for p in patterns)


def tri_count(mesh: bpy.types.Mesh) -> int:
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def bake_modifiers(obj: bpy.types.Object) -> None:
    """Replace obj.data with the evaluated mesh (all modifiers applied) and clear the stack."""
    if not obj.modifiers:
        return
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(dg)
    new_mesh = bpy.data.meshes.new_from_object(eval_obj, preserve_all_data_layers=True, depsgraph=dg)
    new_mesh.name = obj.data.name + "_baked"
    old = obj.data
    obj.modifiers.clear()
    obj.data = new_mesh
    if old.users == 0:
        bpy.data.meshes.remove(old)


def delete_objects(objs: list[bpy.types.Object]) -> None:
    for o in objs:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)


def world_bbox(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for c in obj.bound_box:
        p = obj.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, p))
        hi = Vector(map(max, hi, p))
    return lo, hi


def override(objs: list[bpy.types.Object], active: bpy.types.Object):
    return bpy.context.temp_override(
        active_object=active,
        object=active,
        selected_objects=objs,
        selected_editable_objects=objs,
    )


# --------------------------------------------------------------------------- materials


def ensure_material(name: str, spec: dict[str, Any]) -> bpy.types.Material:
    mat = bpy.data.materials.get(f"lod_{name}")
    if mat is None:
        mat = bpy.data.materials.new(f"lod_{name}")
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeOutputMaterial"), None)
        if out is None:
            out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    r, g, b = spec.get("color", [0.8, 0.8, 0.8])
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Metallic"].default_value = float(spec.get("metallic", 0.0))
    bsdf.inputs["Roughness"].default_value = float(spec.get("roughness", 0.5))
    emission = float(spec.get("emission", 0.0))
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = emission
        if emission > 0 and "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (r, g, b, 1.0)
    mat.diffuse_color = (r, g, b, 1.0)
    mat.metallic = float(spec.get("metallic", 0.0))
    mat.roughness = float(spec.get("roughness", 0.5))
    # Export names without the internal prefix.
    mat["exportName"] = name
    return mat


def remap_materials(objs: list[bpy.types.Object], global_map: dict[str, str], lod_map: dict[str, str],
                    specs: dict[str, dict[str, Any]]) -> None:
    def canonical(src_name: str) -> str:
        if src_name.startswith("lod_"):  # already canonical (e.g. procedural wheels)
            src_name = src_name[len("lod_"):]
        name = global_map.get(src_name, src_name)
        name = lod_map.get(name, name)
        # allow chains (a -> b -> c) but stop at a fixed point
        seen = set()
        while name in lod_map and lod_map[name] != name and name not in seen:
            seen.add(name)
            name = lod_map[name]
        return name

    for obj in objs:
        for slot in obj.material_slots:
            src = slot.material.name if slot.material else "dark"
            target = canonical(src)
            if target not in specs:
                raise SystemExit(f"material {src!r} maps to {target!r}, which has no spec in config.materials")
            slot.material = ensure_material(target, specs[target])


def finalize_material_names() -> None:
    """Strip the lod_ prefix right before export so GLB material names are canonical."""
    for mat in bpy.data.materials:
        export_name = mat.get("exportName")
        if export_name:
            clash = bpy.data.materials.get(export_name)
            if clash is not None and clash is not mat:
                clash.name = export_name + "_src"
            mat.name = export_name


# --------------------------------------------------------------------------- pipeline steps


def adjust_subsurf(objs: list[bpy.types.Object], rule: dict[str, Any]) -> None:
    delta = int(rule.get("delta", 0))
    lo = rule.get("min")
    hi = rule.get("max")
    for obj in objs:
        for mod in obj.modifiers:
            if mod.type != "SUBSURF":
                continue
            level = mod.levels + delta
            if lo is not None:
                level = max(level, int(lo))
            if hi is not None:
                level = min(level, int(hi))
            mod.levels = max(0, level)
            mod.render_levels = mod.levels


def normalize(objs: list[bpy.types.Object], rule: dict[str, Any]) -> None:
    s = float(rule["scale"])
    t = Vector(rule.get("translate", [0, 0, 0]))
    xform = Matrix.Scale(s, 4) @ Matrix.Translation(t)
    for obj in objs:
        obj.data.transform(xform @ obj.matrix_world)
        obj.matrix_world = Matrix.Identity(4)
    bpy.context.view_layer.update()


def build_wheels(rule: dict[str, Any], specs: dict[str, dict[str, Any]]) -> list[bpy.types.Object]:
    """Replace the source wheel objects by cylinders measured from their bounding boxes."""
    sources = [bpy.data.objects[n] for n in rule["sourceObjects"] if n in bpy.data.objects]
    if not sources:
        raise SystemExit("proceduralWheels: no source objects found")
    segments = int(rule.get("segments", 24))
    width = float(rule.get("width", 0.28))
    tyre = ensure_material(rule.get("material", "rubber"), specs[rule.get("material", "rubber")])
    cap_name = rule.get("capMaterial")
    cap = ensure_material(cap_name, specs[cap_name]) if cap_name else None

    created: list[bpy.types.Object] = []
    for src in sources:
        lo, hi = world_bbox(src)
        radius = (hi.z - lo.z) / 2
        cz = (hi.z + lo.z) / 2
        cy = (hi.y + lo.y) / 2
        outer = max(abs(lo.x), abs(hi.x))
        for side, sign in (("L", 1.0), ("R", -1.0)):
            cx = sign * (outer - width / 2)
            bm = bmesh.new()
            rot = Matrix.Rotation(math.radians(90), 4, "Y")  # cylinder axis Z -> X
            bmesh.ops.create_cone(
                bm, cap_ends=True, cap_tris=False, segments=segments,
                radius1=radius, radius2=radius, depth=width,
                matrix=Matrix.Translation((cx, cy, cz)) @ rot,
            )
            mesh = bpy.data.meshes.new(f"wheel_{src.name}_{side}")
            bm.to_mesh(mesh)
            bm.free()
            mesh.materials.append(tyre)
            if cap is not None:
                mesh.materials.append(cap)
                for poly in mesh.polygons:
                    if len(poly.vertices) > 4:  # the two n-gon caps
                        poly.material_index = 1
            for poly in mesh.polygons:
                poly.use_smooth = len(poly.vertices) <= 4
            obj = bpy.data.objects.new(mesh.name, mesh)
            obj[GENERATED_TAG] = True
            obj[NO_DECIMATE_TAG] = True
            bpy.context.scene.collection.objects.link(obj)
            created.append(obj)
        log(f"wheels from {src.name}: radius {radius:.3f} m, axle y {cy:.3f}, outer x {outer:.3f}")
    delete_objects(sources)
    return created


def extract_material_faces(rule: dict[str, Any]) -> bpy.types.Object | None:
    """Copy all faces using a given source material out of the matching objects into a new object.

    Used to keep e.g. side windows when the panels that carry them are dropped at lower LODs.
    Objects must already be baked and normalised (identity transforms).
    """
    material = rule["material"]
    name = rule.get("name", f"extract_{material}")
    bm_all = bmesh.new()
    faces = 0
    for src in mesh_objects():
        if not match_any(src.name, rule["from"]) or src.get(GENERATED_TAG):
            continue
        indices = {i for i, m in enumerate(src.data.materials) if m is not None and m.name == material}
        if not indices:
            continue
        bm = bmesh.new()
        bm.from_mesh(src.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index not in indices], context="FACES")
        for f in bm.faces:
            f.material_index = 0
        faces += len(bm.faces)
        tmp = bpy.data.meshes.new("lodgen_tmp")
        bm.to_mesh(tmp)
        bm.free()
        bm_all.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    if faces == 0:
        log(f"extract {name}: no faces with material {material!r} found")
        bm_all.free()
        return None
    mesh = bpy.data.meshes.new(name)
    bm_all.to_mesh(mesh)
    bm_all.free()
    mesh.materials.append(bpy.data.materials[material])
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    obj[GENERATED_TAG] = True
    bpy.context.scene.collection.objects.link(obj)
    log(f"extract {name}: {faces:,} faces of {material!r} from {rule['from']}")
    return obj


def decimate(obj: bpy.types.Object, step: dict[str, Any]) -> None:
    current = tri_count(obj.data)
    kind = step.get("type", "COLLAPSE").upper()
    mod = obj.modifiers.new("lod_decimate", "DECIMATE")
    if kind == "COLLAPSE":
        target = step.get("targetTriangles")
        ratio = float(step["ratio"]) if "ratio" in step else (target / current if current else 1.0)
        if ratio >= 1.0:
            obj.modifiers.remove(mod)
            return
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        if step.get("symmetry"):
            mod.use_symmetry = True
            mod.symmetry_axis = "X"
    elif kind == "PLANAR":
        mod.decimate_type = "DISSOLVE"
        mod.angle_limit = math.radians(float(step.get("angle", 5.0)))
        mod.use_dissolve_boundaries = bool(step.get("dissolveBoundaries", False))
        mod.delimit = set(step.get("delimit", ["NORMAL"]))
    elif kind == "UNSUBDIV":
        mod.decimate_type = "UNSUBDIV"
        mod.iterations = int(step.get("iterations", 2))
    else:
        raise SystemExit(f"unknown decimate type {kind!r}")
    bake_modifiers(obj)
    log(f"  decimate {kind:<8} {obj.name:<20} {current:>8,} -> {tri_count(obj.data):>8,} tris")


def weld(obj: bpy.types.Object, threshold: float) -> None:
    before = len(obj.data.vertices)
    mod = obj.modifiers.new("lod_weld", "WELD")
    mod.merge_threshold = threshold
    mod.mode = "ALL"
    bake_modifiers(obj)
    log(f"  weld {obj.name:<20} {before:>8,} -> {len(obj.data.vertices):>8,} verts")


def join(objs: list[bpy.types.Object], name: str) -> bpy.types.Object:
    target = objs[0]
    if len(objs) > 1:
        with override(objs, target):
            bpy.ops.object.join()
    target.name = name
    target.data.name = name
    with override([target], target):
        bpy.ops.object.material_slot_remove_unused()
    return target


def smooth_by_angle(obj: bpy.types.Object, degrees: float) -> None:
    for poly in obj.data.polygons:
        poly.use_smooth = True
    try:
        with override([obj], obj):
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(degrees))
    except Exception as ex:  # older/newer API: fall back to plain smooth
        log(f"  shade_smooth_by_angle unavailable ({ex.__class__.__name__}); using plain smooth")


def export_glb(obj: bpy.types.Object, path: str, export_uvs: bool) -> None:
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    wanted: dict[str, Any] = {
        "filepath": path,
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_yup": True,
        "export_normals": True,
        "export_tangents": False,
        "export_texcoords": export_uvs,
        "export_materials": "EXPORT",
        "export_image_format": "NONE",
        "export_animations": False,
        "export_skins": False,
        "export_morph": False,
        "export_lights": False,
        "export_cameras": False,
        "export_extras": False,
        "export_attributes": False,
        "export_draco_mesh_compression_enable": False,
        "export_vertex_color": "NONE",
    }
    kwargs = {k: v for k, v in wanted.items() if k in props}
    for o in bpy.data.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    with override([obj], obj):
        bpy.ops.export_scene.gltf(**kwargs)


# --------------------------------------------------------------------------- per-LOD build


def build_lod(cfg: dict[str, Any], lod: dict[str, Any], root: str, out_dir: str) -> dict[str, Any]:
    t0 = time.time()
    lod_id = int(lod["id"])
    name = lod.get("name", f"car_lod{lod_id}")
    log(f"=== LOD{lod_id}: {lod.get('description', '')}")

    bpy.ops.wm.open_mainfile(filepath=os.path.join(root, cfg["source"]), load_ui=False)

    # 1. junk
    delete_objects([o for o in bpy.data.objects if match_any(o.name, cfg.get("junk", []))])
    delete_objects([o for o in bpy.data.objects if o.type != "MESH"])

    # 2–4. subsurf, bake, normalise
    objs = mesh_objects()
    if "subsurf" in lod:
        adjust_subsurf(objs, lod["subsurf"])
    for o in objs:
        bake_modifiers(o)
    normalize(objs, cfg["normalize"])
    log(f"baked + normalised {len(objs)} objects, {sum(tri_count(o.data) for o in objs):,} tris")

    # 5. extractions and procedural wheels (before keep/drop removes their sources), then keep/drop
    specs = cfg["materials"]
    for rule in lod.get("extract", []):
        extract_material_faces(rule)
    if "proceduralWheels" in lod:
        build_wheels(lod["proceduralWheels"], specs)
    keep = lod.get("keep")
    drop = lod.get("drop", [])
    doomed = []
    for o in mesh_objects():
        if o.get(GENERATED_TAG):
            continue
        if keep is not None and not match_any(o.name, keep):
            doomed.append(o)
        elif match_any(o.name, drop):
            doomed.append(o)
    delete_objects(doomed)
    objs = mesh_objects()
    log(f"kept {len(objs)} objects: {', '.join(sorted(o.name for o in objs))}")

    # 6. materials
    remap_materials(objs, cfg.get("materialMap", {}), lod.get("materialMap", {}), specs)

    # 7. decimate sequence
    for step in lod.get("decimate", []):
        for o in objs:
            if match_any(o.name, step["objects"]) and not o.get(NO_DECIMATE_TAG):
                decimate(o, step)

    # 8. weld
    if lod.get("weld"):
        for o in objs:
            if not o.get(NO_DECIMATE_TAG):
                weld(o, float(lod["weld"]))

    # 9. join + smooth
    car = join(objs, name)
    smooth_by_angle(car, float(lod.get("smoothAngle", 35.0)))
    bpy.context.view_layer.update()

    # 10. export + stats
    finalize_material_names()
    path = os.path.join(out_dir, lod["file"])
    export_glb(car, path, bool(lod.get("exportUVs", False)))
    lo, hi = world_bbox(car)
    tris = tri_count(car.data)
    stats = {
        "id": lod_id,
        "file": lod["file"],
        "description": lod.get("description", ""),
        "triangles": tris,
        "vertices": len(car.data.vertices),
        "materials": [s.material.name for s in car.material_slots if s.material],
        "bytes": os.path.getsize(path),
        "boundingBox": {"min": [round(v, 4) for v in lo], "max": [round(v, 4) for v in hi]},
        "targetTriangles": lod.get("targetTriangles"),
        "withinTarget": (
            lod["targetTriangles"][0] <= tris <= lod["targetTriangles"][1] if lod.get("targetTriangles") else None
        ),
        "buildSeconds": round(time.time() - t0, 1),
    }
    log(f"LOD{lod_id}: {tris:,} tris, {stats['vertices']:,} verts, {len(stats['materials'])} materials, "
        f"{stats['bytes'] / 1e6:.2f} MB -> {path}  ({stats['buildSeconds']} s)")
    return stats


def main() -> None:
    args = parse_args()
    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    root = project_root(args.config)
    out_dir = os.path.join(root, args.out or cfg["output"])
    os.makedirs(out_dir, exist_ok=True)

    manifest_path = os.path.join(out_dir, "manifest.json")
    manifest: dict[str, Any] = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    existing = {int(l["id"]): l for l in manifest.get("lods", [])}

    wanted = set(args.lods) if args.lods is not None else None
    for lod in cfg["lods"]:
        if wanted is not None and int(lod["id"]) not in wanted:
            continue
        existing[int(lod["id"])] = build_lod(cfg, lod, root, out_dir)

    manifest.update(
        {
            "vehicle": cfg["vehicle"],
            "source": {"file": cfg["source"], "triangles": cfg.get("sourceTriangles")},
            "convention": {
                "units": "metres", "up": "+Y", "forward": "+Z", "origin": "ground, wheelbase midpoint",
                "reference": "docs/coordinates.md",
            },
            "normalize": cfg["normalize"],
            "generator": {"script": "scripts/generate-car-lods.py", "config": os.path.relpath(args.config, root),
                          "blender": bpy.app.version_string},
            "lods": [existing[k] for k in sorted(existing)],
        }
    )
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    log(f"manifest -> {manifest_path}")


if __name__ == "__main__":
    main()
