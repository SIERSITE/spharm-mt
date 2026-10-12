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

## 5. Operação na VPS (Docker, imagem `migrator`)

A operação corre **sempre** na imagem `migrator` (o processo administrativo real do projecto;
nada de `npx tsx` no host). Web, worker e PostgreSQL **não são reiniciados nem substituídos**:
só se constrói a imagem `-migrator` e se corre um contentor efémero (`run --rm`) contra a rede
interna. Nenhuma migration.

Variáveis comuns (copiar uma vez por sessão):

```bash
SHA=<SHA final da branch ops/garantia-reposicao-manutencao-vendas>
CLONE=<clone do repositório na VPS>
REL=/opt/spharmmt/relatorios/garantia-manutencoes-vendas
DC="sudo docker compose -p spharmmt --profile tools \
  --env-file /opt/spharmmt/docker/env/platform.env \
  --env-file /opt/spharmmt/docker/env/stack.env"
RUN="$DC run --rm -v $REL:/relatorios migrate"      # relatórios persistem FORA do contentor
```

### 5.1 Obter a revisão exacta e construir só o `migrator`

```bash
cd "$CLONE" && git fetch origin ops/garantia-reposicao-manutencao-vendas
git checkout --detach "$SHA" && git rev-parse HEAD            # tem de imprimir $SHA
git status --short                                            # tem de estar VAZIO
sudo mkdir -p "$REL" && sudo chmod 0750 "$REL"

export APP_BUILD_CONTEXT="$CLONE" APP_REVISION="$SHA"
cd /opt/spharmmt/docker/compose && $DC build migrate          # só a imagem -migrator

# a imagem sabe que revisão é, e traz o CLI, os módulos e os dados
docker image inspect spharmmt-app:local-migrator --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ^APP_REVISION=
$DC run --rm migrate ls -l scripts/ops/garantia-reposicao-manutencoes-vendas.ts \
  scripts/ops/garantia-manutencoes-vendas/operacao.ts scripts/ops/garantia-manutencoes-vendas/executar.ts \
  scripts/ops/garantia-manutencoes-vendas/dados.json
$DC run --rm migrate sha256sum scripts/ops/garantia-manutencoes-vendas/dados.json
#   esperado: 83a6c0355f19f3fe748e69deeff2d5cf93342ca2c4fe3432090f70795b8d994e
$RUN npm run ops:garantia-manutencoes-vendas -- --help        # exit 0
```

(Se a tag da imagem não for `spharmmt-app:local-migrator`, usar `APP_IMAGE`/`APP_TAG` do
`stack.env` com o sufixo `-migrator`.)

### 5.2 Diagnóstico de leitura (antes do dry-run)

Mostra as 5 farmácias do tenant e a que cada coluna resolve, os **utilizadores activos** (escolher o
email para o apply), se já existem registos `hg1_` e as contagens actuais. Só faz `SELECT`.

```bash
$RUN npm run diag:garantia-manutencoes-vendas -- --tenant=garantia
#   esperado: ESTADO=PRONTO_PARA_DRY_RUN  (hg1_ = 0/0/0; as 5 colunas resolvidas)
```

Contagens por SQL (opcional; só leitura). A base é a que o diagnóstico imprime (`base host:porta/NOME`):

```bash
DB=<NOME da base impresso acima>
docker exec -i spharmmt-postgres sh -c "psql -U \"\${POSTGRES_USER:-postgres}\" -d $DB -v ON_ERROR_STOP=1" <<'SQL'
SET default_transaction_read_only = on;
SELECT id, nome, estado FROM "Farmacia" ORDER BY nome;
SELECT email, perfil FROM "Utilizador" WHERE estado = 'ATIVO' ORDER BY email;
SELECT count(*) AS hg1_cabecalhos FROM "VendaManutencao" WHERE left(id,4) = 'hg1_';          -- 0
SELECT (SELECT count(*) FROM "VendaManutencao") AS manutencoes,
       (SELECT count(*) FROM "VendaManutencaoCelula") AS celulas,
       (SELECT count(*) FROM "VendaManutencaoFarmacia") AS farmacias_pvp;
SQL
```

### 5.3 Dry-run (zero escritas) e análise do relatório

```bash
$RUN npm run ops:garantia-manutencoes-vendas -- --tenant=garantia --relatorio=/relatorios/dry-run-$SHA.json
# o relatório fica em $REL/dry-run-<SHA>.json (persistente). Resumo:
sudo node -e '
const r=require(process.argv[1]);
console.log(JSON.stringify({tipo:r.tipo,revisao:r.revisaoCodigo,base:r.baseDados,sha256:r.ficheiroSha256,totais:r.totais,
  farmacias:Object.fromEntries(Object.entries(r.farmacias).map(([k,v])=>[k,v&&v.nome+" "+v.id])),
  bloqueios:r.bloqueios,antes:r.contagensAntes.desteConjunto,depois:r.contagensDepois.desteConjunto},null,2))' "$REL/dry-run-$SHA.json"
```

**Só avançar para o apply se o resumo mostrar exactamente:** `manutencoesRecebidas: 36`,
`novas: 36` (ou menos só se alguma já existir de forma idêntica), `conflitos: 0`, `bloqueios: []`,
`cnpDistintos: 24` = `cnpEncontrados: 24`, as **cinco** farmácias resolvidas com o nome/id esperado,
e `antes` = `depois` (zero escritas).

> ### ⚠ APPLY — DESTRUTIVO: ESCREVE na base real do tenant garantia
> Só depois da análise acima. Uma só transacção; qualquer falha reverte tudo.
> ```bash
> $RUN npm run ops:garantia-manutencoes-vendas -- --tenant=garantia \
>   --apply --confirmar-tenant=garantia --utilizador-email=<email escolhido no diagnóstico> \
>   --relatorio=/relatorios/apply-$SHA.json
> ```
> **Guardar `$REL/apply-<SHA>.json`**: é o que permite reverter.

### 5.4 Verificação posterior

```bash
$RUN npm run diag:garantia-manutencoes-vendas -- --tenant=garantia      # hg1_ = 36 / 1105 / 180 (estado JA_EXISTEM_REGISTOS_HG1, exit 1: é o esperado depois do apply)
docker exec -i spharmmt-postgres sh -c "psql -U \"\${POSTGRES_USER:-postgres}\" -d $DB -v ON_ERROR_STOP=1" <<'SQL'
SET default_transaction_read_only = on;
SELECT count(*) AS cabecalhos FROM "VendaManutencao" WHERE left("id",4) = 'hg1_';                        -- 36
SELECT count(*) AS celulas    FROM "VendaManutencaoCelula"   WHERE left("manutencaoId",4) = 'hg1_';      -- 1105
SELECT count(*) AS pvp        FROM "VendaManutencaoFarmacia" WHERE left("manutencaoId",4) = 'hg1_';      -- 180
SELECT (SELECT count(*) FROM "VendaManutencaoCelula" c WHERE NOT EXISTS (SELECT 1 FROM "VendaManutencao" m WHERE m.id = c."manutencaoId"))
     + (SELECT count(*) FROM "VendaManutencaoFarmacia" f WHERE NOT EXISTS (SELECT 1 FROM "VendaManutencao" m WHERE m.id = f."manutencaoId")) AS orfaos;   -- 0
SELECT m.id, m.cnp, m."mesInicialAno", m."mesInicialMes", m."numMeses", m."quantidadeTotal", f.nome, sum(c.quantidade) AS total
FROM "VendaManutencao" m JOIN "VendaManutencaoCelula" c ON c."manutencaoId" = m.id JOIN "Farmacia" f ON f.id = c."farmaciaId"
WHERE left(m.id,4) = 'hg1_'
GROUP BY m.id, m.cnp, m."mesInicialAno", m."mesInicialMes", m."numMeses", m."quantidadeTotal", f.nome
ORDER BY m.cnp, m."mesInicialAno", m."mesInicialMes", f.nome;     -- comparar com os `totals` do dados.json
SELECT "entityId", "metaJson" FROM "AuditLog" WHERE action = 'venda_manutencao.reposicao_historica';   -- 36 linhas
SQL
```

Repetir o apply é seguro (idempotente: 36 `JA_EXISTENTE`).

### 5.5 Reversão (só os registos do relatório do apply)

Recusa-se se algum registo foi alterado depois da operação; células e PVP saem por cascata; o
AuditLog de criação fica e ganha uma linha de reversão.

```bash
# 1) simulação (dry-run da reversão): lista os 36 alvos e não escreve
$RUN npm run ops:garantia-manutencoes-vendas -- --tenant=garantia \
  --reverter=/relatorios/apply-$SHA.json --relatorio=/relatorios/reversao-dry-run-$SHA.json
```

> ### ⚠ REVERSÃO EFECTIVA — DESTRUTIVA: apaga os 36 registos criados pela operação
> ```bash
> $RUN npm run ops:garantia-manutencoes-vendas -- --tenant=garantia \
>   --reverter=/relatorios/apply-$SHA.json --apply --confirmar-tenant=garantia \
>   --utilizador-email=<email> --relatorio=/relatorios/reversao-apply-$SHA.json
> ```

## 6. Limitações reais

1. **Sem campo para a data da compra** (nem para a quantidade antiga por farmácia, nem para a
   designação/prints): preservados só em AuditLog + relatório + `dados.json`. A alteração
   mínima, se se quiser vê-los na UI, seria uma coluna nullable `dataCompraOrigem` — **não
   feita** (exigiria migration; fora do âmbito pedido).
2. **`quantidadeTotal` ≠ `quantity` antiga** (soma de todas as farmácias vs. valor por
   farmácia). É a única forma coerente com o invariante da aplicação; a matriz está intacta.
   **⚠ Não usar «Recalcular» nestes registos se se pretende preservar os valores do sistema
   anterior:** a acção substitui a matriz histórica por uma distribuição nova calculada a partir de
   `quantidadeTotal` (peso histórico das farmácias) e os valores originais perdem-se (só ficam
   o relatório do apply e o `dados.json`). É o comportamento normal da funcionalidade, que não foi
   alterado.
3. **PVP de referência NULL**: o mapa de Vendas valoriza estes registos a 0 € e a UI de detalhe
   assinala «sem PVP» (comportamento já existente; nunca se inventa preço).
4. **Pré-existente no mapa de Vendas** (não alterado): com `incluirManutencao` mas sem vendas
   reais no período, um artigo só aparece se «Incluir stock sem vendas» estiver ligado
   (o loader sai cedo quando o ledger está vazio).
5. A resolução das farmácias por nome é uma suposição razoável (dry-run mostra os ids);
   `--farmacias` fixa-os. Só a base real confirma que existem e que são únicas.
6. Não executado contra nenhuma base real, nem na VPS.
