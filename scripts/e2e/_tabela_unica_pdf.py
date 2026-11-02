"""Extrai de um PDF do Mapa de Vendas o que a prova da «tabela única» precisa (JSON, última linha do stdout):

  paginas: [{w, h, tokens: [[x0, y0, x1, y1, tamanho_pt, texto], ...]}]

Um token é o texto de UMA célula/palavra tal como está desenhado: o espaço de milhares dos números (U+00A0) e o espaço antes
de «€» ficam DENTRO do token («12 345,67 €» é um token); separam-se tokens nos espaços normais e em folgas maiores do que meio
corpo de letra (células vizinhas). `tamanho_pt` é o tamanho real da fonte em pt.

Uso: python _tabela_unica_pdf.py ficheiro.pdf
"""
import json
import sys

import pymupdf

doc = pymupdf.open(sys.argv[1])
saida = []
for p in doc:
    tokens = []
    for bloco in p.get_text("rawdict")["blocks"]:
        for linha in bloco.get("lines", []):
            for sp in linha["spans"]:
                tam = sp["size"]
                atual = []

                def fechar():
                    global atual
                    if atual:
                        x0 = min(c["bbox"][0] for c in atual)
                        y0 = min(c["bbox"][1] for c in atual)
                        x1 = max(c["bbox"][2] for c in atual)
                        y1 = max(c["bbox"][3] for c in atual)
                        tokens.append([round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2), round(tam, 2), "".join(c["c"] for c in atual)])
                    atual = []

                for c in sp["chars"]:
                    if c["c"] == " ":
                        fechar()
                        continue
                    if atual and c["bbox"][0] - atual[-1]["bbox"][2] > tam * 0.5:
                        fechar()
                    atual.append(c)
                fechar()
    saida.append({"w": round(p.rect.width, 1), "h": round(p.rect.height, 1), "tokens": tokens})
print(json.dumps({"paginas": saida}, ensure_ascii=True))
