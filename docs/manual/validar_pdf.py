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

rel(30 <= len(d) <= 40, f"{len(d)} páginas (alvo 30 a 40)")
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
mins = []
for i, p in enumerate(d):
    for info in p.get_image_info():
        w_in = (info["bbox"][2] - info["bbox"][0]) / 72
        if w_in * 25.4 < 20 or i == 0:
            continue
        mins.append((round(info["width"] / w_in), i + 1))
mins.sort()
rel(mins[0][0] >= 100, f"{len(mins)} imagens; resolução efetiva mínima {mins[0][0]} dpi (página {mins[0][1]}); mediana {mins[len(mins)//2][0]} dpi")
print("Metadados:", d.metadata.get("title"))
sys.exit(0 if ok else 1)
