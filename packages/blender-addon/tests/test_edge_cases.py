"""Edge cases in the exporter that need no Blender: images without pixels feeding scalar sockets, and lens settings Cook drops."""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cook_blender import blender_conversions as conversions  # noqa: E402
from cook_blender import material_export  # noqa: E402
from cook_blender import native_runner  # noqa: E402


def fake_image(width, height, name="Missing.png"):
    image = mock.Mock()
    image.name = name
    image.name_full = name
    image.size = (width, height)
    image.is_float = False
    image.colorspace_settings.name = "sRGB"
    return image


def fake_image_node(image):
    node = mock.Mock()
    node.type = "TEX_IMAGE"
    node.image = image
    node.projection = "FLAT"
    node.interpolation = "Linear"
    node.extension = "REPEAT"
    node.inputs = {"Vector": mock.Mock(is_linked=False)}
    return node


def socket_fed_by(image_node, output_name, default_value):
    link = mock.Mock(is_muted=False, is_valid=True, from_node=image_node)
    link.from_socket.name = output_name
    return mock.Mock(is_linked=True, links=[link], default_value=default_value)


class ImageWithoutPixelsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.exporter = material_export.MaterialExporter(self.directory.name)
        self.missing_node = fake_image_node(fake_image(0, 0))

    def test_a_missing_roughness_image_keeps_the_constant_and_says_why(self):
        node = mock.Mock(inputs={
            "Metallic": mock.Mock(is_linked=False, default_value=0.25),
            "Roughness": socket_fed_by(self.missing_node, "Color", 0.6),
        })
        entry = {}
        self.exporter.apply_metallic_roughness("Clay", node, entry)
        self.assertEqual(self.exporter.images, [])
        self.assertNotIn("metallicRoughnessMap", entry)
        self.assertEqual((entry["metallic"], entry["roughness"]), (0.25, 0.6))
        self.assertIn("no pixels", self.exporter.notes["Clay"][0])

    def test_a_missing_alpha_image_keeps_the_constant_alpha(self):
        node = mock.Mock(inputs={"Alpha": socket_fed_by(self.missing_node, "Alpha", 0.5)})
        entry = {}
        self.exporter.apply_alpha("Glass", node, entry, None)
        self.assertEqual(self.exporter.images, [])
        self.assertNotIn("alphaMap", entry)
        self.assertEqual((entry["alphaMode"], entry["opacity"]), ("blend", 0.5))
        self.assertIn("no pixels", self.exporter.notes["Glass"][0])


class LensNoteTests(unittest.TestCase):
    def test_an_anamorphic_aperture_ratio_is_reported(self):
        notes = conversions.lens_feature_notes(2.0)
        self.assertEqual(len(notes), 1)
        self.assertIn("aperture ratio 2", notes[0])

    def test_a_round_aperture_needs_no_note(self):
        self.assertEqual(conversions.lens_feature_notes(1.0), [])


class FarClipTests(unittest.TestCase):
    def test_a_clip_end_below_a_thousand_is_kept(self):
        self.assertEqual(conversions.far_clip(0.1, 100.0), 100.0)

    def test_a_clip_end_equal_to_the_start_still_ends_past_it(self):
        self.assertGreater(conversions.far_clip(0.5, 0.5), 0.5)


class EmptySceneMessageTests(unittest.TestCase):
    def test_meshes_without_triangles_get_their_own_message(self):
        message = conversions.no_visible_mesh_message(3)
        self.assertIn("3 mesh object", message)
        self.assertIn("no triangles", message)
        self.assertNotIn("enabled for rendering", message)

    def test_no_mesh_at_all_keeps_the_render_flag_hint(self):
        self.assertIn("enabled for rendering", conversions.no_visible_mesh_message(0))


class RelativePathTests(unittest.TestCase):
    def test_a_blender_relative_folder_is_expanded_before_the_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            for parts in (native_runner.TRACE_SCRIPT_PARTS, native_runner.NATIVE_ADDON_PARTS):
                os.makedirs(os.path.join(directory, *parts[:-1]), exist_ok=True)
                open(os.path.join(directory, *parts), "w").close()
            expand = {"//tracer": directory}.get
            resolved = native_runner.resolve_native_directory("//tracer", environment={}, expand_path=expand)
            self.assertEqual(resolved, os.path.abspath(directory))


class EnvironmentCapTests(unittest.TestCase):
    def test_a_cap_that_is_not_a_finite_number_is_refused_by_name(self):
        for value in (float("nan"), float("inf")):
            with self.assertRaises(ValueError) as raised:
                native_runner.environment_cap_argument(value)
            self.assertIn("environment cap", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
