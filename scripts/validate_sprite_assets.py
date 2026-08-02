"""Pixel-level quality gates for project-owned OpenPets animation assets."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
FEED = ROOT / "openpets" / "plugins" / "openpets.shared-pet" / "assets" / "feed-v2.webp"
FRAME_WIDTH = 208
FRAME_HEIGHT = 208
FRAME_COUNT = 8
MINIMUM_MARGIN = 6


def validate_feed(path: Path = FEED) -> dict[str, int]:
    image = Image.open(path).convert("RGBA")
    expected_size = (FRAME_WIDTH * FRAME_COUNT, FRAME_HEIGHT)
    if image.size != expected_size:
        raise RuntimeError(f"Feed sprite is {image.size}, expected {expected_size}.")

    hidden_rgb = 0
    visible_key = 0
    pixels = image.tobytes()
    for offset in range(0, len(pixels), 4):
        red, green, blue, alpha = pixels[offset:offset + 4]
        if alpha == 0 and (red or green or blue):
            hidden_rgb += 1
        if alpha > 0 and green > 96 and green > red * 1.45 and green > blue * 1.45:
            visible_key += 1
    if hidden_rgb:
        raise RuntimeError(f"Feed sprite retains RGB color in {hidden_rgb} fully transparent pixels.")
    if visible_key:
        raise RuntimeError(f"Feed sprite retains {visible_key} visible chroma-key pixels.")

    minimum_margin = min(FRAME_WIDTH, FRAME_HEIGHT)
    nonempty_pixels = 0
    ground_lines: list[int] = []
    for index in range(FRAME_COUNT):
        frame = image.crop((index * FRAME_WIDTH, 0, (index + 1) * FRAME_WIDTH, FRAME_HEIGHT))
        alpha = frame.getchannel("A")
        bounds = alpha.getbbox()
        if bounds is None:
            raise RuntimeError(f"Feed frame {index} is empty.")
        left, top, right, bottom = bounds
        margin = min(left, top, FRAME_WIDTH - right, FRAME_HEIGHT - bottom)
        minimum_margin = min(minimum_margin, margin)
        if margin < MINIMUM_MARGIN:
            raise RuntimeError(f"Feed frame {index} has only {margin}px transparent margin.")
        ground_lines.append(bottom)
        nonempty_pixels += sum(1 for value in alpha.tobytes() if value > 0)
    if len(set(ground_lines)) != 1:
        raise RuntimeError(f"Feed frames do not share a stable ground line: {ground_lines}.")

    return {
        "frames": FRAME_COUNT,
        "minimum_margin": minimum_margin,
        "ground_line": ground_lines[0],
        "visible_pixels": nonempty_pixels,
    }


def main() -> None:
    metrics = validate_feed()
    print(
        "Feed sprite validated: "
        f"{metrics['frames']} frames, {metrics['minimum_margin']}px minimum margin, "
        f"ground line {metrics['ground_line']}, {metrics['visible_pixels']} visible pixels."
    )


if __name__ == "__main__":
    main()
