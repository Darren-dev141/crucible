import sys
import numpy as np
import flip_evaluator
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
folder = sys.argv[1]
width, height = 480, 300


def load(name):
    return np.fromfile(f"{folder}/{name}.f32", dtype=np.float32).reshape(height, width, 3)


def to_srgb(linear):
    clipped = np.clip(linear, 0, 1)
    return np.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * np.power(clipped, 1 / 2.4) - 0.055).astype(np.float32)


cpu = to_srgb(load("cpu"))
gpu = to_srgb(load("webgpu"))
_, mean_error, _ = flip_evaluator.evaluate(cpu, gpu, "LDR", inputsRGB=False)
print(f"mean FLIP {mean_error:.4f}")
pair = np.concatenate([cpu, gpu], axis=1)
Image.fromarray((pair * 255 + 0.5).astype(np.uint8)).save(f"{folder}/cpu-vs-webgpu.png")
