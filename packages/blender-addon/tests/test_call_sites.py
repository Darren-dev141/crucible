"""Drives the engine and scene_export call sites with a faked bpy and mathutils, so no Blender is needed."""
import math
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

FAKE_MODULE_NAMES = ("bpy", "mathutils", "cook_blender.engine", "cook_blender.scene_export")
REAL_MODULES = {}


class Vector:
    def __init__(self, values):
        self.values = tuple(float(value) for value in values)

    @property
    def z(self):
        return self.values[2]

    def __iter__(self):
        return iter(self.values)

    def __getitem__(self, index):
        return self.values[index]

    def __add__(self, other):
        return Vector(a + b for a, b in zip(self.values, other.values))

    def __sub__(self, other):
        return Vector(a - b for a, b in zip(self.values, other.values))

    def __mul__(self, factor):
        return Vector(a * factor for a in self.values)

    def dot(self, other):
        return sum(a * b for a, b in zip(self.values, other.values))

    def copy(self):
        return Vector(self.values)

    def normalized(self):
        length = math.sqrt(self.dot(self))
        return Vector(a / length for a in self.values) if length > 0.0 else Vector(self.values)


class IdentityMatrix:
    def __init__(self, translation=(0.0, 0.0, 0.0)):
        self.translation = Vector(translation)

    def to_3x3(self):
        return self

    def __matmul__(self, vector):
        return vector

    def __iter__(self):
        return iter([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])


class FakeBase:
    def __init__(self):
        self.errors = []
        self.stats = []

    def report(self, kinds, message):
        pass

    def update_stats(self, *arguments):
        pass

    def error_set(self, message):
        self.errors.append(message)

    def test_break(self):
        return False


def install_fakes():
    fake_types = types.SimpleNamespace(
        PropertyGroup=object, AddonPreferences=object, RenderEngine=FakeBase, Panel=object, Object=type("Object", (), {}), Collection=type("Collection", (), {}),
    )
    fake_bpy = types.ModuleType("bpy")
    fake_bpy.types = fake_types
    fake_bpy.props = mock.MagicMock()
    fake_bpy.utils = mock.MagicMock()
    fake_bpy.path = types.SimpleNamespace(abspath=lambda path: "ABSOLUTE:" + path)
    fake_bpy.context = mock.MagicMock()
    fake_mathutils = types.ModuleType("mathutils")
    fake_mathutils.Matrix = IdentityMatrix
    fake_mathutils.Vector = Vector
    for name in FAKE_MODULE_NAMES:
        REAL_MODULES[name] = sys.modules.pop(name, None)
    sys.modules["bpy"] = fake_bpy
    sys.modules["mathutils"] = fake_mathutils


def setUpModule():
    install_fakes()


def tearDownModule():
    for name in FAKE_MODULE_NAMES:
        sys.modules.pop(name, None)
        if REAL_MODULES.get(name) is not None:
            sys.modules[name] = REAL_MODULES[name]


def fake_depsgraph(environment_cap=0.0):
    scene = mock.MagicMock()
    scene.render.resolution_x = 8
    scene.render.resolution_y = 8
    scene.render.resolution_percentage = 100
    scene.cook.environment_cap = environment_cap
    scene.cook.samples = 1
    scene.cook.max_bounces = 1
    scene.cook.seed = 0
    scene.cook.pixel_filter = "box"
    scene.cook.filter_width = 1.0
    return mock.Mock(scene=scene)


class EngineCallSiteTests(unittest.TestCase):
    def setUp(self):
        from cook_blender import engine
        self.engine = engine
        self.render_engine = engine.CookRenderEngine()
        self.addCleanup(mock.patch.stopall)

    def test_the_engine_gives_the_tracer_folder_check_blenders_path_expander(self):
        stop = RuntimeError("stop after the folder check")
        with mock.patch.object(self.engine.native_runner, "resolve_native_directory", side_effect=stop) as resolve:
            self.render_engine.render(fake_depsgraph())
        self.assertIs(resolve.call_args.kwargs["expand_path"], sys.modules["bpy"].path.abspath)

    def test_a_non_finite_environment_cap_is_refused_on_the_render_path(self):
        description = {"camera": {"fov": 40.0}}
        for value in (float("nan"), float("inf")):
            render_engine = self.engine.CookRenderEngine()
            with tempfile.TemporaryDirectory() as directory:
                with mock.patch.object(self.engine.native_runner, "resolve_native_directory", return_value=directory), \
                        mock.patch.object(self.engine.native_runner, "resolve_node_executable", return_value="node"), \
                        mock.patch.object(self.engine, "export_scene", return_value=(description, {}, {})), \
                        mock.patch.object(self.engine.CookRenderEngine, "report_export"), \
                        mock.patch.object(self.engine.native_runner, "run_with_cancel") as run:
                    render_engine.render(fake_depsgraph(value))
            run.assert_not_called()
            self.assertEqual(len(render_engine.errors), 1)
            self.assertIn("environment cap", render_engine.errors[0])


def fake_mesh_scene(clip_start, clip_end):
    camera_data = mock.MagicMock(type="PERSP", sensor_fit="AUTO", sensor_width=36.0, sensor_height=24.0, lens=50.0, shift_x=0.0, shift_y=0.0)
    camera_data.clip_start = clip_start
    camera_data.clip_end = clip_end
    camera_data.dof.use_dof = False
    camera_object = mock.MagicMock(data=camera_data, matrix_world=IdentityMatrix())
    camera_object.name = "Camera"
    scene = mock.MagicMock()
    scene.camera.evaluated_get.return_value = camera_object
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    scene.render.film_transparent = False
    scene.name = "Scene"
    return scene, camera_object


def fake_mesh_instance():
    original = mock.MagicMock(type="MESH", hide_render=False, is_holdout=False, is_shadow_catcher=False, modifiers=[])
    original.name = "Cube"
    original.data.name = "CubeMesh"
    evaluated = mock.MagicMock(type="MESH", original=original)
    return mock.MagicMock(object=evaluated, is_instance=False, parent=None, show_self=True)


class SceneExportCallSiteTests(unittest.TestCase):
    def setUp(self):
        from cook_blender import scene_export
        self.scene_export = scene_export
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(mock.patch.stopall)

    def test_the_exported_far_plane_is_the_cameras_clip_end(self):
        scene, camera_object = fake_mesh_scene(0.1, 100.0)
        camera_entry, _ = self.scene_export.build_camera_entries(scene, 8, 8, {}, camera_object=camera_object, honor_roll=True)
        self.assertEqual(camera_entry["far"], 100.0)

    def test_a_scene_of_empty_meshes_gets_the_no_triangles_message(self):
        scene, _ = fake_mesh_scene(0.1, 100.0)
        depsgraph = mock.MagicMock(scene=scene, object_instances=[fake_mesh_instance()])
        with mock.patch.object(self.scene_export, "mesh_to_triangle_groups", return_value={}), \
                mock.patch.object(self.scene_export, "evaluated_mesh_digest", return_value=(0, "digest")):
            with self.assertRaises(ValueError) as raised:
                self.scene_export.export_scene(depsgraph, 8, 8, self.directory.name)
        self.assertIn("no triangles", str(raised.exception))
        self.assertNotIn("enabled for rendering", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
