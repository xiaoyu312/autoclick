"""Deterministic original AutoClick icons; Python standard library only."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

def png(size):
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            dx, dy = (x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5
            radius = math.hypot(dx, dy)
            inside = radius < 0.46
            ring = 0.22 < radius < 0.31 and not (dx > 0 and abs(dy) < 0.13)
            dot = math.hypot(dx - 0.19, dy) < 0.055
            color = (255, 255, 255, 255) if ring or dot else ((31, 96, 90, 255) if inside else (0, 0, 0, 0))
            pixels.extend(color)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(pixels), 9)) + chunk(b"IEND", b"")

def main():
    targets = [("extension/icons/icon16.png", 16), ("extension/icons/icon48.png", 48),
               ("extension/icons/icon128.png", 128), ("desktop/src/assets/tray-icon.png", 32)]
    for relative, size in targets:
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(png(size))
    print(f"Generated {len(targets)} original deterministic icons.")

if __name__ == "__main__":
    main()
