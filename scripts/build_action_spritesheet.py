from collections import deque
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from PIL import Image, ImageChops, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
PET_DIR = ROOT / "openpets" / "pets" / "tuan-tuan"
SOURCES = (
    PET_DIR / "action-source-v3-a-transparent.png",
    PET_DIR / "action-source-v3-b-transparent.png",
    PET_DIR / "action-source-v3-c-transparent.png",
)
OUTPUT = PET_DIR / "spritesheet.webp"

SOURCE_COLS, SOURCE_ROWS = 8, 3
FRAME_W, FRAME_H, OUTPUT_ROWS = 192, 208, 9
PAD_X, PAD_TOP, PAD_BOTTOM = 7, 6, 5
ALPHA_THRESHOLD = 24


def connected_components(alpha: Image.Image) -> list[list[tuple[int, int]]]:
    width, height = alpha.size
    pixels = alpha.load()
    visited = bytearray(width * height)
    components: list[list[tuple[int, int]]] = []

    for y in range(height):
        for x in range(width):
            index = y * width + x
            if visited[index] or pixels[x, y] < ALPHA_THRESHOLD:
                continue
            visited[index] = 1
            queue = deque([(x, y)])
            component: list[tuple[int, int]] = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    neighbor = ny * width + nx
                    if visited[neighbor] or pixels[nx, ny] < ALPHA_THRESHOLD:
                        continue
                    visited[neighbor] = 1
                    queue.append((nx, ny))
            components.append(component)
    return components


def component_bbox(component: list[tuple[int, int]]) -> tuple[int, int, int, int]:
    xs = [point[0] for point in component]
    ys = [point[1] for point in component]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def weighted_median_x(alpha: Image.Image) -> float:
    """Return a tail-resistant horizontal anchor for a visible subject."""
    histogram = [0] * alpha.width
    pixels = alpha.load()
    for y in range(alpha.height):
        for x in range(alpha.width):
            histogram[x] += pixels[x, y]
    midpoint = sum(histogram) / 2
    running = 0
    for x, weight in enumerate(histogram):
        running += weight
        if running >= midpoint:
            return x + 0.5
    return alpha.width / 2


@dataclass(frozen=True)
class SourceFrame:
    image: Image.Image
    source_bottom: int
    anchor_x: float


def isolate_component(strip: Image.Image, component: list[tuple[int, int]]) -> Image.Image:
    """Keep one cat body while restoring its soft antialiased edge pixels."""
    selection = Image.new("L", strip.size, 0)
    selection_pixels = selection.load()
    for x, y in component:
        selection_pixels[x, y] = 255
    selection = selection.filter(ImageFilter.MaxFilter(5))
    isolated = strip.copy()
    isolated.putalpha(ImageChops.multiply(strip.getchannel("A"), selection))
    return isolated


def extract_row_frames(source: Image.Image, row: int) -> list[SourceFrame]:
    top = round(row * source.height / SOURCE_ROWS)
    bottom = round((row + 1) * source.height / SOURCE_ROWS)
    strip = source.crop((0, top, source.width, bottom))
    components = connected_components(strip.getchannel("A"))
    if len(components) < SOURCE_COLS:
        raise RuntimeError(f"Expected at least {SOURCE_COLS} subjects in source row {row}")

    # Generated source rows slightly overlap vertically. Keeping only the eight
    # dominant connected subjects prevents paws/tails from an adjacent row from
    # leaking into this animation as isolated fragments.
    bodies = sorted(components, key=len, reverse=True)[:SOURCE_COLS]
    frames: list[tuple[float, SourceFrame]] = []
    for body in bodies:
        box = component_bbox(body)
        isolated = isolate_component(strip, body)
        expanded_box = (
            max(0, box[0] - 2),
            max(0, box[1] - 2),
            min(strip.width, box[2] + 2),
            min(strip.height, box[3] + 2),
        )
        sprite = isolated.crop(expanded_box)
        anchor_x = weighted_median_x(sprite.getchannel("A"))
        source_center = (box[0] + box[2]) / 2
        frames.append(
            (
                source_center,
                SourceFrame(
                    image=sprite,
                    source_bottom=box[3],
                    anchor_x=anchor_x,
                ),
            )
        )
    return [frame for _, frame in sorted(frames, key=lambda item: item[0])]


def split_source(source: Image.Image) -> list[list[SourceFrame]]:
    return [extract_row_frames(source, row) for row in range(SOURCE_ROWS)]


def row_scale(row_index: int, frames: list[SourceFrame]) -> float:
    widths = [frame.image.width for frame in frames]
    heights = [frame.image.height for frame in frames]

    if row_index in (1, 2, 4, 6, 7, 8):
        preferred = (FRAME_W - 2 * PAD_X) / median(widths)
    else:
        preferred = (FRAME_H - PAD_TOP - PAD_BOTTOM - 10) / median(heights)

    anchor_target = FRAME_W / 2
    max_left = max(frame.anchor_x for frame in frames)
    max_right = max(frame.image.width - frame.anchor_x for frame in frames)
    fit = min(
        (anchor_target - PAD_X) / max_left,
        (FRAME_W - PAD_X - anchor_target) / max_right,
        (FRAME_H - PAD_TOP - PAD_BOTTOM) / max(heights),
    )
    return min(preferred, fit)


def render_row(row_index: int, frames: list[SourceFrame]) -> list[Image.Image]:
    scale = row_scale(row_index, frames)
    ground_bottom = max(frame.source_bottom for frame in frames)
    rendered: list[Image.Image] = []

    for frame in frames:
        size = (
            max(1, round(frame.image.width * scale)),
            max(1, round(frame.image.height * scale)),
        )
        sprite = frame.image.resize(size, Image.Resampling.LANCZOS)
        sprite = ImageEnhance.Sharpness(sprite).enhance(1.08)

        canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
        scaled_anchor = frame.anchor_x * size[0] / frame.image.width
        x = round(FRAME_W / 2 - scaled_anchor)
        lift = round((ground_bottom - frame.source_bottom) * scale) if row_index == 4 else 0
        y = FRAME_H - PAD_BOTTOM - sprite.height - lift
        canvas.alpha_composite(sprite, (x, y))
        rendered.append(canvas)
    return rendered


def validate_frames(rows: list[list[Image.Image]]) -> None:
    for row_index, row in enumerate(rows):
        if len(row) != SOURCE_COLS:
            raise RuntimeError(f"Row {row_index} has {len(row)} frames, expected {SOURCE_COLS}")
        for column, frame in enumerate(row):
            bbox = frame.getchannel("A").getbbox()
            if not bbox:
                raise RuntimeError(f"Frame {row_index}:{column} is empty")
            left, top, right, bottom = bbox
            if left < 2 or right > FRAME_W - 2 or top < 2 or bottom > FRAME_H - 2:
                raise RuntimeError(
                    f"Frame {row_index}:{column} touches its boundary: {bbox}"
                )
            components = sorted(
                (len(component) for component in connected_components(frame.getchannel("A"))),
                reverse=True,
            )
            if len(components) > 1 and components[1] > components[0] * 0.002:
                raise RuntimeError(
                    f"Frame {row_index}:{column} contains a detached fragment: {components[:2]}"
                )
            anchor_error = abs(weighted_median_x(frame.getchannel("A")) - FRAME_W / 2)
            if anchor_error > 1:
                raise RuntimeError(
                    f"Frame {row_index}:{column} anchor drift is {anchor_error:.1f}px"
                )


def main() -> None:
    source_rows: list[list[SourceFrame]] = []
    for source_path in SOURCES:
        source = Image.open(source_path).convert("RGBA")
        source_rows.extend(split_source(source))
    if len(source_rows) != OUTPUT_ROWS:
        raise RuntimeError(f"Expected {OUTPUT_ROWS} rows, got {len(source_rows)}")

    rendered_rows = [render_row(index, frames) for index, frames in enumerate(source_rows)]
    validate_frames(rendered_rows)
    sheet = Image.new(
        "RGBA",
        (FRAME_W * SOURCE_COLS, FRAME_H * OUTPUT_ROWS),
        (0, 0, 0, 0),
    )
    for row_index, frames in enumerate(rendered_rows):
        for column, frame in enumerate(frames):
            sheet.alpha_composite(frame, (column * FRAME_W, row_index * FRAME_H))

    sheet.save(OUTPUT, "WEBP", lossless=True, method=6, exact=True)
    print(f"Wrote {OUTPUT} ({sheet.width}x{sheet.height}, RGBA)")


if __name__ == "__main__":
    main()
