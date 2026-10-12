# Reposição única — histórico da Manutenção de Vendas no tenant `garantia`

Operação administrativa **única**: não há interface, endpoint, importador genérico, tarefa
periódica nem sincronização. Ficheiros:

* `scripts/ops/garantia-reposicao-manutencoes-vendas.ts` — CLI (dry-run por defeito).
* `scripts/ops/garantia-manutencoes-vendas/{operacao,executar}.ts` — validação, plano, escrita, reversão.
* `scripts/ops/garantia-manutencoes-vendas/dados.json` — o ficheiro fornecido, byte-a-byte
  (sha256 `83a6c0355f19f3fe748e69deeff2d5cf93342ca2c4fe3432090f70795b8d994e`).
* `scripts/tests/test-garantia-manutencoes-vendas-db.ts` — prova (PostgreSQL descartável).
* `notes/garantia-manutencoes-vendas/exemplo-*.json` — relatórios reais de dry-run/apply em base descartável.

## 1. Auditoria do modelo actual (revisão `4b6396a`)

| Pergunta | Resposta (código real) |
|---|---|
| 1. Tabela da manutenção | `VendaManutencao` (cabeçalho: `produtoId`, `cnp`, `quantidadeTotal Int`, `numMeses`, `mesInicialAno/Mes`, `origemDistribuicao`, `estado ATIVA\|ANULADA`, `criadoPorId` **obrigatório**) |
| 2. Mês × farmácia | `VendaManutencaoCelula` (`manutencaoId`, `farmaciaId`, `ano`, `mes`, `quantidade Int`; único por os quatro) |
| 3. Produto por CNP | `produtoId` (FK) + `cnp` (snapshot); `Produto.cnp` é único |
| 4. Farmácias | `Farmacia.id` (cuid), nome único; **não há código por coluna** — resolve-se por nome (ver §3) |
| 5. Quantidade global ou por farmácia | **Global**: `quantidadeTotal` = a repartir por todas as farmácias; `criarManutencaoAction` exige `Σ células === quantidadeTotal` («sem excepção»). No sistema antigo a `quantity` é **por farmácia** (cada coluna = quantity na maioria dos casos) |
| 6. Totais | **Calculados** a partir das células (nunca armazenados por farmácia) |
| 7. Várias manutenções do mesmo CNP | Sem restrição única: cada cabeçalho é independente (id próprio) |
| 8. Obrigatórios que o antigo não tem | `criadoPorId` (→ `--utilizador-email`, utilizador existente do tenant); `VendaManutencaoFarmacia.pvpReferencia` é **nullable** (→ NULL, nunca 0 nem preço de hoje) |
| 9. Já existem equivalentes? | O dry-run classifica cada registo (NOVO / JA_EXISTENTE / CONFLITO) lendo a base; só a base real o diz |

O mapa de Vendas (`getVendasData`, `incluirManutencao`) lê exactamente estas tabelas
(`vm.estado='ATIVA'`), pelo que os registos repostos entram nele sem mais nada.

## 2. Mapeamento JSON → modelo

* registo → 1 `VendaManutencao`; cada (mês × farmácia) → 1 `VendaManutencaoCelula`
  (zeros incluídos: 221 linhas mensais × 5 = **1105 células**); cada farmácia → 1
  `VendaManutencaoFarmacia` com `pvpReferencia = NULL` (180 linhas).
* `mesInicial` = 1.º mês da matriz; `numMeses` = nº de linhas (validado: contíguas e ascendentes).
* `origemDistribuicao = MANUAL_AJUSTADA` (não foi calculada), `estado = ATIVA`.
* **`quantidadeTotal = Σ de todas as células`** (única forma de respeitar o invariante do modelo).
  A `quantity` antiga e os `totals` antigos **não são alterados nem redistribuídos**: as células
  são exactamente a matriz do ficheiro; `quantity`/`totals` ficam no AuditLog (abaixo).
  Seis manutenções têm totais ≠ quantity e foram preservadas tal como estão:

  | # | CNP | quantity | totais (Gar/Prin/Cast/Per/Nog) | quantidadeTotal gravada |
  |---|---|---|---|---|
  | 9 | 7395517 | 60 | 60/60/92/37/53 | 302 |
  | 14 | 5788484 | 35 | 35/35/34/35/35 | 174 |
  | 18 | 5894605 | 100 | 170/158/170/66/111 | 675 |
  | 19 | 3854585 | 40 | 28/50/50/34/30 | 192 |
  | 20 | 5440987 | 70 | 46/69/122/50/70 | 357 |
  | 32 | 5751433 | 48 | 48/47/48/48/44 | 235 |

* Identificadores técnicos **determinísticos** (`hg1_<sha256[0..24]>`; células `hg1c_…`, PVP
  `hg1f_…`), derivados do conteúdo completo (tenant, CNP, data de compra, quantidade, nº de
  meses, matriz, colunas). **Não são apresentados como número de documento** (esse não foi
  transcrito). O prefixo identifica inequivocamente os registos da operação.
* Designação do sistema antigo: só no AuditLog; `Produto.designacao` nunca é tocada.
* **Data da compra, quantidade antiga, totais antigos, prints de origem e `derived_months`
  (CNP 3311180, 2025-03)** não têm campo no schema ⇒ ficam numa linha de `AuditLog` por
  registo (`action = venda_manutencao.reposicao_historica`, `entityId` = id do cabeçalho) e no
  relatório.

## 3. Resolução de entidades

* CNP → `Produto` (exactamente 1; 0 ou >1 bloqueia).
* Farmácias: o nome (sem acentos/maiúsculas, sem «Farmácia», «da/do/de») tem de ser **igual** ao
  rótulo da coluna (Garantia, Principal, Castelo, Pereiro, Nogueira); 0 ou >1 correspondências,
  ou uma farmácia a servir duas colunas, **bloqueia o `--apply`**. Depois de ver os ids no
  dry-run pode fixá-los: `--farmacias="Garantia=<id>,Principal=<id>,…"` (têm de existir).

## 4. Segurança e idempotência

* Só `--tenant=garantia` (qualquer outro: exit 2); resolvido pelo control plane real
  (`getTenantBySlug`/`buildTenantConnectionString`), tenant `ACTIVE`; nunca `DATABASE_URL`.
* Dry-run por defeito (zero escritas, provado). `--apply` exige `--confirmar-tenant=garantia`
  e `--utilizador-email=<utilizador do tenant>`.
* Uma só transacção (+ verificação final dentro dela); qualquer falha ⇒ rollback integral.
* Idempotência: id determinístico ⇒ `JA_EXISTENTE` se o conteúdo é igual; **CONFLITO** (bloqueia,
  nunca actualiza) se existe com conteúdo diferente. Também detecta um preexistente ATIVO com a
  mesma identidade principal (CNP + mês inicial + nº de meses): igual ⇒ `JA_EXISTENTE`,
  divergente ⇒ `CONFLITO`.
* Nunca elimina nem modifica manutenções existentes.

## 5. Comandos

**Dry-run** (sem escritas; pode correr na VPS):

```
npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia --relatorio=/tmp/garantia-dry-run.json
```

> ### ⚠ DESTRUTIVO / ESCREVE NA BASE REAL — só depois de rever o dry-run (0 bloqueios, 36 novas)
> ```
> npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia \
>   --apply --confirmar-tenant=garantia --utilizador-email=<email> --relatorio=/tmp/garantia-apply.json
> ```
> **Guardar `/tmp/garantia-apply.json`**: é o que permite reverter.

**Verificação posterior (SQL, só leitura):**

```sql
SELECT count(*) AS cabecalhos FROM "VendaManutencao" WHERE left("id",4) = 'hg1_';                         -- 36
SELECT count(*) AS celulas    FROM "VendaManutencaoCelula"   WHERE left("manutencaoId",4) = 'hg1_';       -- 1105
SELECT count(*) AS pvp        FROM "VendaManutencaoFarmacia" WHERE left("manutencaoId",4) = 'hg1_';       -- 180
-- totais por farmácia de cada manutenção (comparar com `totals` do dados.json)
SELECT m.id, m.cnp, m."mesInicialAno", m."mesInicialMes", m."numMeses", m."quantidadeTotal",
       f.nome, sum(c.quantidade) AS total
FROM "VendaManutencao" m
JOIN "VendaManutencaoCelula" c ON c."manutencaoId" = m.id
JOIN "Farmacia" f ON f.id = c."farmaciaId"
WHERE left(m.id,4) = 'hg1_'
GROUP BY m.id, m.cnp, m."mesInicialAno", m."mesInicialMes", m."numMeses", m."quantidadeTotal", f.nome
ORDER BY m.cnp, m."mesInicialAno", m."mesInicialMes", f.nome;
-- órfãos (têm de ser 0)
SELECT (SELECT count(*) FROM "VendaManutencaoCelula" c WHERE NOT EXISTS (SELECT 1 FROM "VendaManutencao" m WHERE m.id = c."manutencaoId"))
     + (SELECT count(*) FROM "VendaManutencaoFarmacia" f WHERE NOT EXISTS (SELECT 1 FROM "VendaManutencao" m WHERE m.id = f."manutencaoId"));
-- evidência do sistema antigo (data de compra, quantity, totals, prints)
SELECT "entityId", "metaJson" FROM "AuditLog" WHERE action = 'venda_manutencao.reposicao_historica';
```

**Reversão** (remove SÓ os registos listados no relatório do `--apply`; recusa se algum foi
alterado depois; células e PVP saem por cascata; o AuditLog de criação fica e ganha uma linha
de reversão):

```
# 1) dry-run da reversão
npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia --reverter=/tmp/garantia-apply.json
# 2) ⚠ DESTRUTIVO — apaga os 36 registos criados pela operação
npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia \
  --reverter=/tmp/garantia-apply.json --apply --confirmar-tenant=garantia [--utilizador-email=<email>]
```

## 6. Limitações reais

1. **Sem campo para a data da compra** (nem para a quantidade antiga por farmácia, nem para a
   designação/prints): preservados só em AuditLog + relatório + `dados.json`. A alteração
   mínima, se se quiser vê-los na UI, seria uma coluna nullable `dataCompraOrigem` — **não
   feita** (exigiria migration; fora do âmbito pedido).
2. **`quantidadeTotal` ≠ `quantity` antiga** (soma de todas as farmácias vs. valor por
   farmácia). É a única forma coerente com o invariante da aplicação; a matriz está intacta.
   Se alguém usar «Recalcular» na UI sobre um destes registos, a distribuição será refeita a
   partir de `quantidadeTotal` (peso histórico) e a matriz antiga perde-se — é o comportamento
   normal da funcionalidade.
3. **PVP de referência NULL**: o mapa de Vendas valoriza estes registos a 0 € e a UI de detalhe
   assinala «sem PVP» (comportamento já existente; nunca se inventa preço).
4. **Pré-existente no mapa de Vendas** (não alterado): com `incluirManutencao` mas sem vendas
   reais no período, um artigo só aparece se «Incluir stock sem vendas» estiver ligado
   (o loader sai cedo quando o ledger está vazio).
5. A resolução das farmácias por nome é uma suposição razoável (dry-run mostra os ids);
   `--farmacias` fixa-os. Só a base real confirma que existem e que são únicas.
6. Não executado contra nenhuma base real, nem na VPS.
