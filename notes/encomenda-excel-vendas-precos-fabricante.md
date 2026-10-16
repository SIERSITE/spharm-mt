# Excel da encomenda · «Incluir preços» · números +1 px · fabricante na ficha

Base: `fix/workspace-preservar-estado-separadores` @ 7241eef5f3439a4bebe1da711401eb602611fee1. Sem migrations. Agent intocado.

## 1. Excel da encomenda
- Botão «Excel» junto a Imprimir/PDF/Email nas «Encomendas finalizadas» e no detalhe (modal de documentos). Transferências não têm Excel.
- Rota `GET /api/encomendas/<id>/excel[?fornecedor=<id|sem>]` (sessão, `reports.write`, acesso à farmácia, `no-store`).
- Folha «Encomenda», 3 colunas (CNP, Designação, Quantidade), sem cabeçalho, sem linhas a zero, CNP com formato `0`.
- Ficheiro: `encomenda-<farmacia>-<fornecedor>-<numero|id>.xlsx`.

## 2/3. Vendas
- «Incluir preços» (por separador, `useEstadoSeparador("vendas:incluirPrecos")`, ligado por omissão e em «Nova análise») afeta Relatório, impressão, PDF e email (PDF). O Excel mantém-se completo.
- Números do mapa +1 px (`td.num`), apenas no relatório «clean» (Vendas); Margens inalterado.

## 4. Fabricante na ficha do artigo
- Editor em Stock › Artigo (permissão `catalog.write`); escolher existente ou criar (normalização, duplicados/alias bloqueados, semelhantes).
- Proteção: `Produto.validadoManualmente` (+ marcador `fabricante` em `camposManuais`). «Voltar a permitir atualização pelo ERP» remove-a, com confirmação.
- AuditLog `produto.fabricante.alterado` (origem `FICHA_ARTIGO`) na mesma transação.

## Testes
`test:excel-encomenda`, `test:fabricante-ficha-db` (PostgreSQL descartável), `test:vendas-mapa-visual`, `e2e:encomenda-excel`, `e2e:vendas-precos-fabricante`.
