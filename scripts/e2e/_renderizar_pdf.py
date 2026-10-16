"""
scripts/e2e/_renderizar_pdf.py

Renderiza as primeiras N páginas de um PDF para PNG, a cores e em tons de cinzento (prova de legibilidade a
preto e branco):  python _renderizar_pdf.py <pdf> <pasta> <prefixo> [paginas=2] [dpi=90]
Escreve <pasta>/<prefixo>-p<N>.png e <pasta>/<prefixo>-p<N>-cinzento.png e imprime o nº total de páginas.
"""
import os
import sys
import pymupdf

pdf, pasta, prefixo = sys.argv[1], sys.argv[2], sys.argv[3]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 2
dpi = int(sys.argv[5]) if len(sys.argv) > 5 else 90
os.makedirs(pasta, exist_ok=True)
doc = pymupdf.open(pdf)
for i in range(min(n, doc.page_count)):
    doc[i].get_pixmap(dpi=dpi).save(os.path.join(pasta, f"{prefixo}-p{i + 1}.png"))
    doc[i].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY).save(os.path.join(pasta, f"{prefixo}-p{i + 1}-cinzento.png"))
print(doc.page_count)
