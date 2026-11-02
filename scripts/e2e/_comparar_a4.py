"""Comparação visual à MESMA ESCALA FÍSICA do Mapa de Vendas: A) PDF atual (a012428, blocos, A4), B) solução A3 rejeitada (4d4ef19),
C) A4 horizontal, tabela única, 8 pt (HEAD).

Uso: python _comparar_a4.py A.pdf B.pdf C.pdf <pasta_saida>

Escreve em <pasta_saida>:
  montagem-comparacao-escala-fisica.png   linha 1: a 1.ª página de A, B e C ao MESMO DPI (50) — o A3 aparece maior; linha 2: o recorte de
                                           297 × 210 mm do canto superior esquerdo de cada uma, a 100 dpi (o tamanho físico da letra em papel);
  comparacao-A-a012428-p1.png / comparacao-B-A3-p1.png / comparacao-C-A4-p1.png   1.ª página de cada (75 dpi);
  medidas-comparacao.md                    tamanhos de letra (pt) medidos nas spans do PDF, altura do glifo dos dígitos (mm) e nº de páginas.
As medidas leem a 1.ª página e uma página do meio (cabeçalho + corpo) de cada PDF.
"""
import io
import json
import statistics
import sys
import re

import pymupdf
from PIL import Image, ImageDraw, ImageFont

a_pdf, b_pdf, c_pdf, out = sys.argv[1:5]
ROT = [("A", "A · PDF atual (a012428): blocos temporais, A4", a_pdf), ("B", "B · solução A3 automática (4d4ef19) — rejeitada", b_pdf), ("C", "C · NOVA: A4 horizontal, tabela única (corpo e cabeçalhos 8,025 pt)", c_pdf)]
MM = 25.4 / 72
try:
    FONTE = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 22)
    FONTE_P = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 16)
except Exception:  # pragma: no cover
    FONTE = FONTE_P = ImageFont.load_default()


def render(doc, i, dpi, clip_mm=None):
    pg = doc[i]
    clip = None
    if clip_mm:
        clip = pymupdf.Rect(0, 0, clip_mm[0] / MM, clip_mm[1] / MM) & pg.rect
    pix = pg.get_pixmap(dpi=dpi, clip=clip)
    return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")


def tokens(page):
    """Palavras com o tamanho/tipo da span que as contém (por geometria: a numeração bloco/linha de «words» e «dict» difere nos PDFs com imagens)."""
    spans = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                spans.append((s["bbox"][0], s["bbox"][1], s["bbox"][2], s["bbox"][3], s["size"], s["bbox"][3] - s["bbox"][1], s["font"]))
    out_ = []
    for w in page.get_text("words"):
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        sp = next((s for s in spans if s[0] - 0.6 <= cx <= s[2] + 0.6 and s[1] - 0.6 <= cy <= s[3] + 0.6), None)
        if sp:
            out_.append((w[0], w[1], w[2], w[3], w[4], sp[4], sp[5], sp[6]))
    return out_


def categorias(page):
    w = page.rect.width
    t = tokens(page)
    cnps = [x for x in t if re.fullmatch(r"\d{7}", x[4]) and x[0] < 0.2 * w]
    if not cnps:
        return {}
    y_cab = min(c[1] for c in cnps) - 4
    desc = [x for x in t if re.fullmatch(r"[A-Z][A-Z0-9/+,.%-]{3,}", x[4]) and 0.03 * w < x[0] < 0.35 * w and x[1] > y_cab and x[4] not in ("TOTAL", "ARTIGO", "GERAL")]
    meses = [x for x in t if (re.fullmatch(r"-?\d{1,3}", x[4]) or x[4] == "·") and x[0] > 0.45 * w and x[1] > y_cab]
    cab = [x for x in t if x[1] < y_cab + 2 and x[1] > y_cab - 40 and x[0] > 0.3 * w and re.search(r"[A-Za-z]", x[4])]
    return {"CNP": cnps, "Descrição": desc, "Valores mensais": meses, "Cabeçalhos (meses/total/stock)": cab}


def medidas(pdf):
    doc = pymupdf.open(pdf)
    n = doc.page_count
    paginas = sorted({0, n // 2})
    acum = {}
    for i in paginas:
        for k, v in categorias(doc[i]).items():
            acum.setdefault(k, []).extend(v)
    res = {}
    for k, v in acum.items():
        if not v:
            continue
        tam = statistics.median([x[5] for x in v])
        alt = statistics.median([x[6] for x in v])
        res[k] = {"n": len(v), "size_pt": round(tam, 2), "bbox_pt": round(alt, 2), "digito_mm": round(tam * 0.716 * MM, 3), "fonte": v[0][7]}
    p = doc[0].rect
    return {"paginas": n, "largura_pt": round(p.width, 1), "altura_pt": round(p.height, 1), "largura_mm": round(p.width * MM, 1), "altura_mm": round(p.height * MM, 1), "categorias": res}


docs = {k: pymupdf.open(f) for k, _, f in ROT}
metr = {k: medidas(f) for k, _, f in ROT}

# páginas individuais (75 dpi)
nomes = {"A": "comparacao-A-a012428-p1.png", "B": "comparacao-B-A3-p1.png", "C": "comparacao-C-A4-p1.png"}
for k, _, _ in ROT:
    render(docs[k], 0, 75).quantize(colors=48, method=Image.Quantize.MEDIANCUT).save(f"{out}/{nomes[k]}", optimize=True)

# montagem: linha 1 (páginas inteiras a 50 dpi) e linha 2 (recortes 297×210 mm a 100 dpi)
pad, topo = 24, 44
l1 = [render(docs[k], 0, 50) for k, _, _ in ROT]
l2 = [render(docs[k], 0, 100, clip_mm=(297, 210)) for k, _, _ in ROT]
larg = max(sum(i.width for i in l1) + pad * 4, sum(i.width for i in l2) + pad * 4)
alt = topo + max(i.height for i in l1) + 30 + topo + max(i.height for i in l2) + pad
canvas = Image.new("RGB", (larg, alt), (255, 255, 255))
d = ImageDraw.Draw(canvas)
d.text((pad, 6), "Linha 1 — 1.ª página de cada PDF ao MESMO DPI (50): o A3 (B) aparece maior que o A4 (A, C)", fill=(0, 0, 0), font=FONTE_P)
x = pad
for (k, rot, _), im in zip(ROT, l1):
    d.text((x, 24), f"{rot}  [{metr[k]['paginas']} pág.; {metr[k]['largura_mm']}×{metr[k]['altura_mm']} mm]", fill=(150, 0, 0), font=FONTE_P)
    canvas.paste(im, (x, topo))
    d.rectangle([x - 1, topo - 1, x + im.width, topo + im.height], outline=(120, 120, 120))
    x += im.width + pad
y2 = topo + max(i.height for i in l1) + 30
d.text((pad, y2 - 24), "Linha 2 — recorte de 297 × 210 mm do canto superior esquerdo de cada página, a 100 dpi (tamanho físico da letra no papel)", fill=(0, 0, 0), font=FONTE_P)
x = pad
for (k, rot, _), im in zip(ROT, l2):
    canvas.paste(im, (x, y2 + 20))
    d.rectangle([x - 1, y2 + 19, x + im.width, y2 + 20 + im.height], outline=(120, 120, 120))
    x += im.width + pad
canvas.quantize(colors=32, method=Image.Quantize.MEDIANCUT).save(f"{out}/montagem-comparacao-escala-fisica.png", optimize=True)

# medidas
linhas = ["# Medidas da comparação A / B / C (mesmos dados sintéticos, 14 meses, 326 artigos)", "",
          "Tamanho de letra lido das spans do PDF (PyMuPDF); `dígito (mm)` = altura de um algarismo = tamanho × 0,716 (Arial) em mm; `caixa (pt)` = altura da caixa da span.", ""]
linhas.append("| PDF | páginas | papel (mm) | categoria | n | tamanho (pt) | caixa (pt) | dígito (mm) | tipo de letra |")
linhas.append("|---|---|---|---|---|---|---|---|---|")
for k, rot, _ in ROT:
    m = metr[k]
    for cat, v in m["categorias"].items():
        linhas.append(f"| {rot} | {m['paginas']} | {m['largura_mm']} × {m['altura_mm']} | {cat} | {v['n']} | {v['size_pt']} | {v['bbox_pt']} | {v['digito_mm']} | {v['fonte']} |")
open(f"{out}/medidas-comparacao.md", "w", encoding="utf8").write("\n".join(linhas) + "\n")
print(json.dumps(metr, ensure_ascii=False))
