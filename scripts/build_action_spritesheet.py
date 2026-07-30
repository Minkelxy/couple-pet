from collections import deque
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
PET_DIR = ROOT / "openpets" / "pets" / "tuan-tuan"
SOURCES = (
    PET_DIR / "action-source-v3-a-transparent.png",
    PET_DIR / "action-source-v3-b-transparent.png",
    PET_DIR / "action-source-v3-c-transparent.png",
)
OUTPUT = PET_DIR / "spritesheet-v3.webp"

SOURCE_COLS, SOURCE_ROWS = 8, 3
FRAME_W, FRAME_H, OUTPUT_ROWS = 192, 208, 9
PAD_X, PAD_TOP, PAD_BOTTOM = 6, 5, 4


def connected_components(alpha: Image.Image) -> list[list[tuple[int, int]]]:
    width, height = alpha.size
    pixels = alpha.load()
    visited = bytearray(width * height)
    components: list[list[tuple[int, int]]] = []

    for y in range(height):
        for x in range(width):
            index = y * width + x
            if visited[index] or pixels[x, y] < 40:
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
                    if visited[neighbor] or pixels[nx, ny] < 40:
                        continue
                    visited[neighbor] = 1
                    queue.append((nx, ny))
            components.append(component)
    return components


@dataclass(frozen=True)
class SourceFrame:
    image: Image.Image
    source_bottom: int


def component_bbox(component: list[tuple[int, int]]) -> tuple[int, int, int, int]:
    xs = [point[0] for point in component]
    ys = [point[1] for point in component]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def extract_row_frames(source: Image.Image, row: int) -> list[SourceFrame]:
    top = round(row * source.height / SOURCE_ROWS)
    bottom = round((row + 1) * source.height / SOURCE_ROWS)
    strip = source.crop((0, top, source.width, bottom))
    alpha = strip.getchannel("A")
    components = connected_components(alpha)
    if len(components) < SOURCE_COLS:
        raise RuntimeError(f"Expected at least {SOURCE_COLS} subjects in source row {row}")

    # The eight largest components are the eight cat bodies. Smaller nearby
    # components (for example a detached tail tip) are assigned to the nearest
    # body, while tiny motion marks are discarded.
    bodies = sorted(components, key=len, reverse=True)[:SOURCE_COLS]
    body_centers = [
        (component_bbox(component)[0] + component_bbox(component)[2]) / 2
        for component in bodies
    ]
    median_body_area = median(len(component) for component in bodies)
    groups: list[list[list[tuple[int, int]]]] = [[body] for body in bodies]
    body_ids = {id(body) for body in bodies}
    for component in components:
        if id(component) in body_ids or len(component) < median_body_area * 0.012:
            continue
        box = component_bbox(component)
        center = (box[0] + box[2]) / 2
        nearest = min(range(SOURCE_COLS), key=lambda index: abs(body_centers[index] - center))
        if abs(body_centers[nearest] - center) <= source.width / SOURCE_COLS * 0.62:
            groups[nearest].append(component)

    frames: list[tuple[float, SourceFrame]] = []
    alpha_pixels = alpha.load()
    for center, group in zip(body_centers, groups, strict=True):
        points = [point for component in group for point in component]
        box = component_bbox(points)
        mask = Image.new("L", strip.size, 0)
        mask_pixels = mask.load()
        for x, y in points:
            mask_pixels[x, y] = alpha_pixels[x, y]
        isolated = strip.copy()
        isolated.putalpha(mask)
        frames.append((center, SourceFrame(isolated.crop(box), box[3])))
    return [frame for _, frame in sorted(frames, key=lambda item: item[0])]


def split_source(source: Image.Image) -> list[list[SourceFrame]]:
    rows: list[list[SourceFrame]] = []
    for row in range(SOURCE_ROWS):
        rows.append(extract_row_frames(source, row))
    return rows


def row_scale(row_index: int, frames: list[SourceFrame]) -> float:
    widths = [frame.image.width for frame in frames]
    heights = [frame.image.height for frame in frames]

    if row_index in (1, 2, 4, 6, 7, 8):
        preferred = (FRAME_W - 2 * PAD_X) / median(widths)
    else:
        preferred = (FRAME_H - PAD_TOP - PAD_BOTTOM - 10) / median(heights)

    max_width = max(widths)
    max_height = max(heights)
    fit = min(
        (FRAME_W - 2 * PAD_X) / max_width,
        (FRAME_H - PAD_TOP - PAD_BOTTOM) / max_height,
    )
    return min(preferred, fit)


def render_row(row_index: int, frames: list[SourceFrame]) -> list[Image.Image]:
    scale = row_scale(row_index, frames)
    ground_bottom = max(frame.source_bottom for frame in frames)
    rendered: list[Image.Image] = []

    for frame in frames:
        sprite = frame.image
        size = (
            max(1, round(sprite.width * scale)),
            max(1, round(sprite.height * scale)),
        )
        sprite = sprite.resize(size, Image.Resampling.LANCZOS)
        sprite = ImageEnhance.Sharpness(sprite).enhance(1.12)

        canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
        x = (FRAME_W - sprite.width) // 2
        lift = round((ground_bottom - frame.source_bottom) * scale) if row_index == 4 else 0
        y = FRAME_H - PAD_BOTTOM - sprite.height - lift
        canvas.alpha_composite(sprite, (x, y))
        rendered.append(canvas)
    return rendered


def main() -> None:
    rows: list[list[SourceFrame]] = []
    for source_path in SOURCES:
        source = Image.open(source_path).convert("RGBA")
        rows.extend(split_source(source))
    if len(rows) != OUTPUT_ROWS:
        raise RuntimeError(f"Expected {OUTPUT_ROWS} rows, got {len(rows)}")

    sheet = Image.new(
        "RGBA",
        (FRAME_W * SOURCE_COLS, FRAME_H * OUTPUT_ROWS),
        (0, 0, 0, 0),
    )
    for row_index, frames in enumerate(rows):
        for column, frame in enumerate(render_row(row_index, frames)):
            sheet.alpha_composite(frame, (column * FRAME_W, row_index * FRAME_H))

    sheet.save(OUTPUT, "WEBP", lossless=True, method=6, exact=True)
    print(f"Wrote {OUTPUT} ({sheet.width}x{sheet.height}, RGBA)")


if __name__ == "__main__":
    main()
