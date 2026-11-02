"""Copia para um PDF novo só as páginas pedidas (1-based, «-1» = a última): python _recortar_pdf.py entrada.pdf saida.pdf 1 -1"""
import sys

import pymupdf

src = pymupdf.open(sys.argv[1])
n = src.page_count
idx = []
for a in sys.argv[3:]:
    i = int(a)
    i = n if i == -1 else i
    if 1 <= i <= n and (i - 1) not in idx:
        idx.append(i - 1)
src.select(idx)
src.save(sys.argv[2], garbage=3, deflate=True)
print(len(idx))
