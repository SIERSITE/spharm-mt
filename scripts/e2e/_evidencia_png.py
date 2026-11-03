"""Gera PNGs pequenos (quantizados, ≤ ~300 KB) de uma página do PDF: python _evidencia_png.py <pdf> <saida.png> <pagina 1-based | -1 última | 0 intermédia> [dpi=75] [cores=48]"""
import io
import sys

import pymupdf
from PIL import Image

pdf, saida, pag = sys.argv[1], sys.argv[2], int(sys.argv[3])
dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 75
cores = int(sys.argv[5]) if len(sys.argv) > 5 else 48
doc = pymupdf.open(pdf)
n = doc.page_count
i = n // 2 if pag == 0 else (n - 1 if pag == -1 else pag - 1)
pix = doc[max(0, min(n - 1, i))].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY if cores < 0 else pymupdf.csRGB)
img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB").quantize(colors=abs(cores), method=Image.Quantize.MEDIANCUT)
img.save(saida, optimize=True)
print(f"{saida}: pág {i + 1}/{n}, {img.size[0]}x{img.size[1]}")
