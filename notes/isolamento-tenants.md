# Isolamento por tenant — prova por comparação com a base a69cbc5

Pergunta: a entrega (branch `feat/garantia-catalogo-classificacao-margens`) regride a Silveira, ativa algo no Sier, ou o
agrupamento de fabricantes fica fora do Garantia? Resposta, com provas executáveis (dados 100% sintéticos, PostgreSQL
descartável `localhost:15433`).

## Como se prova

`scripts/tests/_snapshot-tenant.ts` tira uma fotografia JSON canónica (chaves ordenadas) do comportamento REAL da
aplicação para um tenant simulado, sobre uma base semeada de forma determinística (ids fixos). Corre-se na árvore base
(worktree `C:\projetos\_clean\base-a69`, só lida/executada) e na árvore actual; `scripts/tests/_comparar-isolamento.ts`
compara-as e classifica cada diferença como esperada (declarada, com razão) ou INESPERADA.

O que a fotografia cobre (código real da árvore, não cópias): matriz perfil → permissão (`can`), gate da manutenção e dos
grupos, item de menu, página `/catalogo/manutencao` (notFound ou renderizada), as 9 server actions da manutenção × 6
cenários (4 perfis, sem sessão, JWT de outro tenant — `getSession` real), `getReportingFilterOptions`,
`loadCatalogoFilterOptions`, `loadCatalogoListData` (where capturado), resolvedores de laboratório, `getMargensData`,
decisões de ingestão (`decidirFabricanteSilveira`, `decidirFabricanteBaseline`, `decidirDesignacao`,
`resolverModoDesignacao`), SHA-1 dos 23 ficheiros de `app/api/ingest` + `lib/ingest`, SQL puro do filtro de forma.
Só se simulam `next/headers`/`next/cache`/`next/navigation`, `@/lib/prisma` e a leitura do cabeçalho do tenant
(`resolveCurrentTenantSlug`; as constantes e gates re-exportados continuam a ser os reais).

Tenants fotografados: `silveira`, `sier`, `garantia` (controlo positivo), `outro` (slug desconhecido), `__nenhum__` (sem
tenant).

## Comandos e resultados (2026-10-29)

```
TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres
npx tsx scripts/tests/test-isolamento-silveira-nao-regressao.ts   -> 56 PASSOU, 0 FALHOU
npx tsx scripts/tests/test-isolamento-sier-recusa.ts              -> 91 PASSOU, 0 FALHOU
npx tsx scripts/tests/_comparar-isolamento.ts                     -> diferenças por tenant (CLI informativa)
```

Cada execução demora ~30 s (cria a base, migra, semeia, 5 tenants × 2 árvores, apaga a base).
Nota: a árvore actual é lida TAL COMO ESTÁ no disco (HEAD 979d8a3 + alterações por commitar dos restantes trabalhos em
curso); onde faz diferença os testes verificam `a69cbc5..HEAD` e `a69cbc5..disco`.

## Tabela por tenant × funcionalidade

Legenda: = igual ao base; ATIVA / RECUSA = estado. «Prova» é o teste (e o bloco) que o demonstra.

| Funcionalidade | silveira (antes → depois) | garantia (antes → depois) | sier (antes → depois) | outro / sem tenant (antes → depois) | Prova |
|---|---|---|---|---|---|
| Manutenção do catálogo (menu, página, 9 server actions) | ATIVA → ATIVA, resultados de todas as acções idênticos (4 perfis, sem sessão, outro tenant) | RECUSA (404 + acções «não disponível») → **ATIVA** (único tenant novo; pretendido) | RECUSA → RECUSA | RECUSA → RECUSA | silveira B1–B10; sier B1–B9, C1–C6; control. positivo garantia B9 |
| Permissões / ações | 9 permissões, matriz idêntica; 9 acções exportadas, nenhuma nova | = | = | = | silveira A1–A6; sier B8 |
| Agrupamento de fabricantes (opções «Grupo (N variantes)», `grupo:`) | sem `laboratorios`, lista de 6 fabricantes soltos, `grupo:` não resolve → = | grupos já existiam sem variantes → **grupo «Viatris» com 3 variantes**, lista agrupada | = (sem agrupamento) | = | silveira D1–D14; sier D1–D10; garantia D11–D14 |
| Filtro de fabricante / where do Catálogo por laboratório | = (where e produtos idênticos nos 5 cenários) | `grupo:` / `fabricante:` como no base (Catálogo usa `pesquisarLaboratorios`) | = | = | silveira D8–D10; sier D10 |
| Filtro de forma farmacêutica | **novo, todos os tenants (ponto 6)**: só aparece `formas` nas opções | idem | idem | idem | silveira E1 (diferença declarada); sier F1 |
| Stock em Margens (`stockTotal`, `linhasSemStock`, `stockAtual`) | campos novos aditivos no mapa; restantes números iguais | idem | idem | idem | silveira E1 / sier F1 (diferenças só nestes campos); `test-margens-stock*.ts` |
| Margens sem geração automática | comportamento de UI, **sem gate de tenant** (todos, por pedido); não há `slug` nas alterações | idem | idem | idem | sier E1/E2 (0 literais/comparações de slug); `test-margens-sem-geracao-automatica.ts`, E2E |
| Ingestão (`app/api/ingest/**`, `lib/ingest/**`) | `git diff a69cbc5 HEAD -- …` VAZIO; SHA-1 dos 23 ficheiros iguais; decisões iguais | = (não tocada) | = | = | silveira C1–C14; sier F3 |
| Designação autoritativa / fabricante «nunca reescrever» | só Silveira: Silveirense AUTORITATIVA, outra farmácia SO_CRIACAO → = | LEGACY → LEGACY | LEGACY → LEGACY | LEGACY → LEGACY | silveira C5–C12; sier F3 |
| Gates por slug | 2 usos pré-existentes na ingestão, intactos | — | — | — | sier E1–E4 |

## Prova estrutural dos gates (sier E1–E4)

- Linhas de código adicionadas em `app lib components middleware.ts` (a69cbc5..HEAD: 1150; ..disco: 1318): **0** literais
  `"garantia"`/`"silveira"`/`"sier"` e **0** comparações `===`/`!==` de slug/tenant ou com `TENANT_*` fora de
  `lib/tenant-constants.ts`.
- Os únicos literais/comparações novos (3 linhas) estão em `lib/tenant-constants.ts`: `TENANTS_CATALOGO_MANUTENCAO =
  ["silveira","garantia"]`, `catalogoManutencaoAtiva`, `gruposLaboratoriaisAtivos`.
- `git grep` no SHA base e no disco: 28 linhas de comparação de slug no base, 22 no disco, **0 novas**; as 6 removidas são
  exactamente as que passaram para as funções centrais (manutenção: `actions.ts`, `page.tsx`, `app-shell.tsx`; grupos:
  `catalogo-data.ts`, `reporting-filter-options.ts`, `resolver-laboratorio-selecionado.ts`).
- O agrupamento no cliente não tem gate próprio: depende de `ReportingFilterOptions.laboratorios`, que o servidor só
  preenche quando `gruposLaboratoriaisAtivos(slug)`; fora do Garantia é `undefined` (sier D2).

## Diferenças base × actual para Silveira/Sier/outro (todas declaradas, 0 inesperadas)

1. Ponto 6 — filtro de forma (todos os tenants, por pedido): `formas` em `getReportingFilterOptions` e em
   `loadCatalogoFilterOptions`; SQL puro novo do filtro.
2. Margens com stock (todos os tenants, por pedido): campos aditivos `stockTotal`, `linhasSemStock` e, no disco, `linhas`.
3. Refactor do gate (nome do mecanismo, mesmo booleano): `catalogoManutencaoAtiva` / `gruposLaboratoriaisAtivos`; constante
   `TENANTS_CATALOGO_MANUTENCAO`.
4. Módulos novos inertes fora do Garantia: `resolverCnpsPorLaboratoriosSelecionados`, `agruparOpcoesLaboratorio`, server
   action `resolverCnpsLaboratoriosAction` (ver observação 1).

## Observações / riscos encontrados (nenhuma regressão)

1. **Server action nova em todos os tenants**: `lib/reporting/laboratorio-actions.ts` → `resolverCnpsLaboratoriosAction`
   (`"use server"`, exige sessão + `reports.read`, só lê). Não cria permissão nova e fora do Garantia nunca resolve
   grupos (`grupo:`/nome de grupo → `[]`; `fabricante:`/nome solto → só os CNP desse fabricante, o que o utilizador já vê
   nos relatórios); sem sessão e com JWT de outro tenant devolve `[]` (sier D8–D9, E5–E6). Se a exigência for «nenhuma
   acção nova na Silveira», esta é a única a que a frase não se aplica à letra; recomenda-se gatear com
   `gruposLaboratoriaisAtivos` no início da acção (não alterado por mim).
2. Pré-existentes no base (não tocados, fora do âmbito): literais `"garantia"` em `app/api/ingest/v1/bootstrap/products/route.ts`
   (2 usos), `lib/jobs/enrich-catalog.ts` e `lib/catalog/reconciliar-grupos-laboratoriais-garantia.ts` (`TENANT_TRAVADO`).
   Não fazem parte do diff da entrega (E4: 0 novos).
3. A manutenção do catálogo no Garantia reutiliza as mesmas acções: o `apply`/`revert` exigem hash de preview válido
   (`PREVIEW_DESACTUALIZADO` com hash forjado) e nenhuma acção alterou a base nos snapshots.
4. A fotografia substitui apenas `resolveCurrentTenantSlug` (lê `x-tenant-slug` via `await import("next/headers")`, não
   interceptável fora de um pedido); `getSession` (JWT real assinado com `createSessionToken`) e `can` são os reais.
