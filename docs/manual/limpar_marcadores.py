"""Corrige títulos duplicados que o Chromium por vezes escreve nos marcadores (ex.: «2 Dashboard2 Dashboard»)."""
import sys

import pymupdf

d = pymupdf.open(sys.argv[1])
toc = d.get_toc()
novo = []
for nivel, titulo, pagina in toc:
    t = titulo.strip()
    n = len(t)
    if n % 2 == 0 and t[: n // 2] == t[n // 2 :]:
        t = t[: n // 2]
    novo.append([nivel, t, pagina])
d.set_toc(novo)
d.saveIncr()
print(len(novo), "marcadores")
