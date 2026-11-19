"""Devolve {"cap-N": página} procurando o título de cada capítulo (h2) no PDF, depois do índice."""
import json
import re
import sys

import pymupdf

TITULOS = {
    1: "Entrar, navegar e «Última atualização»", 2: "Dashboard", 3: "Stock e ficha do artigo", 4: "Devoluções",
    5: "Catálogo e criar produto", 6: "Vendas e Manutenção de Vendas", 7: "Margens", 8: "Inventário", 9: "Excessos",
    10: "Transferências (inclui Oportunidades)", 11: "Encomendas e propostas", 12: "Imprimir, PDF, Excel e email",
    13: "Filtros comuns", 14: "Espaços de trabalho e separadores", 15: "Perguntas frequentes e glossário",
}
doc = pymupdf.open(sys.argv[1])
res = {}
for n, t in TITULOS.items():
    padrao = re.compile(rf"^\s*{n}\s+{re.escape(t)}\s*$", re.M)
    for i in range(2, len(doc)):  # salta a capa e o índice
        if padrao.search(doc[i].get_text()):
            res[f"cap-{n}"] = i + 1
            break
    else:
        res[f"cap-{n}"] = "?"
print(json.dumps(res))
