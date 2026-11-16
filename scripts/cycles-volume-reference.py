"""Render a Crucible grid volume in Blender Cycles with Principled Volume, as the reference for Glaze (the rasterizer) and Cook (the path tracer).

    blender -b --factory-startup --python scripts/cycles-volume-reference.py -- spec.json out/name

Writes out/name.exr (linear, scene referred), out/name.png (Standard view transform, 8 bit) and out/name.json (the spec, Blender version, samples,
device and the render seconds). Make the VDB files with scripts/grid-to-vdb.py (also run in Blender). scripts/compare-volume-render.mjs scores a
candidate PNG against the reference PNG. Relative paths in the spec resolve from the spec file's folder.

Spec (JSON). The same file is meant to drive Glaze and Cook renders of the same scene, so every length is in Crucible units and y is up:

    {
      "vdb": ["frames/blast_0000.vdb", "frames/blast_0001.vdb"],   one path or a list, one VDB per frame
      "frame": 0,                                                  index into the list (default 0)
      "volume": {                                                  the fields of a Crucible local volume with shape "grid"
        "center": [0, 2.2, 0],                                     required; the box centre
        "size": [4, 3, 4],                                         optional; the box size, default the grid's own `size`
        "density": 4,                                              Density scale (default 1); extinction = grid density * density * absorption
        "absorption": [1, 1, 1],                                   default white
        "emission": [1, 0.45, 0.12], "emissionStrength": 14,       light per unit length times the flame channel (the density when there is none)
        "temperatureScale": 1000, "blackbodyIntensity": 0.3,       kelvin per temperature unit; 0 ignores the temperature channel
        "interpolation": "LINEAR",                                 the material's Volume Interpolation: LINEAR (Cycles' default, Cycles samples stochastically) or CUBIC
        "scatter": 0, "anisotropy": 0                              scatter above 0 sets Principled Volume's Color, so the sun lights the smoke
      },
      "camera": { "eye": [6, 3, 8], "target": [0, 2, 0], "up": [0, 1, 0], "fov": 40 },   fov: vertical, in degrees
      "sun": { "direction": [-1, 4, 1], "strength": 3, "color": [1, 1, 1] },             direction points TOWARD the sun (Crucible's lightDirection);
                                                                                          strength * color is the irradiance (Crucible's keyColor * keyIntensity); omit for no sun
      "floor": { "y": 0, "color": [0.4, 0.35, 0.3] },              a diffuse plane, or omit
      "background": [0.02, 0.03, 0.05],                            linear world colour, default black
      "image": { "width": 960, "height": 540, "samples": 256, "device": "CPU" }   device CPU (default) or GPU; no denoising, so noise is comparable
    }

How the shading maps (measured with a probe cube in Blender 5.3):
- Crucible's world is y up, Blender's z up: (x, y, z) becomes (x, -z, y), a rotation with no mirroring. The camera, sun and box go through it.
- Density: Principled Volume multiplies its Density input by the density attribute, so Density = volume.density. Colour is black (no scattering unless
  `scatter` is above 0). Absorption: Principled Volume's Absorption Color c gives extinction density * (1 - sqrt(c)), so the colour is (1 - a)^2 for
  Crucible's absorption a.
- Flame: an Attribute node reads `flame` (or `density` without a flame channel) times emissionStrength into Emission Strength, colour `emission`.
  Principled Volume's emission is per unit length and not scaled by density, which is how Crucible emits too.
- Temperature: Temperature = temperatureScale (multiplies the temperature attribute) and Blackbody Intensity = blackbodyIntensity * emissionStrength.
  Cycles' blackbody is a physical, normalised colour; Crucible's is Tanner Helland's fit with a (kelvin / 1500)^4 gain (BLACKBODY_REFERENCE_KELVIN), so
  a grid with a temperature channel will not match in brightness: that gap is part of what the reference measures.
"""
import json
import math
import sys
import time
from pathlib import Path

import bpy
import mathutils
import openvdb

IMAGE_DEFAULTS = {"width": 960, "height": 540, "samples": 256, "device": "CPU"}
SENSOR_HEIGHT_MILLIMETRES = 24.0


def to_blender(vector):
    """Crucible (x, y up, z) to Blender (x, y, z up) without mirroring."""
    return mathutils.Vector((vector[0], -vector[2], vector[1]))


def resolve(spec_directory, path):
    candidate = Path(path)
    return candidate if candidate.is_absolute() else (spec_directory / candidate).resolve()


def look_matrix(location, forward, up_hint):
    """A camera matrix: looks along `forward`, the image's up as near `up_hint` as possible (Blender cameras look down -Z with +Y up)."""
    forward = forward.normalized()
    right = forward.cross(up_hint).normalized()
    up = right.cross(forward)
    rotation = mathutils.Matrix([[right[row], up[row], -forward[row]] for row in range(3)])
    return mathutils.Matrix.Translation(location) @ rotation.to_4x4()


def reset_scene(image):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = image["samples"]
    scene.cycles.use_denoising = False
    scene.cycles.volume_step_rate = 1.0
    scene.cycles.volume_max_steps = 1024
    scene.render.resolution_x = image["width"]
    scene.render.resolution_y = image["height"]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    if image["device"] == "GPU":
        preferences = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("OPTIX", "CUDA", "HIP", "METAL"):
            try:
                preferences.compute_device_type = backend
                preferences.get_devices()
                if any(device.type == backend for device in preferences.devices):
                    for device in preferences.devices:
                        device.use = device.type == backend
                    scene.cycles.device = "GPU"
                    break
            except TypeError:
                continue
    return scene


def build_world(scene, background):
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    node = world.node_tree.nodes["Background"]
    node.inputs["Color"].default_value = (*background, 1.0)
    node.inputs["Strength"].default_value = 1.0
    scene.world = world


def build_camera(scene, camera):
    data = bpy.data.cameras.new("Camera")
    data.sensor_fit = "VERTICAL"
    data.sensor_height = SENSOR_HEIGHT_MILLIMETRES
    data.lens = (SENSOR_HEIGHT_MILLIMETRES / 2) / math.tan(math.radians(camera["fov"]) / 2)
    data.clip_start = camera.get("near", 0.01)
    data.clip_end = camera.get("far", 1000.0)
    eye = to_blender(camera["eye"])
    target = to_blender(camera["target"])
    up = to_blender(camera.get("up", [0, 1, 0]))
    camera_object = bpy.data.objects.new("Camera", data)
    camera_object.matrix_world = look_matrix(eye, target - eye, up)
    scene.collection.objects.link(camera_object)
    scene.camera = camera_object


def build_sun(scene, sun):
    color = sun.get("color", [1, 1, 1])
    irradiance = [sun.get("strength", 1.0) * channel for channel in color]
    peak = max(irradiance)
    if peak <= 0:
        return
    light = bpy.data.lights.new("Sun", "SUN")
    light.energy = peak  # sun strength equals irradiance (bench/reference/render-blender.py)
    light.color = [channel / peak for channel in irradiance]
    light.angle = math.radians(0.53)
    sun_object = bpy.data.objects.new("Sun", light)
    toward_sun = to_blender(sun["direction"]).normalized()
    sun_object.rotation_mode = "QUATERNION"
    sun_object.rotation_quaternion = toward_sun.to_track_quat("Z", "Y")  # a sun shines along its local -Z
    scene.collection.objects.link(sun_object)


def build_floor(scene, floor):
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, floor.get("y", 0)))
    plane = bpy.context.active_object
    material = bpy.data.materials.new("Floor")
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*floor.get("color", [0.5, 0.5, 0.5]), 1.0)
    shader.inputs["Roughness"].default_value = 1.0
    plane.data.materials.append(material)


def grid_names(vdb_path):
    grids, _ = openvdb.readAll(str(vdb_path))
    return [grid.name for grid in grids]


def stored_size(vdb_path):
    """The size grid-to-vdb.py stored, in Crucible units (the VDB itself is centred on the origin)."""
    grid = openvdb.read(str(vdb_path), "density")
    return [float(extent) for extent in grid["crucible_size"].split()]


def build_volume(scene, vdb_path, volume):
    names = grid_names(vdb_path)
    if "density" not in names:
        raise SystemExit(f"{vdb_path} has no density grid; it holds {names}. Make it with scripts/grid-to-vdb.py")
    data = bpy.data.volumes.new("Grid")
    data.filepath = str(vdb_path)
    data.grids.load()
    box = bpy.data.objects.new("Grid volume", data)
    size = volume.get("size") or stored_size(vdb_path)
    native = stored_size(vdb_path)
    # Blender axes: x, y = Crucible z, z = Crucible y.
    box.scale = (size[0] / native[0], size[2] / native[2], size[1] / native[1])
    box.location = to_blender(volume["center"])
    scene.collection.objects.link(box)

    material = bpy.data.materials.new("Grid volume")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    principled = tree.nodes.new("ShaderNodeVolumePrincipled")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(principled.outputs["Volume"], output.inputs["Volume"])
    absorption = volume.get("absorption", [1, 1, 1])
    scatter = volume.get("scatter", 0)
    principled.inputs["Density"].default_value = volume.get("density", 1)
    principled.inputs["Color"].default_value = (scatter, scatter, scatter, 1.0)
    principled.inputs["Absorption Color"].default_value = (*[(1 - min(max(channel, 0), 1)) ** 2 for channel in absorption], 1.0)
    principled.inputs["Anisotropy"].default_value = volume.get("anisotropy", 0)

    strength = volume.get("emissionStrength", 1)
    emission = volume.get("emission", [0, 0, 0])
    if max(emission) > 0 and strength > 0:
        source = "flame" if "flame" in names else "density"
        attribute = tree.nodes.new("ShaderNodeAttribute")
        attribute.attribute_name = source
        scaled = tree.nodes.new("ShaderNodeMath")
        scaled.operation = "MULTIPLY"
        scaled.inputs[1].default_value = strength
        tree.links.new(attribute.outputs["Fac"], scaled.inputs[0])
        tree.links.new(scaled.outputs["Value"], principled.inputs["Emission Strength"])
        principled.inputs["Emission Color"].default_value = (*emission, 1.0)
    if volume.get("blackbodyIntensity", 0) > 0 and "temperature" in names:
        principled.inputs["Temperature"].default_value = volume.get("temperatureScale", 1)
        principled.inputs["Blackbody Intensity"].default_value = volume["blackbodyIntensity"] * strength
        principled.inputs["Blackbody Tint"].default_value = (1, 1, 1, 1)
    interpolation = volume.get("interpolation", "LINEAR")
    if interpolation not in ("LINEAR", "CUBIC", "CLOSEST"):
        raise SystemExit(f"volume.interpolation is {interpolation!r}; use LINEAR (Cycles' default), CUBIC or CLOSEST")
    material.cycles.volume_interpolation = interpolation
    data.materials.append(material)


def read_spec(path):
    spec = json.loads(Path(path).read_text(encoding="utf-8"))
    for field in ("vdb", "volume", "camera"):
        if field not in spec:
            raise SystemExit(f"the spec has no `{field}`; see the top of scripts/cycles-volume-reference.py")
    if "center" not in spec["volume"]:
        raise SystemExit("volume.center is required (the box centre in Crucible units)")
    for field in ("eye", "target", "fov"):
        if field not in spec["camera"]:
            raise SystemExit(f"camera.{field} is required")
    return spec


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(arguments) != 2:
        raise SystemExit("usage: blender -b --factory-startup --python scripts/cycles-volume-reference.py -- spec.json out/name")
    spec_path, output_prefix = Path(arguments[0]).resolve(), Path(arguments[1])
    spec = read_spec(spec_path)
    image = {**IMAGE_DEFAULTS, **spec.get("image", {})}
    vdb_list = spec["vdb"] if isinstance(spec["vdb"], list) else [spec["vdb"]]
    frame = spec.get("frame", 0)
    if not 0 <= frame < len(vdb_list):
        raise SystemExit(f"frame {frame} is outside the {len(vdb_list)} VDB files of the spec")

    scene = reset_scene(image)
    build_world(scene, spec.get("background", [0, 0, 0]))
    build_camera(scene, spec["camera"])
    if "sun" in spec:
        build_sun(scene, spec["sun"])
    if "floor" in spec:
        build_floor(scene, spec["floor"])
    build_volume(scene, resolve(spec_path.parent, vdb_list[frame]), spec["volume"])

    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    bpy.ops.render.render()
    seconds = time.perf_counter() - started
    result = bpy.data.images["Render Result"]
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    result.save_render(str(output_prefix.with_suffix(".exr")), scene=scene)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.color_mode = "RGB"
    result.save_render(str(output_prefix.with_suffix(".png")), scene=scene)

    sidecar = {
        "spec": spec,
        "blender": bpy.app.version_string,
        "samples": image["samples"],
        "device": scene.cycles.device,
        "resolution": [image["width"], image["height"]],
        "render_seconds": round(seconds, 3),
        "vdb": str(resolve(spec_path.parent, vdb_list[frame])),
    }
    output_prefix.with_suffix(".json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    print(f"CYCLES_REFERENCE {output_prefix}: {image['width']}x{image['height']} at {image['samples']} samples on {scene.cycles.device} in {seconds:.2f} s")


main()
