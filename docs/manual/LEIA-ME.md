# Manual de utilização do SPharm.MT — fonte e validação

Documento autónomo (PDF) para enviar por email. **Não faz parte da aplicação** (sem menu, página, pesquisa nem botão).

## Ficheiros
| | |
|---|---|
| `SPharmMT-Manual-v1.0.pdf` | PDF final (32 páginas) |
| `manual-completo.html` | **Fonte editável** (HTML + CSS; um capítulo por secção `<h2 id="cap-N">`) |
| `imagens/` | 27 capturas definitivas, dados sintéticos |
| `gerar-completo.cjs`, `paginas.py`, `limpar_marcadores.py` | Gerador (Chromium via Playwright; 2 passagens para os números do índice) |
| `validar_pdf.py` | Validação do PDF (índice, marcadores, ligações, texto, termos proibidos, resolução) |
| `FUNCIONALIDADES.md` | Funcionalidades documentadas e excluídas |
| `VALIDACAO.md` | Resultado das validações |
| `../../scripts/e2e/manual-*.ts`, `_manual-base.ts` | Capturas e validações no browser (base local descartável, dados sintéticos) |

## Regenerar o PDF
```
cd <pasta com node_modules/playwright>
node <repo>/docs/manual/gerar-completo.cjs <repo>/docs/manual/manual-completo.html <repo>/docs/manual/SPharmMT-Manual-v1.0.pdf
python -X utf8 <repo>/docs/manual/validar_pdf.py <repo>/docs/manual/SPharmMT-Manual-v1.0.pdf
```
Requer Python com `pymupdf`. Para acrescentar uma funcionalidade: editar a secção do capítulo em `manual-completo.html`, acrescentar a imagem em `imagens/` e regenerar (o índice atualiza-se sozinho).

## Refazer as capturas
Precisam da aplicação construída (`npm run build` com `SERVER_ACTIONS_ALLOWED_ORIGINS=localhost:3100,127.0.0.1:3100,*.localhost:3100`) e de um PostgreSQL local descartável:
`TEST_PG_ADMIN_URL=postgresql://postgres:<pw>@localhost:<porta>/postgres VAL_OUT=<pasta> IMG_OUT=<pasta>/img npx tsx scripts/e2e/manual-capturas-final.ts`.
As imagens deste manual foram feitas sobre a integração das branches `feat/atualizacao-por-farmacia-menu` e `fix/relatorios-cabecalho-ver-em-ecra` (ver `VALIDACAO.md`).
