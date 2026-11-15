"""Parsing of the Cycles switches that render-cycles.py takes (--cycles-property), without bpy so that tests can run anywhere.

The names are Blender's scene.cycles identifiers (the `identifier` fields of bench/parity/blender-inventory.json). Cook's names differ for
some of them; CYCLES_PROPERTY_ALIASES maps a Cook-style name onto the Blender one.
"""
import json

# kind: "bool", "int" or "float". Bounds are inclusive and follow Blender's own soft/hard limits for the property.
CYCLES_PROPERTY_SPECS = {
    "blur_glossy": {"kind": "float", "minimum": 0.0, "maximum": 10.0, "meaning": "Filter Glossy; Cook filterGlossy"},
    "sample_clamp_direct": {"kind": "float", "minimum": 0.0, "maximum": 1.0e6, "meaning": "Clamp Direct, 0 is off"},
    "sample_clamp_indirect": {"kind": "float", "minimum": 0.0, "maximum": 1.0e6, "meaning": "Clamp Indirect, 0 is off"},
    "caustics_reflective": {"kind": "bool", "meaning": "Reflective Caustics"},
    "caustics_refractive": {"kind": "bool", "meaning": "Refractive Caustics"},
    "light_sampling_threshold": {"kind": "float", "minimum": 0.0, "maximum": 1.0, "meaning": "Light Threshold"},
    "use_light_tree": {"kind": "bool", "meaning": "Light Tree"},
    "min_light_bounces": {"kind": "int", "minimum": 0, "maximum": 1024, "meaning": "Minimum bounces before Russian roulette"},
    "min_transparent_bounces": {"kind": "int", "minimum": 0, "maximum": 1024, "meaning": "Minimum transparent bounces"},
    "max_bounces": {"kind": "int", "minimum": 0, "maximum": 1024, "meaning": "Total bounces"},
    "diffuse_bounces": {"kind": "int", "minimum": 0, "maximum": 1024, "meaning": "Diffuse bounces"},
    "glossy_bounces": {"kind": "int", "minimum": 0, "maximum": 1024, "meaning": "Glossy bounces"},
    "transmission_bounces": {"kind": "int", "minimum": 0, "maximum": 1024, "meaning": "Transmission bounces"},
    "use_adaptive_sampling": {"kind": "bool", "meaning": "Adaptive sampling"},
}

CYCLES_PROPERTY_ALIASES = {
    "filter_glossy": "blur_glossy",
}


def allowed_property_names():
    return sorted(CYCLES_PROPERTY_SPECS)


def describe_allowed_properties():
    aliases = ", ".join(f"{alias} (is {target})" for alias, target in sorted(CYCLES_PROPERTY_ALIASES.items()))
    return f"allowed: {', '.join(allowed_property_names())}; also accepted: {aliases}"


def read_property_value(property_name, spec, property_text):
    try:
        property_value = json.loads(property_text)
    except json.JSONDecodeError:
        raise ValueError(f"--cycles-property {property_name} takes a JSON value such as 0, 0.5 or true, got {property_text!r}.")
    is_boolean = isinstance(property_value, bool)
    if (spec["kind"] == "bool") != is_boolean:
        expected = "true or false" if spec["kind"] == "bool" else "a number"
        raise ValueError(f"--cycles-property {property_name} takes {expected}, got {property_text!r}.")
    if spec["kind"] == "bool":
        return property_value
    if not isinstance(property_value, (int, float)):
        raise ValueError(f"--cycles-property {property_name} takes a number, got {property_text!r}.")
    if spec["kind"] == "int":
        if isinstance(property_value, float) and not property_value.is_integer():
            raise ValueError(f"--cycles-property {property_name} is a whole number, got {property_text!r}.")
        property_value = int(property_value)
    else:
        property_value = float(property_value)
    if not spec["minimum"] <= property_value <= spec["maximum"]:
        raise ValueError(
            f"--cycles-property {property_name} must be between {spec['minimum']} and {spec['maximum']}, got {property_text!r}."
        )
    return property_value


def parse_cycles_property(property_assignment):
    """Turn "name=value" into (blender_property_name, typed_value), or raise a ValueError that says what to pass instead."""
    if "=" not in property_assignment:
        raise ValueError(f"--cycles-property takes name=value, got {property_assignment!r}.")
    given_name, property_text = property_assignment.split("=", 1)
    property_name = CYCLES_PROPERTY_ALIASES.get(given_name, given_name)
    spec = CYCLES_PROPERTY_SPECS.get(property_name)
    if spec is None:
        raise ValueError(f"--cycles-property {given_name!r} is not a switch of this script; {describe_allowed_properties()}.")
    return property_name, read_property_value(property_name, spec, property_text)
