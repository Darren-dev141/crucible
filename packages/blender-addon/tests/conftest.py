"""pytest setup for the add-on tests that run without Blender (CI runs `python -m pytest packages/blender-addon/tests`).

test_exporter_in_blender.py is a script for `blender -b --python`: it imports bpy and runs its checks at import time, so pytest
leaves it out unless Blender's Python is the one running pytest.
"""
import importlib.util

collect_ignore = []

if importlib.util.find_spec("bpy") is None:
    collect_ignore.append("test_exporter_in_blender.py")
