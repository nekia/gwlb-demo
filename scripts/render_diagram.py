#!/usr/bin/env python3
"""
描画スクリプト: Stack構成を日本語の画像として出力する。
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import matplotlib.image as mpimg
from matplotlib.font_manager import FontProperties
from matplotlib.offsetbox import AnnotationBbox, OffsetImage
from matplotlib.patches import FancyBboxPatch
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
DIAGRAM_DIR = BASE_DIR / "diagrams"
ICON_DIR = DIAGRAM_DIR / "icons"
FONT_PATH = DIAGRAM_DIR / "fonts" / "NotoSansCJKjp-Regular.otf"

OUTPUT_PNG = DIAGRAM_DIR / "gwlb-demo.png"
OUTPUT_SVG = DIAGRAM_DIR / "gwlb-demo.svg"

JP_FONT = FontProperties(fname=str(FONT_PATH))


def add_lane(ax, x, width, color, title):
    rect = FancyBboxPatch(
        (x, 3),
        width,
        34,
        boxstyle="round,pad=0.6",
        linewidth=0,
        facecolor=color,
        alpha=0.45,
    )
    ax.add_patch(rect)
    ax.text(
        x + width / 2,
        35.2,
        title,
        ha="center",
        va="bottom",
        fontsize=13,
        fontproperties=JP_FONT,
        fontweight="bold",
    )


def add_component(ax, center, size, color, title, lines, icon_path=None):
    cx, cy = center
    width, height = size
    rect = FancyBboxPatch(
        (cx - width / 2, cy - height / 2),
        width,
        height,
        boxstyle="round,pad=0.4",
        linewidth=1.5,
        edgecolor=color,
        facecolor="white",
    )
    ax.add_patch(rect)

    if icon_path:
        img = mpimg.imread(icon_path)
        image = OffsetImage(img, zoom=0.5)
        ab = AnnotationBbox(image, (cx, cy + height / 2 - 2), frameon=False)
        ax.add_artist(ab)
        text_y = cy - 1
    else:
        text_y = cy

    text_lines = [title] + lines
    ax.text(
        cx,
        text_y,
        "\n".join(text_lines),
        ha="center",
        va="center",
        fontsize=11,
        fontproperties=JP_FONT,
    )
    return center


def add_arrow(ax, start, end, text, color="#555555", style="-"):
    ax.annotate(
        "",
        xy=end,
        xytext=start,
        arrowprops=dict(
            arrowstyle="->",
            linewidth=2,
            color=color,
            linestyle=style,
            shrinkA=10,
            shrinkB=10,
        ),
    )
    if text:
        mid_x = (start[0] + end[0]) / 2
        mid_y = (start[1] + end[1]) / 2
        ax.text(
            mid_x,
            mid_y + 1.2,
            text,
            fontsize=10,
            color=color,
            fontproperties=JP_FONT,
            ha="center",
        )


def main():
    fig, ax = plt.subplots(figsize=(18, 6))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 40)
    ax.axis("off")
    ax.set_title(
        "Gateway Load Balancer デモ構成",
        fontsize=18,
        fontproperties=JP_FONT,
        pad=20,
    )

    lane_width = 18
    gap = 2
    lane_starts = [2 + i * (lane_width + gap) for i in range(5)]
    lanes = [
        ("バックエンドVPC (10.50.0.0/16)", "#cfe4ff"),
        ("GWLBエンドポイント", "#dbeaff"),
        ("Gateway Load Balancer", "#ffe3c2"),
        ("オーバーレイVPC (10.60.0.0/16)", "#d7f2dc"),
        ("クライアントVPC", "#f9d5e5"),
    ]

    for (title, color), x in zip(lanes, lane_starts):
        add_lane(ax, x, lane_width, color, title)

    centers = {}

    centers["backend_ec2"] = add_component(
        ax,
        center=(lane_starts[0] + lane_width / 2, 26),
        size=(13, 10),
        color="#2473c5",
        title="バックエンドEC2",
        lines=["UDPで10.0.0.10:80へ送信", "SSMエージェント有効"],
        icon_path=ICON_DIR / "amazon-ec2.png",
    )

    centers["ssm"] = add_component(
        ax,
        center=(lane_starts[0] + lane_width / 2, 14),
        size=(13, 10),
        color="#2473c5",
        title="SSMインターフェース\nエンドポイント",
        lines=["SSM / SSM Messages / EC2 Messages", "443/TCP を VPC から許可"],
        icon_path=ICON_DIR / "aws-systems-manager.png",
    )

    centers["route"] = add_component(
        ax,
        center=(lane_starts[0] + lane_width / 2, 6),
        size=(13, 6),
        color="#2473c5",
        title="ルート設定",
        lines=["10.0.0.10/32 → GWLBE"],
    )

    centers["gwlbe"] = add_component(
        ax,
        center=(lane_starts[1] + lane_width / 2, 20),
        size=(13, 12),
        color="#3794ff",
        title="GWLBエンドポイント",
        lines=["タイプ: GatewayLoadBalancer", "各AZのプライベートサブネットに配置"],
        icon_path=ICON_DIR / "aws-privatelink.png",
    )

    centers["gwlb"] = add_component(
        ax,
        center=(lane_starts[2] + lane_width / 2, 28),
        size=(13, 12),
        color="#ff9f1c",
        title="GWLB本体",
        lines=["GENEVE 6081 / 公開サブネット", "クロスAZ有効"],
        icon_path=ICON_DIR / "aws-gwlb.png",
    )

    centers["endpoint_service"] = add_component(
        ax,
        center=(lane_starts[2] + lane_width / 2, 16),
        size=(13, 10),
        color="#ff9f1c",
        title="GWLBエンドポイントサービス",
        lines=["GWLB ARN を共有", "承認不要 (auto-accept)"],
        icon_path=ICON_DIR / "aws-privatelink.png",
    )

    centers["listener"] = add_component(
        ax,
        center=(lane_starts[2] + lane_width / 2, 6),
        size=(13, 6),
        color="#ff9f1c",
        title="リスナー",
        lines=["デフォルト: ターゲットグループへ転送"],
    )

    centers["target_group"] = add_component(
        ax,
        center=(lane_starts[3] - gap / 2, 6),
        size=(13, 6),
        color="#ff9f1c",
        title="ターゲットグループ",
        lines=["ターゲット: EC2", "ヘルスチェック: TCP 80 / 10秒"],
    )

    centers["overlay_gw"] = add_component(
        ax,
        center=(lane_starts[3] + lane_width / 2, 24),
        size=(13, 12),
        color="#4caf50",
        title="オーバーレイ\nゲートウェイEC2",
        lines=["vpn_server をビルドして実行", "UDP 5000/6081, TCP 80 を許可"],
        icon_path=ICON_DIR / "amazon-ec2.png",
    )

    centers["overlay_note"] = add_component(
        ax,
        center=(lane_starts[3] + lane_width / 2, 12),
        size=(13, 8),
        color="#4caf50",
        title="ユーザーデータ",
        lines=["Goコードを配置し /usr/local/bin に導入"],
    )

    centers["vpn_client"] = add_component(
        ax,
        center=(lane_starts[4] + lane_width / 2, 22),
        size=(13, 12),
        color="#d81b60",
        title="VPNクライアントEC2",
        lines=["固定IP 10.60.1.50", "vpn_client が UDP 6000 で待受"],
        icon_path=ICON_DIR / "amazon-ec2.png",
    )

    centers["client_sg"] = add_component(
        ax,
        center=(lane_starts[4] + lane_width / 2, 10),
        size=(13, 8),
        color="#d81b60",
        title="クライアントSG",
        lines=["インバウンド: UDP 6000 (ゲートウェイSG)", "アウトバウンド: 10.60.0.10:5000"],
    )

    add_arrow(
        ax,
        centers["backend_ec2"],
        centers["route"],
        "UDP/80 テストトラフィック",
        color="#2473c5",
    )
    add_arrow(
        ax,
        centers["route"],
        centers["gwlbe"],
        "10.0.0.10/32 へ誘導",
        color="#2473c5",
    )
    add_arrow(
        ax,
        centers["gwlbe"],
        centers["gwlb"],
        "GENEVE 6081",
        color="#3794ff",
    )
    add_arrow(
        ax,
        centers["gwlb"],
        centers["endpoint_service"],
        "サービス公開",
        color="#ff9f1c",
        style="--",
    )
    add_arrow(
        ax,
        centers["listener"],
        centers["target_group"],
        "フォワード",
        color="#ff9f1c",
    )
    add_arrow(
        ax,
        centers["target_group"],
        centers["overlay_gw"],
        "検査トラフィック",
        color="#4caf50",
    )
    add_arrow(
        ax,
        centers["overlay_gw"],
        centers["vpn_client"],
        "VPNトンネル (UDP 6000)",
        color="#4caf50",
    )
    add_arrow(
        ax,
        centers["vpn_client"],
        centers["client_sg"],
        "セキュリティ制御",
        color="#d81b60",
        style=":",
    )
    add_arrow(
        ax,
        centers["backend_ec2"],
        centers["ssm"],
        "管理 (HTTPS 443)",
        color="#2473c5",
        style="--",
    )

    fig.savefig(OUTPUT_PNG, dpi=300, bbox_inches="tight")
    fig.savefig(OUTPUT_SVG, bbox_inches="tight")


if __name__ == "__main__":
    main()


