"""Convert a transparent row-major sprite grid into an OpenPets strip.

Every source cell uses one fixed scale and horizontal transform. The visible
ground line is then aligned vertically, which corrects row-to-row layout drift
without re-centering moving tails or paws and reintroducing horizontal jitter.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--rows", type=int, default=2)
    # OpenPets 3.3's plugin override renderer infers frame width from the
    # strip's height, so plugin-bundled animation strips must use square cells.
    parser.add_argument("--frame-width", type=int, default=208)
    parser.add_argument("--frame-height", type=int, default=208)
    parser.add_argument("--content-size", type=int, default=180)
    parser.add_argument("--minimum-margin", type=int, default=5)
    parser.add_argument("--alpha-floor", type=int, default=12)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if min(args.columns, args.rows, args.frame_width, args.frame_height, args.content_size) <= 0:
        raise SystemExit("Grid and frame dimensions must be positive.")
    if args.content_size > min(args.frame_width, args.frame_height):
        raise SystemExit("Content size must fit inside each output frame.")

    source = Image.open(args.input).convert("RGBA")
    width_remainder = source.width % args.columns
    height_remainder = source.height % args.rows
    if width_remainder or height_remainder:
        # Image generators can return an otherwise exact grid with one or two
        # extra border pixels. Trim only that small outer remainder; never
        # resample or independently crop cells.
        if width_remainder >= args.columns or height_remainder >= args.rows:
            raise SystemExit("Source dimensions must divide evenly into the requested grid.")
        target_width = source.width - width_remainder
        target_height = source.height - height_remainder
        left = (source.width - target_width) // 2
        top = (source.height - target_height) // 2
        source = source.crop((left, top, left + target_width, top + target_height))
    cell_width = source.width // args.columns
    cell_height = source.height // args.rows
    if cell_width != cell_height:
        raise SystemExit("Source grid cells must be square to preserve the fixed camera transform.")

    frame_count = args.columns * args.rows
    strip = Image.new("RGBA", (args.frame_width * frame_count, args.frame_height), (0, 0, 0, 0))
    offset_x = (args.frame_width - args.content_size) // 2
    margins: list[int] = []

    for index in range(frame_count):
        column = index % args.columns
        row = index // args.columns
        cell = source.crop((
            column * cell_width,
            row * cell_height,
            (column + 1) * cell_width,
            (row + 1) * cell_height,
        ))
        cell = cell.resize((args.content_size, args.content_size), Image.Resampling.LANCZOS)
        if args.alpha_floor > 0:
            alpha = cell.getchannel("A").point(lambda value: 0 if value < args.alpha_floor else value)
            cell.putalpha(alpha)
        cell_bounds = cell.getchannel("A").getbbox()
        if cell_bounds is None:
            raise SystemExit(f"Frame {index} is empty.")
        offset_y = args.frame_height - args.minimum_margin - cell_bounds[3]
        if offset_y < 0:
            raise SystemExit(f"Frame {index} cannot fit above the requested ground margin.")
        frame = Image.new("RGBA", (args.frame_width, args.frame_height), (0, 0, 0, 0))
        frame.alpha_composite(cell, (offset_x, offset_y))
        bounds = frame.getchannel("A").getbbox()
        assert bounds is not None
        left, top, right, bottom = bounds
        margin = min(left, top, args.frame_width - right, args.frame_height - bottom)
        if margin < args.minimum_margin:
            raise SystemExit(f"Frame {index} has only {margin}px transparent margin.")
        margins.append(margin)
        strip.alpha_composite(frame, (index * args.frame_width, 0))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    strip.save(args.output, "WEBP", lossless=True, quality=100, method=6)
    print(
        f"Wrote {args.output} ({frame_count} frames, {args.frame_width}x{args.frame_height}, "
        f"minimum transparent margin {min(margins)}px)."
    )


if __name__ == "__main__":
    main()
