"""Рисует иконки приложения и картинку-превью ссылки в dashboard/static/.

    python tools/make_images.py [--font /System/Library/Fonts/Supplemental/PTSerif.ttc]

Нужен Pillow (pip install pillow). Запускать вручную, когда меняется оформление; PNG коммитятся.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "dashboard" / "static"
PAPER, CARD, INK, MUTED, RED, BLUE = "#f4f5f2", "#fdfdfb", "#16181b", "#676c75", "#c2412d", "#2a5d9f"


def card_mark(draw: ImageDraw.ImageDraw, x: float, y: float, w: float, stroke: float) -> None:
    """Каталожная карточка: рамка, красная линия, две строки текста."""
    h = w * 20 / 26
    r = w * 2 / 26 * 1.6
    draw.rounded_rectangle((x, y, x + w, y + h), radius=r, fill=CARD, outline=INK, width=round(stroke))
    ry = y + h * 0.25
    draw.line((x + stroke, ry, x + w - stroke, ry), fill=RED, width=round(stroke))
    for i, frac in enumerate((0.62, 0.46)):
        ly = y + h * (0.5 + i * 0.2)
        draw.line((x + w * 0.19, ly, x + w * (0.19 + frac), ly), fill=BLUE, width=round(stroke * 0.8))


def icon(size: int, path: Path, maskable: bool = False) -> None:
    img = Image.new("RGB", (size, size), PAPER)
    d = ImageDraw.Draw(img)
    w = size * (0.56 if maskable else 0.74)       # у maskable-иконки поля: система обрезает углы
    card_mark(d, (size - w) / 2, (size - w * 20 / 26) / 2, w, max(2, size / 34))
    img.save(path, optimize=True)


def og_image(font_path: str, path: Path) -> None:
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, W, 10), fill=RED)
    card_mark(d, 96, 120, 150, 6)
    title = ImageFont.truetype(font_path, 92, index=3)      # PT Serif Bold
    body = ImageFont.truetype(font_path, 40, index=0)
    d.text((96, 270), "Сайты для познания", font=title, fill=INK)
    d.text((96, 400), "Свежие статьи из личной подборки:", font=body, fill=MUTED)
    d.text((96, 452), "философия, история, наука, культура", font=body, fill=MUTED)
    for i in range(14):                                       # мотив «пульса» — ряд клеток
        lv = [0.25, 0.4, 0.3, 0.6, 0.35, 0.5, 0.8, 0.45, 0.65, 0.9, 0.5, 0.7, 0.95, 1][i]
        c = tuple(round(a + (b - a) * lv) for a, b in zip((205, 226, 251), (24, 79, 149)))
        d.rounded_rectangle((96 + i * 52, 540, 96 + i * 52 + 42, 570), radius=6, fill=c)
    img.save(path, optimize=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", default="/System/Library/Fonts/Supplemental/PTSerif.ttc")
    args = ap.parse_args()
    icon(192, OUT / "icon-192.png")
    icon(512, OUT / "icon-512.png")
    icon(512, OUT / "icon-maskable.png", maskable=True)
    icon(180, OUT / "apple-touch-icon.png")
    og_image(args.font, OUT / "og.png")
    print("Готово:", ", ".join(p.name for p in sorted(OUT.glob("*.png"))))


if __name__ == "__main__":
    main()
