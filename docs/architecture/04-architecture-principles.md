# 04 — Architecture Principles

> Regras permanentes de engenharia. Cada uma tem: o que afirma, porquê, o que custa, como se
> verifica, e o que a viola. Onde o sistema actual as viola, está escrito — com nome e sítio.

Estas regras não são aspiracionais. São o critério de aceitação de qualquer PR estrutural.

---

## Índice

| # | Princípio | Estado no sistema |
|---|---|---|
| [P1](#p1--uma-fonte-de-verdade-por-responsabilidade) | Uma fonte de verdade por responsabilidade | cumprido com excepções |
| [P2](#p2--a-autoridade-do-dado-decide-quem-escreve) | A autoridade do dado decide quem escreve | cumprido |
| [P3](#p3--nunca-degradar-informação-forte) | Nunca degradar informação forte | cumprido |
| [P4](#p4--isolamento-de-tenants-por-construção-não-por-cuidado) | Isolamento de tenants por construção | **violado no fallback** |
| [P5](#p5--falhar-alto-nunca-em-silêncio) | Falhar alto, nunca em silêncio | **violado em vários pontos** |
| [P6](#p6--idempotência-em-todo-o-caminho-de-escrita) | Idempotência em todo o caminho de escrita | cumprido |
| [P7](#p7--determinismo-onde-há-artefactos-versionados) | Determinismo onde há artefactos versionados | por construir |
| [P8](#p8--núcleo-puro-io-na-fronteira) | Núcleo puro, I/O na fronteira | cumprido |
| [P9](#p9--fronteira-servidorcliente-explícita) | Fronteira servidor/cliente explícita | cumprido |
| [P10](#p10--mudanças-aditivas-migrations-reversíveis) | Mudanças aditivas, migrations reversíveis | cumprido |
| [P11](#p11--evolução-segura-em-produção) | Evolução segura em produção | cumprido |
| [P12](#p12--observabilidade-é-requisito-não-extra) | Observabilidade é requisito | parcial |
| [P13](#p13--não-duplicar-lógica-de-enriquecimento) | Não duplicar lógica de enriquecimento | **violado por desenho actual** |
| [P14](#p14--o-tenant-nunca-é-fonte-de-conhecimento-canónico) | O tenant nunca é fonte de conhecimento canónico | em correcção |
| [P15](#p15--segredos-nunca-em-código-artefacto-ou-log) | Segredos nunca em código, artefacto ou log | cumprido com ressalva |
| [P16](#p16--o-schema-é-o-contrato-o-código-adapta-se) | O schema é o contrato | cumprido |

---

## P1 — Uma fonte de verdade por responsabilidade

**Afirma:** cada facto tem exactamente um dono. Quem precisa dele lê; não guarda a sua própria
versão.

**Porquê:** duas cópias divergem sempre; a única questão é quando. Exemplos bons no sistema:
`lib/env.ts` (catálogo de variáveis de ambiente), `lib/catalog-taxonomy.ts` (taxonomia canónica),
`lib/operational/metrics-shared.ts` (média diária e cobertura, partilhadas entre dashboard,
propostas e IPF), `lib/movimento-classifier.ts` (classificação de movimentos, partilhada entre
servidor e agente).

**Custo:** obriga a extrair antes de reutilizar, o que é sempre mais lento do que copiar.

**Verificação:** procurar a mesma constante ou fórmula em dois ficheiros. Duas definições de
"média diária" seriam violação imediata.

**Excepção legítima:** *read-models* (o `IndicadoresProdutoFarmacia` é cópia derivada por
desenho) — desde que sejam **recalculáveis do zero** e nunca escritos à mão.

---

## P2 — A autoridade do dado decide quem escreve

**Afirma:** a decisão de escrever um campo depende do *tier* da fonte, da confiança e da relevância
— nunca da ordem de chegada nem do nome da base de origem.

**Porquê:** sem hierarquia explícita, o último processo a correr ganha. Implementado em
`lib/catalog-types.ts` (`SOURCE_TIER_RANK`), `lib/catalog-resolution-engine.ts` (decisão por campo,
conflitos explícitos) e `lib/catalog-persistence.ts` (`AUTHORITATIVE_FIELDS` só aceitam
`REGULATORY`/`MANUFACTURER`).

**Custo:** mais lento a preencher; obriga a guardar proveniência.

**Verificação:** toda a escrita em campo de catálogo passa pelo motor de resolução. Uma escrita
directa em `Produto.codigoATC` fora dele é violação.

**Regra derivada:** uma regra de merge nunca menciona o nome de uma base, tenant ou cliente. Se
mencionar, não é uma regra — é um remendo.

---

## P3 — Nunca degradar informação forte

**Afirma:** valor não-nulo não é substituído por nulo; valor de tier superior não é substituído por
inferior; valor validado à mão não é tocado por processo automático.

**Porquê:** os pipelines correm sem supervisão. O erro que acrescenta corrige-se; o que degrada
perde-se.

**Custo:** o sistema fica difícil de "corrigir em massa" — corrigir exige passar pelo mesmo caminho
de autoridade que escreveu.

**Verificação:** todo o merge tem teste que prova que origem fraca não vence destino forte.
Existem hoje em `scripts/tests/test-catalog-master.ts`.

---

## P4 — Isolamento de tenants por construção, não por cuidado

**Afirma:** a impossibilidade de um cliente ver outro tem de resultar da **estrutura**, não da
disciplina de quem escreve queries.

**Porquê:** é a garantia mais cara de perder e a mais difícil de recuperar. Daí base física por
cliente (não schema, não coluna discriminadora): uma query sem filtro devolve dados a mais **do
mesmo** cliente, nunca de outro. Daí também `lib/integracao/auth.ts` construir o cliente Prisma a
partir do **registo do control plane** e não do header `x-tenant-slug` — o header é o vector de
autenticação e não pode ser também a fonte da ligação.

**Custo:** N bases para migrar, monitorizar e salvaguardar; sem queries cross-cliente, mesmo quando
seriam úteis para métricas internas.

**Verificação:** nenhum caminho de código constrói uma ligação a partir de dado controlado pelo
cliente sem passar pelo control plane.

**❌ Violação actual — a mais séria do sistema.** `getTenantPrismaOrLegacy()`
([`lib/tenant-registry.ts`](../../lib/tenant-registry.ts)) devolve **o cliente legacy** quando o
slug não resolve, quando o warm-up falhou, ou quando o tenant foi criado depois do arranque do
processo. Silenciosamente. As consequências:

- uma leitura devolve dados de outra base sem qualquer sinal;
- pior, uma **escrita** pode aterrar na base errada;
- o cache só carrega tenants `ACTIVE` no arranque: um cliente provisionado hoje é invisível até
  reiniciar o processo — e, até lá, cai no legacy.

**Correcção pretendida:** em produção, falhar com erro explícito; manter o fallback apenas em
desenvolvimento, e sob variável de ambiente. Recarregar o registo quando um slug desconhecido
aparece, antes de desistir.

---

## P5 — Falhar alto, nunca em silêncio

**Afirma:** um erro ou uma pré-condição não satisfeita interrompe com mensagem accionável. Nunca se
continua com valor por omissão nem se devolve sucesso vazio.

**Porquê:** quase tudo aqui corre sem ninguém a ver. Falha silenciosa vira dado errado, que vira
decisão errada semanas depois.

**Custo:** mais paragens visíveis, mais mensagens de erro para escrever.

**Verificação:** `catch` sem log é violação. Fallback sem aviso é violação. Job que devolve `ok`
sem ter feito nada é violação.

**❌ Violações actuais:**

| Sítio | Problema |
|---|---|
| `lib/tenant-registry.ts` | fallback silencioso para legacy (ver P4) |
| `app/api/jobs/refresh-ipf/route.ts` | corre só sobre a base legacy enquanto os outros crons iteram tenants — o operador não tem sinal disto |
| `app/api/jobs/enrich-retail`, `refresh-ipf` | sem guarda `SyncRun`: duas execuções sobrepostas não são detectadas |
| Vários scripts CLI | apanham erro por tenant e continuam (correcto), mas o resumo final nem sempre é lido por ninguém — falta alerta |

---

## P6 — Idempotência em todo o caminho de escrita

**Afirma:** repetir uma operação de escrita externa produz o mesmo estado. Sempre.

**Porquê:** o agente perde rede, o cron dispara duas vezes, o operador carrega outra vez. A resposta
tem de ser sempre "corre de novo".

**Como está feito:** `ingestRunId` + UPSERT set-based na ingestão; `idempotencyKey` determinístico
no `OrderOutbox`; `pg_try_advisory_xact_lock` a serializar agregações por
(pipeline × farmácia) — deliberadamente *transaction-scoped*, para funcionar com pooler.

**Verificação:** toda a ferramenta que escreve tem `--dry-run` por omissão e a segunda execução
reporta zero alterações.

---

## P7 — Determinismo onde há artefactos versionados

**Afirma:** construir o mesmo artefacto a partir das mesmas entradas dá **exactamente** o mesmo
resultado, byte a byte.

**Porquê:** sem isto, "versão" é um rótulo, não uma identidade. Aplica-se a releases de catálogo,
pacotes de agente e relatórios exportados.

**O que exige:** IDs determinísticos (não `cuid()` aleatório), ordenação explícita, serialização
canónica, timestamps fora do hash, snapshot transaccional.

**Verificação:** construir duas vezes e comparar o hash — em CI, não à mão.

**Estado:** por construir. É requisito da fase E do
[Catalog Release System](./catalog-release-system.md).

---

## P8 — Núcleo puro, I/O na fronteira

**Afirma:** as regras de decisão são funções puras, sem Prisma, sem rede, sem relógio. O I/O fica na
borda.

**Porquê:** o que é puro é testável sem base de dados, reutilizável em contextos diferentes e
raciocinável. Exemplos: `lib/movimento-classifier.ts` (partilhado entre servidor e agente,
precisamente porque é puro), `lib/operational/ipf-calculator.ts`, `lib/jobs/cron-auth.ts`,
`catalog-master/_shared.ts`.

**Custo:** mais um passo de composição; o caller passa dados em vez de os ir buscar.

**Verificação:** um módulo de regras que importe `@/lib/prisma` está a violar.

---

## P9 — Fronteira servidor/cliente explícita

**Afirma:** dados e segredos do servidor não atravessam para o browser por acidente.

**Como está feito:** `import "server-only"` nos módulos sensíveis; Prisma nunca em componentes de
cliente; sessão JWT em cookie `httpOnly`; middleware em Edge sem Prisma nem control plane.

**Custo:** por vezes obriga a serializar explicitamente o que o componente de cliente precisa.

**Verificação:** procurar `@/lib/prisma`, `control-plane` ou `tenant-crypto` em ficheiros com
`"use client"`.

**Ressalva:** o cookie de sessão é criado com `secure: false`
([`app/login/actions.ts`](../../app/login/actions.ts)) para permitir acesso por HTTP. Aceitável em
piloto, inaceitável assim que houver domínio com TLS.

---

## P10 — Mudanças aditivas, migrations reversíveis

**Afirma:** acrescentar colunas nullable e tabelas novas; nunca apagar ou renomear numa só
migração. Remover é um processo de duas fases separadas no tempo: parar de usar, depois remover.

**Porquê:** há N bases em produção com dados reais e sem janela de manutenção. Uma migração que
apaga é irreversível em todas ao mesmo tempo.

**Custo:** colunas mortas ficam no schema mais tempo do que se gostaria.

**Verificação:** `DROP COLUMN`, `DROP TABLE` ou renomeação numa migração exigem justificação
explícita e confirmação de que ninguém lê aquilo há pelo menos um ciclo de release.

---

## P11 — Evolução segura em produção

**Afirma:** funcionalidade nova entra desligada, com `--dry-run` por omissão nas ferramentas e
possibilidade de desligar sem redeploy.

**Como está feito:** `ENABLE_AGENT_BOOTSTRAP` a proteger os endpoints de ingestão;
`lib/feature-flags.ts` com kill switches por variável de ambiente; `useMovimentosCanonical` como
flag **por farmácia**, com critérios numéricos de activação (DESCONHECIDO < 1 %, reconcile ≤ 1 %).

Este último é o melhor exemplo do princípio no repositório: uma mudança estrutural de pipeline foi
activada cliente a cliente, com gates medidos.

**Verificação:** uma funcionalidade que não se consegue desligar sem redeploy não está pronta.

---

## P12 — Observabilidade é requisito, não extra

**Afirma:** um processo que corre sozinho tem de deixar rasto estruturado: começou, acabou, com que
contagens, e há quanto tempo.

**Como está feito:** `SyncRun` no control plane (com heartbeat), `PipelineRun` por tenant,
`LoteIngestao`, `lib/pipeline-freshness.ts` (estado `ok|stale|empty|not-implemented` por pipeline),
heartbeat e versão do agente no control plane.

**Custo:** cada job precisa de código de instrumentação que não produz valor visível.

**⚠ Estado parcial:** existe registo, **não existe alerta**. Ninguém é avisado quando um cliente
pára. Prova prática: a 2026-08-04, o heartbeat mais recente de qualquer agente era de 2026-05-20 —
dois meses e meio de silêncio que nenhum mecanismo assinalou. Registo sem alerta é arqueologia, não
observabilidade.

---

## P13 — Não duplicar lógica de enriquecimento

**Afirma:** o mesmo produto não é enriquecido em dois sítios com dois resultados possíveis.

**Porquê:** duplicar não é só desperdício de computação — é fabricar divergência. Dois tenants com
o mesmo CNP e ATC diferente é um sistema que se contradiz.

**❌ Violação por desenho actual:** os crons `enrich-catalog`, `enqueue-regulatory`,
`acquire-regulatory` e `enrich-retail` iteram `forEachActiveTenant` e correm o mesmo trabalho uma
vez por cliente. Com 3 clientes activos são ~45 000 resoluções/dia onde bastariam ~15 000, e três
resultados que podem divergir.

**Correcção aprovada:** [Catalog Release System](./catalog-release-system.md) — enriquecimento uma
vez, contra o Catalog Store; tenants recebem releases. Fase F do roadmap.

---

## P14 — O tenant nunca é fonte de conhecimento canónico

**Afirma:** conhecimento de catálogo flui **da** plataforma **para** os clientes. O caminho inverso
existe apenas como *observação* de baixa autoridade, sujeita a confirmação.

**Porquê:** se o catálogo nasce dentro de um cliente, cria-se dependência de "qual é a melhor base"
— exactamente o problema que motivou toda a reorganização do catálogo.

**Custo:** um cliente que corrige à mão não vê a correcção reflectida imediatamente noutros — passa
pelo ciclo de curadoria e pelo release seguinte. É lentidão deliberada.

**Estado:** em correcção. Hoje o catálogo vive dentro de cada tenant; a harvest de Legacy e
Silveira é a última vez que um tenant é fonte.

---

## P15 — Segredos nunca em código, artefacto ou log

**Afirma:** connection strings, chaves e passwords não entram no repositório, em artefactos
gerados, nem em stdout.

**Como está feito:** passwords de tenant cifradas com AES-256-GCM (`TENANT_ENCRYPTION_SECRET`);
chaves de ingestão guardadas como hash bcrypt; comparação de tokens em tempo constante;
mascaramento de URLs nas ferramentas de catálogo (com teste que o prova); credenciais SMTP cifradas
em base de dados.

**Ressalva:** `TENANT_ENCRYPTION_SECRET` decifra as credenciais de **todas** as bases de clientes e
não pode ser rodada sem re-cifrar `Tenant.dbPassEncrypted`. É o segredo mais valioso do sistema e
não tem hoje procedimento de rotação escrito.

---

## P16 — O schema é o contrato; o código adapta-se

**Afirma:** o modelo de dados é a interface estável entre subsistemas. Quando o mundo exterior
diverge do esperado, adapta-se o código — nunca se assume que o exterior está como devia.

**Porquê:** o ERP de cada farmácia tem colunas diferentes para a mesma coisa. O agente descobre o
schema dinamicamente via `sys.columns` e degrada para `NULL` o que não existe. Foram precisas três
revisões (rev32, rev34, rev37) para aprender isto — cada uma um incidente em cliente real.

**Verificação:** nenhuma query ao ERP nomeia colunas sem descoberta prévia.

---

## Dívida técnica registada

Ordenada por risco. Registar não é comprometer-se a corrigir já — é impedir que se descubra tarde.

| # | Dívida | Risco | Princípio | Esforço |
|---|---|---|---|---|
| D1 | Fallback silencioso para a base legacy na resolução de tenant | **crítico** — escrita na base errada | P4, P5 | baixo |
| D2 | Registo de tenants só carrega no arranque; cliente novo invisível até reiniciar | alto | P4 | baixo |
| D3 | Enriquecimento duplicado por tenant | alto — divergência de catálogo | P13, P14 | alto (em curso) |
| D4 | Sem alertas: ninguém sabe quando um cliente pára (2,5 meses sem heartbeat, não detectado) | **alto** | P12 | médio |
| D5 | Sem CI: `typecheck`, `lint` e os 17 scripts de teste correm à mão; não há `npm test` nem workflow | **alto** — nada impede uma regressão | P7, P12 | médio |
| D6 | Cookie de sessão com `secure: false` | alto assim que houver TLS | P9 | trivial |
| D7 | `refresh-ipf` é single-DB enquanto os outros crons são multi-tenant | médio | P1, P5 | baixo |
| D8 | `enrich-retail` e `refresh-ipf` sem guarda de concorrência | médio | P6 | baixo |
| D9 | `build` corre `prisma migrate deploy` contra a base legacy; tenants migram por script à parte | médio — confunde quem faz deploy | P10 | baixo |
| D10 | ~41 scripts dependem de `legacyPrisma`; nenhum itera tenants | médio | P1 | alto |
| D11 | `Produto` mistura campos de catálogo e de tenant sem fronteira física | médio | P14 | alto |
| D12 | `TENANT_ENCRYPTION_SECRET` sem procedimento de rotação | médio | P15 | médio |
| D13 | Sem retenção em `IngestStocksMovRaw` (2 648 MB = 67 % da maior base) | médio — custo e backups | — | baixo |
| D14 | Testes sem runner comum, sem asserções uniformes, sem cobertura conhecida | médio | — | médio |
| D15 | `InfarmedSnapshot` e `ProdutoVerificacaoHistorico` no schema do tenant sem consumidor real | baixo | P1 | baixo |

**D5 merece destaque:** todos os outros princípios deste capítulo são hoje verificados por revisão
humana. Sem CI, "verificação" significa "alguém se lembrou". As primeiras regras a automatizar são
as que já têm teste escrito — não é trabalho novo, é ligar o que existe.

---

## Oportunidades de simplificação

1. **Retirar o fallback legacy** (D1+D2) elimina uma classe inteira de bugs e simplifica o
   raciocínio sobre qualquer query. É a melhor relação valor/esforço do sistema.
2. **Um só ponto de escrita no catálogo** (P13/P14) apaga o pipeline duplicado e reduz o schema do
   tenant em três tabelas.
3. **Política de retenção no staging** (D13) corta ~1,7 GB da maior base e reduz backups e
   restauros a metade do tempo.
4. **Unificar os scripts CLI numa base comum** (D10): hoje cada script repete resolução de tenant,
   parsing de argumentos e tratamento de erro. Um módulo partilhado reduz ~40 ficheiros a casca
   fina — e torna trivial passar todos a multi-tenant.
5. **Colapsar `InfarmedSnapshot` em `RegulatoryRecord`** (D15): duas tabelas para a mesma coisa, uma
   delas vazia nos tenants.

---

## O que nunca deve ser feito

1. Construir uma ligação a base de dados a partir de dado controlado pelo cliente sem passar pelo
   control plane.
2. Continuar a execução depois de uma pré-condição falhar.
3. Escrever num campo de catálogo fora do motor de resolução.
4. Apagar ou renomear colunas na mesma migração em que se deixa de as usar.
5. Introduzir um segundo caminho de enriquecimento.
6. Escrever uma regra de negócio que dependa do nome de um cliente, base ou tenant.
7. Adicionar um processo automático sem registo de execução.
