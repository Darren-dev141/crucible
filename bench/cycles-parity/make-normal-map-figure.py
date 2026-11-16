"""Evidence picture for #1111: Cycles, Cook and the 8 x 8 tile ratio map of one scene, side by side.

    uv run --no-project --with numpy --with pillow python bench/cycles-parity/make-normal-map-figure.py <cycles.npy> <cook.npy> <out.png> [title]

The tile map shows `Cook sum / Cycles sum` per tile: grey inside the 5 percent gate, red where Cook is brighter, blue where it is
darker, each with its number.
"""
import os
import sys

import numpy
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from compare import load_linear_rgb_image  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

GRID = 8
GATE = 0.05
PANEL_HEIGHT = 270


def to_display(linear_rgb):
    clipped = numpy.clip(linear_rgb, 0.0, 1.0)
    encoded = numpy.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * clipped ** (1 / 2.4) - 0.055)
    return Image.fromarray((encoded * 255.0 + 0.5).astype(numpy.uint8))


def tile_ratios(reference_rgb, candidate_rgb):
    height, width = reference_rgb.shape[0], reference_rgb.shape[1]
    ratios = numpy.zeros((GRID, GRID))
    for row in range(GRID):
        for column in range(GRID):
            rows_slice = slice(row * height // GRID, (row + 1) * height // GRID)
            columns_slice = slice(column * width // GRID, (column + 1) * width // GRID)
            reference_sum = float(numpy.sum(reference_rgb[rows_slice, columns_slice]))
            ratios[row, column] = float(numpy.sum(candidate_rgb[rows_slice, columns_slice])) / reference_sum if reference_sum > 0 else numpy.nan
    return ratios


def tile_color(ratio):
    if numpy.isnan(ratio):
        return (60, 60, 60)
    deviation = ratio - 1.0
    if abs(deviation) <= GATE:
        return (150, 150, 150)
    strength = min(abs(deviation) / 0.25, 1.0)
    if deviation > 0:
        return (int(200 + 55 * strength), int(110 * (1 - strength)), int(110 * (1 - strength)))
    return (int(110 * (1 - strength)), int(110 * (1 - strength)), int(200 + 55 * strength))


def draw_tile_map(ratios, width, height):
    image = Image.new("RGB", (width, height))
    drawing = ImageDraw.Draw(image)
    for row in range(GRID):
        for column in range(GRID):
            left, top = column * width // GRID, row * height // GRID
            right, bottom = (column + 1) * width // GRID, (row + 1) * height // GRID
            drawing.rectangle([left, top, right - 1, bottom - 1], fill=tile_color(ratios[row, column]))
            label = "-" if numpy.isnan(ratios[row, column]) else f"{ratios[row, column]:.3f}"
            drawing.text((left + 4, top + (bottom - top) // 2 - 5), label, fill=(0, 0, 0))
    return image


def main():
    cycles_rgb = load_linear_rgb_image(sys.argv[1])
    cook_rgb = load_linear_rgb_image(sys.argv[2])
    ratios = tile_ratios(cycles_rgb, cook_rgb)
    height, width = cycles_rgb.shape[0], cycles_rgb.shape[1]
    panels = [to_display(cycles_rgb), to_display(cook_rgb), draw_tile_map(ratios, width, height)]
    canvas = Image.new("RGB", (width * 3, height + 18), (255, 255, 255))
    drawing = ImageDraw.Draw(canvas)
    for index, caption in enumerate(("Cycles", "Cook", "Cook / Cycles per tile")):
        canvas.paste(panels[index], (index * width, 18))
        drawing.text((index * width + 4, 3), caption if len(sys.argv) < 5 else f"{sys.argv[4]}: {caption}", fill=(0, 0, 0))
    canvas.save(sys.argv[3])
    outside = int(numpy.sum(numpy.abs(ratios[~numpy.isnan(ratios)] - 1.0) > GATE))
    print(f"tiles outside 5 percent: {outside} of {int(numpy.sum(~numpy.isnan(ratios)))}, worst {numpy.nanmax(numpy.abs(ratios - 1.0)) + 1.0:.3f}")


if __name__ == "__main__":
    main()
