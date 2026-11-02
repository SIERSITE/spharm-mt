"""Extrai de um PDF do Mapa de Vendas o que a prova da «tabela única» precisa (JSON, última linha do stdout):

  paginas: [{w, h, tokens: [[x0, y0, x1, y1, tamanho_pt, texto], ...]}]

Um token é uma PALAVRA tal como está desenhada (o espaço de milhares dos números e o espaço antes de «€» separam palavras: «12 345,67 €»
são 3 tokens contíguos; quem analisa junta os tokens da mesma célula). `tamanho_pt` é o tamanho real da fonte em pt, lido do span que
contém a palavra. Rápido (get_text «words» + «dict»), ao contrário de percorrer os carateres.

Uso: python _tabela_unica_pdf.py ficheiro.pdf
"""
import json
import sys

import pymupdf

doc = pymupdf.open(sys.argv[1])
saida = []
for p in doc:
    # spans por (bloco, linha) — a numeração é a mesma de get_text("words")
    spans = {}
    for bi, bloco in enumerate(p.get_text("dict")["blocks"]):
        for li, linha in enumerate(bloco.get("lines", [])):
            spans[(bi, li)] = [(s["bbox"][0], s["bbox"][2], s["size"]) for s in linha["spans"]]
    tokens = []
    for w in p.get_text("words"):
        x0, y0, x1, y1, texto, bi, li = w[0], w[1], w[2], w[3], w[4], w[5], w[6]
        cx = (x0 + x1) / 2
        tam = 0.0
        for (a, b, s) in spans.get((bi, li), []):
            if a - 0.5 <= cx <= b + 0.5:
                tam = s
                break
        if tam == 0.0 and spans.get((bi, li)):
            tam = spans[(bi, li)][0][2]
        tokens.append([round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2), round(tam, 2), texto])
    saida.append({"w": round(p.rect.width, 1), "h": round(p.rect.height, 1), "tokens": tokens})
print(json.dumps({"paginas": saida}, ensure_ascii=True))
