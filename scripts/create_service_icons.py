#!/usr/bin/env python3
"""
AWSサービス風の簡易アイコンを生成するユーティリティ。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE_DIR = Path(__file__).resolve().parents[1]
ICON_DIR = BASE_DIR / "diagrams" / "icons"
FONT_PATH = BASE_DIR / "diagrams" / "fonts" / "NotoSansCJKjp-Regular.otf"

ICON_SPECS = {
  "amazon-ec2.png": ("#ff9900", "EC2"),
  "aws-systems-manager.png": ("#1b6ac9", "SSM"),
  "aws-privatelink.png": ("#5a5ee8", "PL"),
  "aws-gwlb.png": ("#f28c21", "GWLB"),
}


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(str(FONT_PATH), 40)

    for filename, (color, text) in ICON_SPECS.items():
        img = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle(
            [(10, 10), (150, 150)],
            radius=35,
            fill=color,
        )
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.text(
            (80 - tw / 2, 80 - th / 2),
            text,
            fill="#ffffff",
            font=font,
        )
        out_path = ICON_DIR / filename
        img.save(out_path, format="PNG")
        print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()

