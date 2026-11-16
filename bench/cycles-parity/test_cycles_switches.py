"""Unit tests for cycles_switches.py, which needs no Blender. Run: uv run --no-project python -m unittest bench/cycles-parity/test_cycles_switches.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cycles_switches import allowed_property_names, parse_cycles_property  # noqa: E402


class AllowedPropertyTest(unittest.TestCase):
    def test_the_glossy_filter_is_settable_by_its_cook_name_and_its_blender_name(self):
        self.assertEqual(parse_cycles_property("filter_glossy=0"), ("blur_glossy", 0.0))
        self.assertEqual(parse_cycles_property("blur_glossy=0.5"), ("blur_glossy", 0.5))

    def test_clamps_and_caustics_are_settable(self):
        self.assertEqual(parse_cycles_property("sample_clamp_direct=10"), ("sample_clamp_direct", 10.0))
        self.assertEqual(parse_cycles_property("sample_clamp_indirect=0"), ("sample_clamp_indirect", 0.0))
        self.assertEqual(parse_cycles_property("caustics_reflective=false"), ("caustics_reflective", False))
        self.assertEqual(parse_cycles_property("caustics_refractive=true"), ("caustics_refractive", True))

    def test_a_whole_number_property_returns_an_int(self):
        name, value = parse_cycles_property("max_bounces=4")
        self.assertEqual(name, "max_bounces")
        self.assertIsInstance(value, int)


class RefusedAssignmentTest(unittest.TestCase):
    def test_an_unknown_name_lists_the_allowed_ones(self):
        with self.assertRaises(ValueError) as caught:
            parse_cycles_property("not_a_switch=1")
        message = str(caught.exception)
        for name in allowed_property_names():
            self.assertIn(name, message)
        self.assertIn("filter_glossy", message)

    def test_a_value_out_of_range_names_the_range(self):
        with self.assertRaisesRegex(ValueError, "between 0.0 and 10.0"):
            parse_cycles_property("filter_glossy=-1")
        with self.assertRaisesRegex(ValueError, "between 0.0 and 1.0"):
            parse_cycles_property("light_sampling_threshold=2")

    def test_a_value_of_the_wrong_kind_is_refused(self):
        with self.assertRaisesRegex(ValueError, "true or false"):
            parse_cycles_property("caustics_reflective=1")
        with self.assertRaisesRegex(ValueError, "a number"):
            parse_cycles_property("blur_glossy=true")
        with self.assertRaisesRegex(ValueError, "whole number"):
            parse_cycles_property("max_bounces=2.5")
        with self.assertRaisesRegex(ValueError, "JSON value"):
            parse_cycles_property("blur_glossy=abc")

    def test_a_missing_equals_sign_is_refused(self):
        with self.assertRaisesRegex(ValueError, "name=value"):
            parse_cycles_property("blur_glossy")


if __name__ == "__main__":
    unittest.main()
