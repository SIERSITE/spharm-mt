"""
scripts/e2e/_texto_pdf.py

Extrai o texto de um PDF, página a página (PyMuPDF), e imprime UMA linha JSON:
  {"paginas": N, "texto": ["...", ...], "primeiras_linhas": [["...", ...], ...]}
`primeiras_linhas` são as 3 primeiras linhas de texto de cada página (para verificar
cabeçalhos repetidos e subtotais soltos no início de uma página).
"""
import json
import sys
import pymupdf

doc = pymupdf.open(sys.argv[1])
texto = []
primeiras = []
for p in doc:
    t = p.get_text("text")
    texto.append(t)
    linhas = [l.strip() for l in t.splitlines() if l.strip()]
    primeiras.append(linhas[:6])
print(json.dumps({"paginas": doc.page_count, "texto": texto, "primeiras_linhas": primeiras}, ensure_ascii=True))
