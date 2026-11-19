# Manual de utilização do SPharm.MT — fonte e validação

Documento autónomo (PDF) para enviar por email. **Não faz parte da aplicação** (sem menu, página, pesquisa nem botão).

## Ficheiros
| | |
|---|---|
| `SPharmMT-Manual-v1.0.pdf` | PDF final (41 páginas: 27 verticais e 14 horizontais) |
| `manual-completo.html` | **Fonte editável** (HTML + CSS; um capítulo por secção `<h2 id="cap-N">`) |
| `imagens/` | 27 capturas definitivas (×2, janela 1366 px de largura), dados sintéticos |
| `gerar-completo.cjs`, `paginas.py`, `limpar_marcadores.py` | Gerador (Chromium via Playwright; 2 passagens para os números do índice) |
| `validar_pdf.py` | Validação do PDF (índice, marcadores, ligações, texto, termos proibidos, resolução) |
| `FUNCIONALIDADES.md` | Funcionalidades documentadas e excluídas |
| `VALIDACAO.md` | Resultado das validações |
| `../../scripts/e2e/manual-capturas-v2.ts`, `_manual-base.ts` (+ `manual-fase1..4.ts`, validações) | Capturas e validações no browser (base local descartável, dados sintéticos) |

## Regenerar o PDF
```
cd <pasta com node_modules/playwright>
node <repo>/docs/manual/gerar-completo.cjs <repo>/docs/manual/manual-completo.html <repo>/docs/manual/SPharmMT-Manual-v1.0.pdf
python -X utf8 <repo>/docs/manual/validar_pdf.py <repo>/docs/manual/SPharmMT-Manual-v1.0.pdf
```
Requer Python com `pymupdf`. Para acrescentar uma funcionalidade: editar a secção do capítulo em `manual-completo.html`, acrescentar a imagem em `imagens/` e regenerar (o índice atualiza-se sozinho).

## Refazer as capturas
Precisam da aplicação construída (`npm run build` com `SERVER_ACTIONS_ALLOWED_ORIGINS=localhost:3100,127.0.0.1:3100,*.localhost:3100`) e de um PostgreSQL local descartável:
`TEST_PG_ADMIN_URL=postgresql://postgres:<pw>@localhost:<porta>/postgres VAL_OUT=<pasta> IMG_OUT=<pasta>/img npx tsx scripts/e2e/manual-capturas-v2.ts` (copiar `_manual-base.ts` e `manual-capturas-v2.ts` para `scripts/e2e/` da aplicação a testar).
As imagens foram feitas sobre a branch candidata `release/textos-tecnicos-restritos` (ver `VALIDACAO.md`). Cada captura é recortada à zona explicada, a 2× de resolução; a escala no papel é fixada no HTML (`data-escala`, mm por px CSS) para garantir texto ≥ 8 pt.
