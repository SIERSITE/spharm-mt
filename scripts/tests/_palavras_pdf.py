"""
scripts/tests/_palavras_pdf.py

Palavras de um PDF com geometria (PyMuPDF), em pontos:  python _palavras_pdf.py <pdf>
Imprime UMA linha JSON: {"paginas": [{"w": largura, "h": altura, "palavras": [[x0, y0, x1, y1, "texto"], ...]}, ...]}
Se for dado um 2.º/3.º argumento (<pasta> <prefixo> [dpi]) escreve também <pasta>/<prefixo>-p<N>.png de TODAS as páginas.
"""
import json
import os
import sys
import pymupdf

doc = pymupdf.open(sys.argv[1])
if len(sys.argv) > 3:
    dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 80
    os.makedirs(sys.argv[2], exist_ok=True)
    for i, p in enumerate(doc):
        p.get_pixmap(dpi=dpi).save(os.path.join(sys.argv[2], f"{sys.argv[3]}-p{i + 1}.png"))
out = []
for p in doc:
    ws = [[round(w[0], 2), round(w[1], 2), round(w[2], 2), round(w[3], 2), w[4]] for w in p.get_text("words")]
    out.append({"w": p.rect.width, "h": p.rect.height, "palavras": ws})
print(json.dumps({"paginas": out}, ensure_ascii=True))
