"""
scripts/e2e/_palavras_pdf.py

Lê um PDF (PyMuPDF) e imprime UMA linha JSON com, por página, as palavras e as suas caixas
(x0, y0, x1, y1), a luminância média (0 = preto, 255 = branco) sob cada palavra numa renderização a
CINZENTOS (prova de legibilidade a preto e branco) e a largura/altura da página.

  {"paginas": [{"w": .., "h": .., "palavras": [[x0,y0,x1,y1,"texto",cinza], ...]}, ...]}
"""
import json
import sys
import pymupdf

doc = pymupdf.open(sys.argv[1])
saida = []
for p in doc:
    pix = p.get_pixmap(dpi=100, colorspace=pymupdf.csGRAY)
    esc = 100 / 72
    amostras = pix.samples
    w, h, n = pix.width, pix.height, pix.n
    palavras = []
    for x0, y0, x1, y1, t, *_ in p.get_text("words"):
        # luminância média na caixa da palavra
        ix0, iy0 = max(0, int(x0 * esc)), max(0, int(y0 * esc))
        ix1, iy1 = min(w, int(x1 * esc) + 1), min(h, int(y1 * esc) + 1)
        soma = cont = 0
        for yy in range(iy0, iy1):
            linha = yy * w * n
            for xx in range(ix0, ix1):
                soma += amostras[linha + xx * n]
                cont += 1
        palavras.append([round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1), t, round(soma / cont) if cont else 255])
    saida.append({"w": round(p.rect.width, 1), "h": round(p.rect.height, 1), "palavras": palavras})
print(json.dumps({"paginas": saida}, ensure_ascii=True))
