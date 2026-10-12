"""
scripts/investigacao/renderizar-pdf.py

Rasteriza um PDF (PyMuPDF) para PNG a cores, em escala de cinzentos e em
preto-e-branco puro (limiar 160 — o pior caso de uma impressora monocromática
sem meios-tons), para avaliar a hierarquia visual do Relatório de Vendas.

    python scripts/investigacao/renderizar-pdf.py <vendas.pdf> <pasta-saida> [dpi]
"""
import sys, os
import pymupdf
from PIL import Image

pdf, out = sys.argv[1], sys.argv[2]
dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 110
os.makedirs(out, exist_ok=True)
doc = pymupdf.open(pdf)
print(f"{len(doc)} páginas")
for i, page in enumerate(doc, 1):
    pix = page.get_pixmap(dpi=dpi)
    cor = os.path.join(out, f"p{i}-cor.png")
    pix.save(cor)
    img = Image.open(cor).convert("RGB")
    g = img.convert("L")
    g.save(os.path.join(out, f"p{i}-cinza.png"))
    g.point(lambda v: 255 if v > 160 else 0).convert("1").save(os.path.join(out, f"p{i}-pb.png"))
