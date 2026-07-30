from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TARGET_DIR = ROOT / "openpets" / "pets" / "tuan-tuan"
SOURCE = TARGET_DIR / "source.png"
FRAME_W, FRAME_H, COLS, ROWS = 192, 208, 8, 9


def frame(source: Image.Image, row: int, column: int) -> Image.Image:
    phase = column / COLS
    width = 166
    height = 176
    y = 27
    x = (FRAME_W - width) // 2
    angle = 0
    mirror = False

    if row == 0:  # idle / breathing
        height += round(2 * (1 if column in (2, 3, 4) else 0))
        y -= height - 176
    elif row in (1, 2):  # walk right / left
        y += [0, -3, -6, -3, 0, -3, -6, -3][column]
        x += [0, 2, 4, 2, 0, -2, -4, -2][column]
        mirror = row == 2
    elif row == 3:  # waving / playful tilt
        angle = [-2, 0, 3, 6, 3, 0, -2, 0][column]
    elif row == 4:  # jumping
        y -= [0, 8, 20, 34, 20, 8, 0, 0][column]
        angle = [-2, -1, 0, 2, 0, -1, -2, 0][column]
    elif row == 5:  # failed / tired
        y += [0, 3, 6, 9, 9, 6, 3, 0][column]
        angle = [0, -2, -4, -6, -6, -4, -2, 0][column]
    elif row == 6:  # waiting / sleep
        height = [172, 169, 166, 163, 163, 166, 169, 172][column]
        y = 31 + (176 - height)
    elif row == 7:  # busy
        angle = [-3, 0, 3, 0, -3, 0, 3, 0][column]
        y -= 2 if column % 2 else 0
    elif row == 8:  # review / looking around
        x += [-3, -2, 0, 2, 3, 2, 0, -2][column]
        angle = [-2, -1, 0, 1, 2, 1, 0, -1][column]

    image = source.resize((width, height), Image.Resampling.LANCZOS)
    if mirror:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if angle:
        image = image.rotate(angle, Image.Resampling.BICUBIC, expand=True)
        x = (FRAME_W - image.width) // 2
    canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    canvas.alpha_composite(image, (x, y))
    return canvas


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    bbox = source.getchannel("A").getbbox()
    if not bbox:
        raise RuntimeError("Source sprite has no visible pixels")
    source = source.crop(bbox)
    sheet = Image.new("RGBA", (FRAME_W * COLS, FRAME_H * ROWS), (0, 0, 0, 0))
    for row in range(ROWS):
        for column in range(COLS):
            sheet.alpha_composite(frame(source, row, column), (column * FRAME_W, row * FRAME_H))
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    # `exact=True` preserves RGB=0 under fully transparent pixels. Without it,
    # libwebp may synthesize arbitrary hidden RGB values that some previewers
    # expose as colored blocks even though alpha is zero.
    sheet.save(TARGET_DIR / "spritesheet.webp", "WEBP", lossless=True, method=6, exact=True)
    source.save(TARGET_DIR / "source.png")
    print(f"Wrote {sheet.width}x{sheet.height} OpenPets spritesheet")


if __name__ == "__main__":
    main()
