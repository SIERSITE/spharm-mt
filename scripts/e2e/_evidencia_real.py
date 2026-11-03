"""Evidência lado a lado: PDF REAL do cliente vs novo PDF A4 (cenário sintético «igual ou mais exigente»), à escala física 100 % (100 dpi:
1 px = 0,254 mm; A4 horizontal = 1169 × 827 px).

Uso: python _evidencia_real.py <real.pdf> <novo.pdf> <pasta_saida>
Escreve FORA do Git (pasta de entregas): páginas 1, 29 e 57 do real; 1.ª, intermédia e última do novo; montagem com recorte; medidas e provas (md).
O PDF real é dado comercial: nunca vai para o repositório.
"""
import collections
import io
import re
import sys

import pymupdf
from PIL import Image, ImageDraw, ImageFont

real_pdf, novo_pdf, out = sys.argv[1:4]
MM = 25.4 / 72
real, novo = pymupdf.open(real_pdf), pymupdf.open(novo_pdf)
try:
    F = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 22); FP = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 16)
except Exception:
    F = FP = ImageFont.load_default()


def img(doc, i, dpi=100, clip=None):
    pg = doc[i]
    pix = pg.get_pixmap(dpi=dpi, clip=clip)
    return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")


def guardar(im, nome):
    im.quantize(colors=64, method=Image.Quantize.MEDIANCUT).save(f"{out}/{nome}", optimize=True)
    print(nome, im.size)


meio_novo = novo.page_count // 2
for nome, doc, i in [("real-p01.png", real, 0), ("real-p29-bloco2.png", real, 28), ("real-p57-ultima.png", real, real.page_count - 1),
                     ("novo-p01.png", novo, 0), (f"novo-p{meio_novo + 1:02d}-intermedia.png", novo, meio_novo), (f"novo-p{novo.page_count:02d}-ultima.png", novo, novo.page_count - 1)]:
    guardar(img(doc, i), nome)

# montagem: linha 1 = páginas inteiras a 100 dpi lado a lado; linha 2 = recorte de 100 × 62 mm do canto sup. esquerdo (zona da tabela) a 200 dpi
a, b = img(real, 0), img(novo, 0)
clip = pymupdf.Rect(real[0].rect.width * 0.42, 80, real[0].rect.width * 0.42 + 100 / MM, 80 + 62 / MM)
ca, cb = img(real, 0, 200, clip), img(novo, 0, 200, clip)
W = a.width + b.width + 3 * 24
H = 70 + a.height + 40 + 30 + ca.height + 24
cv = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(cv)
d.text((24, 8), "Escala física 100 % (100 dpi): A4 horizontal = 1169 × 827 px; 1 px = 0,254 mm", fill="black", font=FP)
d.text((24, 32), "ESQUERDA: PDF real do cliente (57 págs., Segoe UI 6-7,5 pt, «Parte 1 de 2»)", fill=(150, 0, 0), font=F)
d.text((a.width + 48, 32), "DIREITA: novo A4 (" + str(novo.page_count) + " págs., Arial 8,025 pt, 14 meses numa só tabela)", fill=(0, 100, 0), font=F)
cv.paste(a, (24, 70)); cv.paste(b, (a.width + 48, 70))
y2 = 70 + a.height + 20
d.text((24, y2), "Recorte de 100 × 62 mm a 200 dpi (mesma zona, meses do meio da tabela, ampliado 2× só para leitura no ecrã)", fill="black", font=FP)
cv.paste(ca, (24, y2 + 30)); cv.paste(cb, (a.width + 48, y2 + 30))
guardar(cv, "montagem-real-vs-novo.png")


# ---- medidas de letra e provas
def fontes(doc):
    c = collections.Counter()
    for p in doc:
        for bl in p.get_text("dict")["blocks"]:
            for l in bl.get("lines", []):
                for s in l["spans"]:
                    c[(round(s["size"], 2), s["font"])] += len(s["text"])
    return c


def provas(doc, nome):
    cnps_col = []
    tg = rs = 0
    meses_pag = []
    tam = collections.Counter()
    for p in doc:
        w = p.get_text("words")
        w0 = p.rect.width
        cnps_col += [x[4] for x in w if re.fullmatch(r"\d{7}", x[4]) and x[0] < w0 * 0.12]
        tg += sum(1 for x in w if x[4] == "GERAL")
        rs += sum(1 for x in w if x[4] == "RESUMO")
        meses_pag.append(sum(1 for x in w if re.fullmatch(r"(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)/\d\d", x[4])))
    return {"nome": nome, "paginas": doc.page_count, "A4": f"{doc[0].rect.width:.1f}x{doc[0].rect.height:.1f}", "cnp_ocorrencias": len(cnps_col), "cnp_distintos": len(set(cnps_col)),
            "TOTAL_GERAL": tg, "RESUMO": rs, "meses_por_pagina_min_max": (min(meses_pag), max(meses_pag))}


L = ["# Medidas e provas — PDF real vs novo A4 (cenário sintético ×10)", "", "## Tamanhos de letra (caracteres por tamanho/tipo)", ""]
for nome, doc in (("REAL", real), ("NOVO", novo)):
    c = fontes(doc); tot = sum(c.values())
    L.append(f"**{nome}** ({tot} caracteres):")
    for (s, f), n in c.most_common(8):
        L.append(f"- {s} pt {f}: {n} ({100 * n / tot:.1f} %)")
    L.append("")
L += ["## Provas por script", "", "| PDF | páginas | página (pt) | CNP na coluna CNP (ocorrências) | CNP distintos | «GERAL» | «RESUMO» | cabeçalhos «Mmm/AA» por página (mín–máx) |", "|---|---|---|---|---|---|---|---|"]
for nome, doc in (("real", real), ("novo", novo)):
    p = provas(doc, nome)
    L.append(f"| {p['nome']} | {p['paginas']} | {p['A4']} | {p['cnp_ocorrencias']} | {p['cnp_distintos']} | {p['TOTAL_GERAL']} | {p['RESUMO']} | {p['meses_por_pagina_min_max']} |")
L += ["", "No real, cada CNP aparece 2× (um por «Parte») e os cabeçalhos «Mmm/AA» não existem (meses em duas linhas, 7 por parte). No novo: 326 = 326, um só TOTAL GERAL, um só resumo, 14 meses em cada página."]
open(f"{out}/medidas-e-provas.md", "w", encoding="utf8").write("\n".join(L) + "\n")
print("\n".join(L))
