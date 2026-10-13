#!/usr/bin/env python3
"""Draw docs/images/globus-harness.svg, the README banner, from the lab header's wordmark.

The wordmark is the Globus cluster's login banner (globus-admin roles/motd/templates/
00-globus-banner.j2) as copied into profiles/lab/header.json: the "ANSI Shadow" GLOBUS, with
HARNESS for CLUSTER. In a terminal it is text; on GitHub a code block of it renders uncoloured and
with line gaps that break the letters apart, so here the solid cells become rectangles (each row's
runs merged, so scaling leaves no hairline seams), the box-drawing shadow becomes a soft offset
copy of the letters, and the MOTD's blue-to-aqua gradient runs top to bottom.

    python3 scripts/make-banner.py        # rewrite the SVG after editing the header's art
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
art = json.loads((root / "profiles/lab/header.json").read_text())["art"]
rows, subtitle = art[:6], " ".join(art[6].split())
CW, CH, PAD = 12, 24, 18                 # a terminal cell is about twice as tall as it is wide
TOP, BOT = "#2a78d6", "#1baf7a"          # the MOTD's first and last row colours
SHADOW_DX, SHADOW_DY, SHADOW_OPACITY = CW * 0.5, CH * 0.3, 0.28
cols = max(len(r) for r in rows)
W, H_ART = cols * CW + 2 * PAD, len(rows) * CH
H = PAD + H_ART + 50 + PAD

runs = []                                 # (x, y, width) per run of consecutive blocks in a row
for r, row in enumerate(rows):
    c = 0
    while c < len(row):
        if row[c] == "█":
            start = c
            while c < len(row) and row[c] == "█":
                c += 1
            runs.append((PAD + start * CW, PAD + r * CH, (c - start) * CW))
        else:
            c += 1

rect = lambda x, y, w: f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{CH + 0.5:g}"/>'
svg = "\n".join([
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Globus Harness">',
    "<title>Globus Harness</title>",
    f'<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="{PAD}" x2="0" y2="{PAD + H_ART}">'
    f'<stop offset="0" stop-color="{TOP}"/><stop offset="1" stop-color="{BOT}"/></linearGradient></defs>',
    f'<g fill="url(#g)" opacity="{SHADOW_OPACITY}" transform="translate({SHADOW_DX:g} {SHADOW_DY:g})">' + "".join(rect(*r) for r in runs) + "</g>",
    '<g fill="url(#g)">' + "".join(rect(*r) for r in runs) + "</g>",
    f'<text x="{W / 2:g}" y="{PAD + H_ART + 36}" text-anchor="middle" fill="{BOT}" '
    'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="19" font-weight="700" '
    f'letter-spacing="8">{subtitle}</text>',
    "</svg>",
])
out = root / "docs/images/globus-harness.svg"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(svg + "\n")
print(f"{out.relative_to(root)}: {W}x{H}, {len(runs)} runs")
