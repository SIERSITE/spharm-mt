"""Analisa um PDF do mapa de Vendas e devolve (JSON, última linha do stdout) o que está DESENHADO em cada página:

  · `separadores`: filetes horizontais contínuos (≥ 80 % da largura útil) da cor do separador entre artigos (#8493a6), com y (pt),
    espessura (pt), cor média e, em escala de cinzentos, o cinzento do filete e o do fundo acima/abaixo;
  · `cabecalho`: o filete escuro do cabeçalho da tabela (#334155);
  · `cnps`: as palavras de 7 dígitos na 1.ª coluna (um por artigo, no seu início) com y0/y1 (pt);
  · `palavras`: (y0, y1, texto) de «TOTAL»/«ARTIGO»/«GERAL» para localizar as linhas de total;
  · `largura`, `altura`, `maxX1`: página e extensão do texto (nada cortado à direita).

É uma medição sobre PIXÉIS (a página renderizada a 200 dpi) e sobre as palavras do PDF — não sobre o HTML.
Uso: python _separadores_pdf.py ficheiro.pdf
"""
import json
import sys

import fitz

DPI = 200
Z = DPI / 72
ALVO_SEP = (132, 147, 166)  # #8493a6
TOL_SEP = 40


def analisar(caminho):
    doc = fitz.open(caminho)
    paginas = []
    for page in doc:
        cor = page.get_pixmap(matrix=fitz.Matrix(Z, Z), alpha=False)
        cinza = page.get_pixmap(matrix=fitz.Matrix(Z, Z), colorspace=fitz.csGRAY, alpha=False)
        w, h, n = cor.width, cor.height, cor.n
        amostra = cor.samples
        x0, x1 = int(w * 0.05), int(w * 0.95)
        passo = 2
        total = len(range(x0, x1, passo))
        sep_rows, escuras = [], []
        for y in range(h):
            base = y * w * n
            c_sep = c_esc = 0
            for x in range(x0, x1, passo):
                i = base + x * n
                r, g, b = amostra[i], amostra[i + 1], amostra[i + 2]
                if abs(r - ALVO_SEP[0]) <= TOL_SEP and abs(g - ALVO_SEP[1]) <= TOL_SEP and abs(b - ALVO_SEP[2]) <= TOL_SEP and not (r < 100 and g < 110):
                    c_sep += 1
                elif r < 95 and g < 105 and b < 120:
                    c_esc += 1
            if c_sep / total >= 0.8:
                sep_rows.append(y)
            if c_esc / total >= 0.8:
                escuras.append(y)

        def runs(rows):
            out, ini, ant = [], None, None
            for y in rows:
                if ini is None:
                    ini = ant = y
                elif y == ant + 1:
                    ant = y
                else:
                    out.append((ini, ant))
                    ini = ant = y
            if ini is not None:
                out.append((ini, ant))
            return out

        seps = []
        for (a, b) in runs(sep_rows):
            meio = (a + b) // 2
            gris = cinza.samples
            def g_at(y):
                y = max(0, min(h - 1, y))
                linha = [gris[y * w + x] for x in range(x0, x1, 7)]
                linha.sort()
                return linha[len(linha) // 2]
            seps.append({
                "y0": a / Z, "y1": (b + 1) / Z, "espessura": (b - a + 1) / Z,
                "cinzento": g_at(meio), "fundoAcima": g_at(a - 6), "fundoAbaixo": g_at(b + 6),
            })
        cab = [{"y0": a / Z, "y1": (b + 1) / Z, "espessura": (b - a + 1) / Z} for (a, b) in runs(escuras)]
        palavras = page.get_text("words")
        largura = page.rect.width
        cnps = [{"y0": p[1], "y1": p[3], "x0": p[0], "texto": p[4]} for p in palavras if len(p[4]) == 7 and p[4].isdigit() and p[0] < largura * 0.2]
        cnps.sort(key=lambda c: c["y0"])
        totais = [{"y0": p[1], "y1": p[3], "texto": p[4]} for p in palavras if p[4] in ("TOTAL", "ARTIGO", "GERAL")]
        paginas.append({
            "largura": largura, "altura": page.rect.height, "separadores": seps, "cabecalho": cab, "cnps": cnps, "totais": totais,
            "maxX1": max((p[2] for p in palavras), default=0),
        })
    return paginas


if __name__ == "__main__":
    print(json.dumps(analisar(sys.argv[1])))
