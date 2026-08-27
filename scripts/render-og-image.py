#!/usr/bin/env python3
"""Render the Open Graph card and the raster icons Google Search can crawl.

Re-run after changing the wordmark or the supported chains; the PNGs are
committed because the production site must not depend on a local font.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "public"
BG = (0, 0, 0)
INK = (245, 245, 247)
MUTED = (161, 161, 166)
LINE = (44, 44, 46)
VALID = (48, 209, 88)

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
    draw.line(path, fill=VALID, width=width + 1, joint="curve")


def mark_transparent(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_mark(draw, size // 2, size // 2, round(size * 0.378), max(1, round(size / 45)))
    return img


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


def render_icons() -> None:
    # Logo tiles are transparent so the mark sits on whatever chrome shows it
    # (browser tab, home screen, search). The Open Graph card stays opaque.
    favicon_48 = mark_transparent(48)
    favicon_48.save(ROOT / "favicon-48.png", "PNG", optimize=True)
    mark_transparent(192).save(ROOT / "favicon-192.png", "PNG", optimize=True)
    mark_transparent(180).save(ROOT / "apple-touch-icon.png", "PNG", optimize=True)
    favicon_48.save(
        ROOT / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    render_og()
    render_icons()
    print(
        "wrote",
        ROOT / "og.png",
        ROOT / "favicon.ico",
        ROOT / "favicon-48.png",
        ROOT / "favicon-192.png",
        "and",
        ROOT / "apple-touch-icon.png",
    )
