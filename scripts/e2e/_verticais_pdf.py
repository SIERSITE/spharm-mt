"""Linhas VERTICAIS contínuas de um PDF do mapa de Vendas — medidas em PIXÉIS (página renderizada), não no HTML.

Para cada página devolve (JSON, última linha do stdout):
  verticais: [{x0, x1, largura, y0, y1, cinzento, integral}]  filetes verticais contínuos (≥ ~58pt de altura), em pt; `cinzento` = a MEDIANA do cinzento ao longo da
             linha (0 = preto, 255 = branco; a mediana ignora os cruzamentos com os filetes horizontais);
  cabecalho: palavras do cabeçalho da tabela (texto, x0, x1, y0, y1) — para verificar que cada mês fica ENTRE dois filetes;
  cnps / totais: as mesmas âncoras de _separadores_pdf.py (y0/y1) para limitar o filete ao conteúdo da tabela.

Renderiza em escala de cinzentos a 150 dpi. Um píxel conta como «linha» se ≤ 225 (a cinzento muito claro, que se vê no papel).
Os fundos coloridos do relatório (tom ≥ 228) não entram; para uma contagem estrita gera-se o PDF sem fundos.
Uso: python _verticais_pdf.py ficheiro.pdf
"""
import json
import re
import sys

import fitz

DPI = 150
Z = DPI / 72
LIMIAR = 226
ALTURA_MIN_PX = int(58 * Z)  # ≥ 58pt: exclui qualquer glifo
TABELA = bytes(1 if v <= LIMIAR else 0 for v in range(256))
MESES = {"Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"}


def analisar(caminho):
    doc = fitz.open(caminho)
    paginas = []
    for page in doc:
        pix = page.get_pixmap(matrix=fitz.Matrix(Z, Z), colorspace=fitz.csGRAY, alpha=False)
        w, h = pix.width, pix.height
        amostra = pix.samples
        x0, x1 = int(w * 0.03), int(w * 0.97)
        achadas = []  # (x, y0, y1, minimo)
        for x in range(x0, x1):
            col = amostra[x::w]
            marca = col.translate(TABELA)
            marca = re.sub(rb"\x01\x00{1,3}(?=\x01)", lambda m: b"\x01" * len(m.group()), marca)
            for m in re.finditer(b"\x01+", marca):
                if m.end() - m.start() >= ALTURA_MIN_PX:
                    seg = col[m.start():m.end()]
                    achadas.append((x, m.start(), m.end(), sorted(seg)[len(seg) // 2]))
        # agrupa pixéis de colunas vizinhas (uma linha de 0,75pt cai em 2 píxeis) e une os troços com falhas ≤ 3px
        grupos = []  # {x0p, x1p, runs:[(a,b)], mn}
        for (x, a, b, mn) in achadas:
            g = grupos[-1] if grupos else None
            if g and x - g["x1p"] <= 1 and any(a <= rb + 3 and b >= ra - 3 for (ra, rb) in g["runs"]):
                g["x1p"] = x
                g["runs"].append((a, b))
                g["mn"] = min(g["mn"], mn)
            else:
                grupos.append({"x0p": x, "x1p": x, "runs": [(a, b)], "mn": mn})
        verticais = []
        for g in grupos:
            runs = sorted(g["runs"])
            ini, fim = runs[0]
            for (ra, rb) in runs[1:]:
                fim = max(fim, rb)
            # integral da escuridão ACIMA do fundo vizinho (3px de cada lado), mediana ao longo da linha: a largura real do filete
            # (uma linha de 0,75pt cai a cavalo de 2-3 píxeis; contar píxeis escuros inflaciona-a)
            xa, xb = max(g["x0p"] - 3, 0), min(g["x1p"] + 3, w - 1)
            amostras = []
            for y in range(ini + 2, fim - 2, 3):
                lin = y * w
                base = (amostra[lin + xa] + amostra[lin + xb]) / 2
                amostras.append(sum(max(0.0, base - amostra[lin + x]) for x in range(xa + 1, xb)))
            amostras.sort()
            integral = amostras[len(amostras) // 2] if amostras else 0.0
            verticais.append({"x0": g["x0p"] / Z, "x1": (g["x1p"] + 1) / Z, "largura": (g["x1p"] - g["x0p"] + 1) / Z, "y0": ini / Z, "y1": fim / Z, "cinzento": g["mn"], "integral": integral / Z})
        palavras = page.get_text("words")
        largura = page.rect.width
        cabecalho = [{"texto": p[4], "x0": p[0], "x1": p[2], "y0": p[1], "y1": p[3]} for p in palavras if p[4] in MESES and p[1] < page.rect.height * 0.35]
        cnps = [{"y0": p[1], "y1": p[3], "texto": p[4]} for p in palavras if len(p[4]) == 7 and p[4].isdigit() and p[0] < largura * 0.2]
        cnps.sort(key=lambda c: c["y0"])
        ancora_cnp = [{"y0": p[1], "y1": p[3]} for p in palavras if p[4] == "CNP" and p[0] < largura * 0.2 and p[1] < page.rect.height * 0.35]
        totais = [{"y0": p[1], "y1": p[3], "texto": p[4]} for p in palavras if p[4] in ("TOTAL", "ARTIGO", "GERAL")]
        paginas.append({"largura": largura, "altura": page.rect.height, "verticais": verticais, "cabecalho": cabecalho, "cnps": cnps, "cabCnp": ancora_cnp, "totais": totais})
    return paginas


if __name__ == "__main__":
    print(json.dumps(analisar(sys.argv[1])))
