"""Imprime (JSON) tudo o que um .xlsx contém: nomes das partes, estado das folhas e o texto de TODAS as partes XML.
Uso: python _xlsx_texto.py ficheiro.xlsx   -> {"partes": [...], "folhas": [{"nome":..., "estado":...}], "texto": "..."}
Serve para provar que NÃO há folhas/colunas ocultas, nem valores guardados fora das células visíveis (strings partilhadas, comentários, nomes definidos)."""
import json
import re
import sys
import zipfile

caminho = sys.argv[1]
with zipfile.ZipFile(caminho) as z:
    partes = z.namelist()
    texto = []
    for n in partes:
        try:
            texto.append(z.read(n).decode("utf-8", errors="replace"))
        except Exception:
            pass
    wb = z.read("xl/workbook.xml").decode("utf-8", errors="replace") if "xl/workbook.xml" in partes else ""
folhas = [
    {"nome": m.group(1), "estado": (re.search(r'state="([^"]+)"', m.group(0)) or [None, "visible"])[1]}
    for m in re.finditer(r"<sheet\b[^>]*name=\"([^\"]+)\"[^>]*>", wb)
]
print(json.dumps({"partes": partes, "folhas": folhas, "texto": "\n".join(texto)}, ensure_ascii=True))
