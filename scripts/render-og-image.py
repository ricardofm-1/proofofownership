#!/usr/bin/env python3
"""Render the Open Graph card and the apple-touch icon.

Re-run after changing the wordmark or the supported chains; the PNGs are
committed because the production site must not depend on a local font.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "public"
BG = (12, 13, 15)
INK = (233, 234, 236)
MUTED = (154, 160, 169)
LINE = (36, 39, 44)
VALID = (76, 208, 138)

FONT_DIR = Path("/System/Library/Fonts/Supplemental")
SANS = FONT_DIR / "Arial.ttf"
SANS_BOLD = FONT_DIR / "Arial Bold.ttf"


def load(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def draw_mark(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int, width: int) -> None:
    box = [cx - r, cy - r, cx + r, cy + r]
    inner = r * 0.72
    inner_box = [cx - inner, cy - inner, cx + inner, cy + inner]
    draw.ellipse(box, outline=INK, width=width)
    # Approximate the dashed inner ring with short arcs.
    for start in range(0, 360, 24):
        draw.arc(inner_box, start, start + 10, fill=INK, width=max(1, width - 1))
    # Check mark, scaled to the ring.
    s = r / 14.5
    path = [
        (cx + (11 - 16) * s, cy + (16.2 - 16) * s),
        (cx + (14.6 - 16) * s, cy + (20 - 16) * s),
        (cx + (21.4 - 16) * s, cy + (12.4 - 16) * s),
    ]
    draw.line(path, fill=INK, width=width + 1, joint="curve")


def render_og() -> None:
    img = Image.new("RGB", (1200, 630), BG)
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, 1199, 629), outline=LINE, width=1)

    title = load(SANS_BOLD, 54)
    sub = load(SANS, 28)
    chips = load(SANS, 22)

    draw_mark(draw, 96, 188, 28, 2)
    draw.text((144, 164), "Proof of Ownership", font=title, fill=INK)
    draw.text(
        (80, 250),
        "Sign and verify crypto wallet messages",
        font=sub,
        fill=MUTED,
    )
    draw.text(
        (80, 304),
        "Bitcoin  ·  Ethereum  ·  Solana  ·  Ripple (XRP)  ·  Cardano",
        font=chips,
        fill=INK,
    )
    draw.line((80, 500, 1120, 500), fill=LINE, width=1)
    draw.text(
        (80, 528),
        "Runs in the browser  ·  no server  ·  no keys leave the wallet",
        font=load(SANS, 20),
        fill=MUTED,
    )
    img.save(ROOT / "og.png", "PNG", optimize=True)


def render_icon() -> None:
    size = 180
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)
    draw_mark(draw, size // 2, size // 2, 68, 4)
    img.save(ROOT / "apple-touch-icon.png", "PNG", optimize=True)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    render_og()
    render_icon()
    print("wrote", ROOT / "og.png", "and", ROOT / "apple-touch-icon.png")
