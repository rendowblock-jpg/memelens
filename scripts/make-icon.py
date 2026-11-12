#!/usr/bin/env python3
"""Draws the MemeLens mark (the lens in screens.tsx Brand(), same geometry) as apps/desktop/build/icon.png.
The packaging step turns this PNG into the Windows .ico. Needs Pillow. usage: python3 scripts/make-icon.py"""
import math, os
from PIL import Image, ImageDraw

SIZE, SS = 1024, 2                      # final size, supersampling factor
S = SIZE * SS
U = S / 32                              # one unit of the 32x32 brand viewBox
ACCENT, BG, EDGE, GLINT = (139, 155, 255, 255), (12, 15, 20, 255), (35, 42, 53, 255), (227, 233, 243, 178)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(7 * U), fill=BG, outline=EDGE, width=int(0.6 * U))

c = 16 * U
r = 11 * U
d.ellipse((c - r, c - r, c + r, c + r), outline=ACCENT, width=int(2.4 * U))
w = int(2 * U)
for (x1, y1, x2, y2) in [(16, 2.5, 16, 8.5), (16, 23.5, 16, 29.5), (2.5, 16, 8.5, 16), (23.5, 16, 29.5, 16)]:
    d.line((x1 * U, y1 * U, x2 * U, y2 * U), fill=ACCENT, width=w)
    for (px, py) in ((x1, y1), (x2, y2)):                      # round caps
        d.ellipse((px * U - w / 2, py * U - w / 2, px * U + w / 2, py * U + w / 2), fill=ACCENT)
p = 3.6 * U
d.ellipse((c - p, c - p, c + p, c + p), fill=ACCENT)
# glint: the arc of radius 7.2 between (10.2,12.4) and (13.6,9.2), as angles clockwise from 3 o'clock
a1 = math.degrees(math.atan2(12.4 - 16, 10.2 - 16)) % 360
a2 = math.degrees(math.atan2(9.2 - 16, 13.6 - 16)) % 360
g = 7.2 * U
d.arc((c - g, c - g, c + g, c + g), a1, a2, fill=GLINT, width=int(1.8 * U))

out = os.path.join(os.path.dirname(__file__), "..", "apps", "desktop", "build", "icon.png")
img.resize((SIZE, SIZE), Image.LANCZOS).save(out)
print("wrote", os.path.normpath(out), SIZE, "x", SIZE)
