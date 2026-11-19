"""Validação do PDF: índice, marcadores, ligações internas, texto pesquisável, termos proibidos e resolução das imagens.
   python -X utf8 validar_pdf.py SPharmMT-Manual-v1.0.pdf"""
import re
import sys

import pymupdf

d = pymupdf.open(sys.argv[1])
ok = True
def rel(c, msg):
    global ok
    ok = ok and c
    print(("[OK]    " if c else "[FALHA] ") + msg)

horiz = sum(1 for p in d if p.rect.width > p.rect.height)
rel(len(d) <= 50, f"{len(d)} páginas, {horiz} horizontais (A4 vertical com pranchas horizontais pontuais)")
toc = d.get_toc()
caps = [t for t in toc if t[0] == 2 and re.match(r"^\d+ ", t[1])]
rel(len(caps) == 15, f"marcadores laterais: {len(toc)} no total, {len(caps)} capítulos numerados")
rel(all(t[1] == t[1].strip() and not (len(t[1]) % 2 == 0 and t[1][: len(t[1]) // 2] == t[1][len(t[1]) // 2 :]) for t in toc), "títulos dos marcadores sem duplicações")
links = [(i, l) for i, p in enumerate(d) for l in p.get_links()]
rel(len(links) > 0 and all(l.get("page", -1) >= 0 for _, l in links), f"{len(links)} ligações internas, todas com destino válido")
idx = [(l["nameddest"], l["page"] + 1) for l in d[1].get_links()]
paginas = {t[1].split(" ", 1)[0]: t[2] for t in caps}
rel(len(idx) == 15 and all(paginas.get(n.replace("cap-", "")) == p for n, p in idx), "cada entrada do índice leva à página do capítulo respetivo")
txt1 = d[1].get_text()
imp = {m[0]: int(m[1]) for m in re.findall(r"^(\d+)\n.*\n(\d+)$", txt1, re.M)} if False else None
refs = [l for i, l in links if i >= 2 and l["nameddest"].startswith("cap-")]
rel(len(refs) >= 15, f"{len(refs)} referências «ver capítulo N» no corpo do texto são ligações internas")
txt = "\n".join(p.get_text() for p in d)
rel("Credenciais inválidas" in txt and len(txt) > 20000, f"texto selecionável e pesquisável ({len(txt)} caracteres)")
proib = r"agent|heartbeat|ingest|outbox|token|endpoint|\bAPI\b|\bfila\b|E2E|Silveir|Segurad|Garantia|Integra[çc][ãa]o|NIF|StagingCompra|long-polling|pipeline|chave"
rel(not re.search(proib, txt, re.I), "sem termos técnicos nem nomes de clientes no texto")
# legibilidade: as capturas são ×2 (1 px CSS = 2 px da imagem); texto de interface de 12 px CSS => pt no papel
res = []
for i, p in enumerate(d):
    if i == 0:
        continue
    for info in p.get_image_info():
        w_mm = (info["bbox"][2] - info["bbox"][0]) / 72 * 25.4
        if w_mm < 20:
            continue
        css_w = info["width"] / 2
        mm_px = w_mm / css_w
        res.append({"pag": i + 1, "dpi": round(info["width"] / (w_mm / 25.4)), "pt12": round(12 * mm_px / 0.3528, 1), "pt14": round(14 * mm_px / 0.3528, 1), "css_w": round(css_w)})
rel(all(r["dpi"] >= 150 for r in res), f"{len(res)} imagens; resolução efetiva mínima {min(r['dpi'] for r in res)} dpi (exigido ≥ 150)")
estreitas = [r for r in res if r["css_w"] <= 600 and r["pt12"] < 7.9]
largas = [r for r in res if r["pt12"] < 7.9 and r not in estreitas]
rel(not largas, f"texto de 12 px da aplicação ≥ 7,9 pt em todas as imagens de ecrã largo (mínimo {min(r['pt12'] for r in res if r not in estreitas)} pt)")
rel(all(r["pt14"] >= 7.9 for r in estreitas), f"{len(estreitas)} imagens estreitas (menu, entrada) têm texto de 14 px ≥ 7,9 pt (mínimo {min([r['pt14'] for r in estreitas] or [0])} pt)")
print("Metadados:", d.metadata.get("title"))
sys.exit(0 if ok else 1)
