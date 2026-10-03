"""Writes the selfie test images (task KYC-02): real JPEGs and PNGs, drawn
from shapes by Pillow, never a photo of anyone. Run from this directory:
`python3 make_fixtures.py` (Pillow 10 or later). The images are committed,
so the tests need no Python; this file says how they were made.

The backend checks a selfie by walking its structure (selfie-image.ts), so
the tests need images a real encoder wrote: a baseline JPEG, one with EXIF,
a progressive one, a greyscale one, and PNGs (RGB, RGBA with a text chunk,
and an interlaced one, written by hand below because Pillow does not write
interlaced PNGs; Pillow reads it back to prove it is valid).
"""
import struct
import zlib

from PIL import Image, ImageDraw, PngImagePlugin


def drawing(size, mode="RGB", speckle=False):
    w, h = size
    img = Image.new(mode, size, (200, 180, 150) if mode == "RGB" else (200, 180, 150, 255))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=(40 + y * 120 // h, 90, 160 - y * 80 // h))
    d.ellipse([w * 0.25, h * 0.15, w * 0.75, h * 0.75], fill=(210, 160, 120))
    d.ellipse([w * 0.37, h * 0.35, w * 0.45, h * 0.42], fill=(30, 30, 30))
    d.ellipse([w * 0.55, h * 0.35, w * 0.63, h * 0.42], fill=(30, 30, 30))
    d.polygon([(w * 0.5, h * 0.45), (w * 0.46, h * 0.55), (w * 0.54, h * 0.55)], fill=(180, 120, 90))
    d.arc([w * 0.4, h * 0.5, w * 0.6, h * 0.65], 20, 160, fill=(120, 40, 40), width=3)
    # Speckle, from a fixed sequence, so the PNGs do not shrink below 1 KB.
    seed = 7
    for _ in range(w * h // 6 if speckle else 0):
        seed = (seed * 1103515245 + 12345) % 2**31
        x, y = seed % w, (seed // w) % h
        d.point((x, y), fill=(seed % 256, (seed >> 8) % 256, (seed >> 16) % 256))
    return img


base = drawing((240, 320))
base.save("baseline.jpg", quality=80)
exif = Image.Exif()
exif[0x010F] = "KYC-02 test"  # Make
exif[0x0131] = "Pillow"  # Software
base.save("exif.jpg", quality=80, exif=exif.tobytes())
base.save("progressive.jpg", quality=80, progressive=True)
base.convert("L").save("gray.jpg", quality=80)

small = drawing((72, 96), speckle=True)
small.save("rgb.png", optimize=True)
info = PngImagePlugin.PngInfo()
info.add_text("Comment", "KYC-02 test image")
small.convert("RGBA").save("rgba-text.png", pnginfo=info)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def interlaced_png(img, path):
    img = img.convert("RGB")
    w, h = img.size
    px = img.load()
    raw = b""
    for x0, y0, dx, dy in [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]:
        xs = range(x0, w, dx)
        if not xs:
            continue
        for y in range(y0, h, dy):
            raw += b"\x00" + b"".join(bytes(px[x, y]) for x in xs)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 1)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)
    back = Image.open(path)
    back.load()
    assert back.info.get("interlace") == 1 and back.convert("RGB").tobytes() == img.tobytes()


interlaced_png(drawing((61, 47), speckle=True), "interlaced.png")

for name in ["baseline.jpg", "exif.jpg", "progressive.jpg", "gray.jpg", "rgb.png", "rgba-text.png", "interlaced.png"]:
    Image.open(name).load()
