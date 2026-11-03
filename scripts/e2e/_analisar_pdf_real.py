"""Análise AGREGADA do PDF real do cliente (nunca copia CNP, descrições ou nomes para a saída): tamanhos de letra, distribuição das linhas,
quantis dos valores mensais/totais/stock, nº de caracteres e de linhas das descrições, artigos por página.

Uso: python _analisar_pdf_real.py <pdf> <saida.json>
O PDF real é dado comercial: fica FORA do Git. Só os números agregados vão para notes/vendas-pdf-real-analise.md.
"""
import collections
import json
import re
import statistics
import sys

import pymupdf

doc = pymupdf.open(sys.argv[1])
FARM = ("Segurado", "Silveirense")


def num(s):
    s = s.replace("\xa0", "").replace(" ", "").replace("€", "").strip()
    if s in ("·", "—", "-", ""):
        return None
    try:
        return float(s.replace(".", "").replace(",", "."))
    except ValueError:
        return None


def q(v, ps=(0.5, 0.9, 0.99, 1.0)):
    v = sorted(v)
    if not v:
        return {}
    return {f"p{int(p * 100)}": v[min(len(v) - 1, int(p * (len(v) - 1) + 0.5))] for p in ps}


def linhas(page):
    ws = sorted(page.get_text("words"), key=lambda w: (round(w[1]), w[0]))
    out = []
    for w in ws:
        if out and abs(out[-1]["y"] - w[1]) <= 2.2:
            out[-1]["w"].append(w)
        else:
            out.append({"y": w[1], "w": [w]})
    for l in out:
        l["w"].sort(key=lambda w: w[0])
    return out


# --- fontes (todas as páginas): nº de caracteres por (tamanho, tipo de letra)
fs = collections.Counter()
for p in doc:
    for b in p.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                fs[(round(s["size"], 2), s["font"])] += len(s["text"])
total_chars = sum(fs.values())

# --- colunas pelo cabeçalho da pág. 1
p0 = doc[0]
w0 = p0.get_text("words")
cnp0 = [w for w in w0 if w[4] == "CNP" and w[0] < 60][0]
x_desc = [w for w in w0 if w[4].startswith("Descri") and abs(w[1] - cnp0[1]) < 3][0][0]
x_farm = [w for w in w0 if w[4].startswith("Farm") and abs(w[1] - cnp0[1]) < 3][0][0]

meio = next(i for i in range(len(doc)) if i > 0 and "Parte" in doc[i].get_text() and "2 de 2" in doc[i].get_text())
blocos = {1: range(0, meio), 2: range(meio, len(doc))}
meses_farm, meses_total, stock_farm, stock_total, totp_farm, totp_total = [], [], [], [], [], []
pvps, custos, ceros = [], [], [0, 0]
desc_chars, desc_lines = [], []
artigos_pagina, linhas_pagina = [], []
cnps_vistos = {}
for b, pr in blocos.items():
    for pi in pr:
        ls = linhas(doc[pi])
        cnps = [(l["y"], [w for w in l["w"] if re.fullmatch(r"\d{7}", w[4]) and w[0] < x_desc - 5]) for l in ls]
        cnps = [(y, c[0][4]) for y, c in cnps if c]
        if b == 1:
            artigos_pagina.append(len(cnps))
        nrows = 0
        ys = [y for y, _ in cnps] + [10 ** 6]
        for (y, cnp), yn in zip(cnps, ys[1:]):
            dt = []
            for l in ls:
                if y - 3 <= l["y"] < yn - 2:
                    dt += [w for w in l["w"] if x_desc - 2 <= w[0] < x_farm - 2]
            if b == 1 and cnp not in cnps_vistos:
                cnps_vistos[cnp] = 1
                desc_chars.append(len(" ".join(w[4] for w in sorted(dt, key=lambda w: (round(w[1] / 3), w[0])))))
                desc_lines.append(len({round(w[1] / 3) for w in dt}))
        for l in ls:
            tks = [w[4] for w in l["w"]]
            idx, kind = None, None
            for i, t in enumerate(tks):
                if t in FARM:
                    idx, kind = i, "farm"; break
                if t == "TOTAL" and i + 1 < len(tks) and tks[i + 1] == "ARTIGO":
                    idx, kind = i + 1, "total"; break
            if idx is None:
                continue
            nrows += 1
            vals = [num(t) for t in tks[idx + 1:] if t != "€"]
            body = vals[2:] if kind == "farm" else vals[2:]
            if kind == "farm":
                if vals[0] is not None: pvps.append(vals[0])
                if vals[1] is not None: custos.append(vals[1])
            months = body[:7]
            tot = body[7:8]
            if b == 2:
                totp = body[8:9]; stock = body[9:10]
            else:
                totp = []; stock = body[8:9]
            for m in l["w"]:
                pass
            for m in months:
                v = 0 if m is None else m
                (meses_farm if kind == "farm" else meses_total).append(v)
                if kind == "farm":
                    ceros[0 if v == 0 else 1] += 1
            for v in stock:
                if v is not None: (stock_farm if kind == "farm" else stock_total).append(v)
            for v in totp:
                if v is not None: (totp_farm if kind == "farm" else totp_total).append(v)
        linhas_pagina.append(nrows)

nz_farm = [v for v in meses_farm if v != 0]
saida = {
    "paginas": len(doc), "pagina_bloco2": meio + 1, "tamanho_pagina_pt": [round(p0.rect.width, 1), round(p0.rect.height, 1)],
    "fontes_chars": {f"{s}pt {f}": n for (s, f), n in fs.most_common(8)}, "total_chars": total_chars,
    "artigos": len(cnps_vistos), "artigos_por_pagina_bloco1": q(artigos_pagina, (0.5, 1.0)), "linhas_por_pagina": q(linhas_pagina, (0.5, 1.0)),
    "pvp": q(pvps), "custo_unit": q(custos),
    "celulas_mensais_farmacia": {"n": len(meses_farm), "zeros": ceros[0], "nao_zeros": ceros[1], "quantis_nao_zero": q(nz_farm), "min": min(meses_farm), "max": max(meses_farm)},
    "celulas_mensais_total_artigo": {"n": len(meses_total), "quantis": q([v for v in meses_total if v != 0]), "max": max(meses_total)},
    "stock_farm": q(stock_farm), "stock_total_artigo": q(stock_total),
    "total_periodo_farm": q(totp_farm), "total_periodo_artigo": q(totp_total),
    "descricao_chars": {"mediana": statistics.median(desc_chars), **q(desc_chars, (0.9, 1.0))},
    "descricao_linhas": dict(collections.Counter(desc_lines)),
}
json.dump(saida, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, indent=1)
print(json.dumps(saida, ensure_ascii=False, indent=1))
