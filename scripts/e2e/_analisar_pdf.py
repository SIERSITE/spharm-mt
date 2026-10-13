"""
scripts/e2e/_analisar_pdf.py

Análise do PDF de Margens (usado por margens-cnpem-cabecalhos-browser.ts):
  · cabeçalho repetido em todas as páginas (texto «Descrição» e «CNP» no topo);
  · nenhuma página começa com «TOTAL ARTIGO»;
  · colunas novas presentes;
  · escala de cinzentos: níveis de cinzento distintos e contraste entre blocos;
  · bordas horizontais fortes (separação entre artigos).
Imprime uma linha JSON no fim. Grava PNG (cor e cinzentos) das 2 primeiras páginas.
"""
import json
import sys
import pymupdf

pdf, saida = sys.argv[1], sys.argv[2]
doc = pymupdf.open(pdf)
paginas = doc.page_count
com_cab = 0
com_tabela = 0
soh_rodape = 0
subtotal_orfao = False
margem_unit = False
utente = False
totais_p1 = 0
for i, p in enumerate(doc):
    palavras = p.get_text("words")  # x0,y0,x1,y1,palavra,...
    textos = [w[4] for w in palavras]
    margem_unit = margem_unit or ("unit." in textos and "Margem" in textos)
    utente = utente or ("Utente" in textos and "geral" in textos and "especial" in textos)
    if i == 0:
        totais_p1 = sum(1 for w in palavras if w[4] == "TOTAL")
    # cabeçalho: a palavra «Descrição» e «CNP» nos primeiros ~180 pt da página
    topo = [w for w in palavras if w[1] < 180]
    tem = any(w[4].startswith("Descri") for w in topo) and any(w[4] == "CNP" for w in topo)
    # Uma página SÓ com o rodapé (≤ 10 palavras) não tem tabela: não conta para a regra do cabeçalho.
    if len(palavras) <= 10:
        soh_rodape += 1
    else:
        com_tabela += 1
        com_cab += 1 if tem else 0
    # primeira linha do corpo = primeira linha abaixo da linha do cabeçalho
    cab = [w for w in palavras if w[4] == "CNP"]
    if cab:
        y_cab = max(w[3] for w in cab)
        abaixo = sorted([w for w in palavras if w[1] > y_cab + 2], key=lambda w: (round(w[1]), w[0]))
        if abaixo:
            y0 = round(abaixo[0][1])
            primeira_linha = " ".join(w[4] for w in abaixo if round(w[1]) == y0)
            if primeira_linha.startswith("TOTAL ARTIGO") or primeira_linha.startswith("TOTAL"):
                subtotal_orfao = True

# Renderização em cor e em cinzentos
def render(pg, gray):
    cs = pymupdf.csGRAY if gray else pymupdf.csRGB
    return pg.get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2), colorspace=cs)

for n in range(min(2, paginas)):
    render(doc[n], False).save(f"{saida}/margens-pdf-p{n + 1}-cor.png")
    render(doc[n], True).save(f"{saida}/margens-pdf-p{n + 1}-cinzentos.png")

g = render(doc[0], True)
amostras = g.samples
niveis = {}
for b in amostras:
    q = b // 8  # quantiza em 32 níveis
    niveis[q] = niveis.get(q, 0) + 1
total = len(amostras)
relevantes = [q for q, c in niveis.items() if c / total > 0.004]
relevantes.sort()
cinzentos_distintos = len(relevantes)

# contraste entre blocos alternados: dois níveis claros mais frequentes (branco vs cinzento de bloco)
claros = sorted([(c, q) for q, c in niveis.items() if q * 8 > 180], reverse=True)[:3]
contraste = 0
if len(claros) >= 2:
    contraste = abs(claros[0][1] - claros[1][1]) * 8

# bordas horizontais fortes: linhas de pixels escuros que cobrem >55% da largura
w, h = g.width, g.height
bordas = 0
linha_anterior = False
for y in range(h):
    row = amostras[y * w:(y + 1) * w]
    escuros = sum(1 for v in row if v < 90)
    forte = escuros > 0.55 * w
    if forte and not linha_anterior:
        bordas += 1
    linha_anterior = forte

print(json.dumps({
    "paginas": paginas,
    "paginas_com_cabecalho": com_cab,
    "cabecalho_em_todas": com_cab == com_tabela,
    "paginas_com_tabela": com_tabela,
    "paginas_so_rodape": soh_rodape,
    "subtotal_sem_orfao": not subtotal_orfao,
    "margem_unit": bool(margem_unit),
    "utente": bool(utente),
    "cinzentos_distintos": cinzentos_distintos,
    "contraste_blocos": contraste,
    "bordas_horizontais": bordas,
    "artigos_p1": totais_p1,
}))
