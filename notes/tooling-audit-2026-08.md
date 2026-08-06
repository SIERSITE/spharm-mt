# Auditoria funcional das ferramentas operacionais — 2026-08-06

Levantamento do que **já existe** para operar o SPharm.MT, antes de
qualquer alteração. Nenhum código foi modificado para produzir este
documento.

Método: inspecção do repositório (`git ls-files`, leitura de ficheiros) e
**execução** de duas verificações mecânicas, assinaladas em §7. Tudo o
resto é inspecção — está dito onde.

---

## 0. Três achados que mudam o plano

**Não existe nenhum `Criar_BD` neste repositório.** Procurei por
`Criar_BD`, `CriarBD` e `criar-bd`, sem filtro de extensão, em toda a
árvore: zero ocorrências. A criação de bases de dados é feita por
`lib/db-providers/local-postgres.ts` (CREATE ROLE + CREATE DATABASE),
invocada por `tenant:create --provider=local --create-db`. Se existe um
`Criar_BD.exe` fora do repositório, não está aqui e não consigo auditá-lo
— é preciso o ficheiro.

**Não existe `spharmmt-agent-base-rev30`.** A única referência a uma
revisão base no código é `rev26` (em `scripts/admin/upload-agent-base.ts`
e `docs/admin-wizard.md`, ambos como exemplo). Em disco existem
`dist-agent/spharmmt-agent-base-rev41..45.zip`, e `agent/build.mjs` tem
`AGENT_REV = "45"`. A URL publicada em produção (registo do projecto)
aponta para **rev39**. Ou seja: há seis revisões construídas localmente
à frente da que está publicada.

**A criação de tenants é o único fluxo do Admin Wizard sem caminho por
API.** Todas as outras acções do wizard tentam primeiro a API de admin e
só caem para `npm` se ela falhar. A criação chama `tenancy:create`
directamente (`admin-wizard/SPharmMT-Admin-Wizard.ps1:1725`), e
`app/api/admin/v1/tenants/route.ts` exporta **apenas `GET`**. Não há
`POST /api/admin/v1/tenants`. Isto é o que impede hoje um técnico de
criar um cliente na VPS sem terminal.

---

## 1. Inventário

### 1.1 Interfaces gráficas e lançadores Windows

| Ferramenta | Caminho | Tipo | Função | Alvo | Estado |
|---|---|---|---|---|---|
| Admin Wizard | `admin-wizard/SPharmMT-Admin-Wizard.ps1` (89 KB) | PowerShell + WinForms | GUI com 5 separadores: Grupo/Tenant, Farmácias, Utilizadores, Agent ZIP, Status/Precheck | Técnico SIER | Activo, oficial |
| Admin Wizard (build) | `admin-wizard/build.ps1` | PowerShell | Compila o `.ps1` para `.exe` (ps2exe) | Dev | Activo |
| Admin Wizard (distribuído) | `dist-admin/SPharmMT-Admin-Wizard.{exe,ps1,bat}` | EXE + PS1 + BAT | Cópia distribuível | Técnico | **Ver risco em §5** |
| Lançador oficial | `SPharmMT-Admin-Wizard.bat` (raiz) | BAT | Duplo-clique: usa o `.exe` se existir, senão o `.ps1` | Técnico | Activo |
| Onboarding Wizard | `scripts/onboarding-wizard.ps1` (18 KB) | PowerShell consola | Wizard de texto: `tenancy:create`, `add-farmacia`, `status`, `package-agent`, `precheck` | Técnico | **Substituído** pelo Admin Wizard |
| Lançador antigo | `onboarding-wizard.bat` (raiz) | BAT | Chama o wizard de consola | Técnico | Legado |

O Admin Wizard tem dois modos de execução, e a distinção é decisiva:

- **Modo API** — `Invoke-AdminApi`, `Bearer $AdminToken` contra
  `$SaasBaseUrl` (configurável na UI, default `https://app.spharmmt.app`).
  Não precisa de repositório, nem de Node, nem de acesso à base.
- **Modo npm** — `Invoke-AdminCommand` lança `npm run <script>` na raiz
  do repositório. Precisa do checkout, do `npm`, e das variáveis de
  ambiente da base.

### 1.2 Agent on-premise

| Ferramenta | Caminho | Tipo | Função | Alvo | Estado |
|---|---|---|---|---|---|
| Agent CLI | `agent/src/cli.ts` + 34 comandos | Node/TS → `agent.cjs` | Lê SQL Server do SPharm, envia para `/api/ingest/v1/*` | Farmácia | Activo |
| Empacotador base | `agent/build.mjs` | Node | esbuild → `agent.cjs`, embute `node.exe` v20.18.0, gera **39 `run-*.bat`**, produz `spharmmt-agent-base-rev<N>.zip` | Dev | Activo (rev45) |
| Pacote por cliente | `scripts/admin/package-agent.ts` | Node/CLI | Copia o base, injecta `agent.config.json` (tenant, farmácia, ingest key), zipa | Técnico | Activo |
| Publicação do base | `scripts/admin/upload-agent-base.ts` | Node/CLI | Envia o ZIP base para **Vercel Blob** | Dev | **Depende da Vercel** |
| Instalação Windows | `agent/INSTALL_WINDOWS.md`, `agent/RUN_DISCOVERY.md` | Documentação | Instalação e agendamento na farmácia | Operador | Activo |

Comandos do agent, por família (`agent/src/commands/`):

- **Descoberta**: `discover`, `discover-products`, `discover-sales`,
  `discover-stock`, `inspect-*` (5), `probe-table`, `test-connection`
- **Pré-visualização**: `products-preview`, `sales-preview`,
  `stock-preview`, `sales-summary-preview`
- **Carga inicial**: `bootstrap-dry-run`, `bootstrap-upload`,
  `products-upload`, `stock-upload`, `full-sync`, `stocksmov-*`
- **Compras/devoluções/fornecedores**: `compras`, `devolucoes-fornecedor`,
  `fornecedores` (cada um com dry-run e upload)
- **Diário**: `daily-sync`, `daily-pipeline`, `daily-sync-runner`
- **Encomendas (escrita no ERP)**: `export-orders`,
  `setup-orders-write-log`, `test-order-write`
- **Auditoria**: `movimentos-audit`, `iva-audit`, `health`

Todos correspondem a um `run-<comando>.bat` no ZIP — o operador da
farmácia nunca escreve uma linha de comando.

### 1.3 Tenants, utilizadores e bases de dados

| npm script | Ficheiro | Função |
|---|---|---|
| `tenant:create` / `tenancy:create` | `scripts/admin/create-client.ts` | **Comando oficial**: cria base + role + tenant + admin + farmácias + ingest key |
| `tenancy:provision` | `scripts/tenancy/provision-tenant.ts` | Provisionamento de base (mais antigo, mais baixo nível) |
| `tenant:onboard` | `scripts/tenancy/onboard-tenant.ts` | Onboarding assistido |
| `tenancy:add-farmacia` | `scripts/tenancy/add-farmacia.ts` | Farmácia nova num tenant |
| `tenancy:add-user` | `scripts/tenancy/add-user.ts` | Utilizador (`ADMINISTRADOR`, `GESTOR_GRUPO`, `GESTOR_FARMACIA`, `OPERADOR`) |
| `admin:reset-user-password` | `scripts/admin/reset-user-password.ts` | Reset de senha (**não cria** utilizadores) |
| `tenancy:issue-ingest-key` | `scripts/tenancy/issue-ingest-key.ts` | Emite/roda a ingest key; recusa reemitir sem `--rotate` |
| `tenancy:list` / `:status` / `:health` | `scripts/tenancy/` | Listagem, estado, saúde |
| `tenancy:migrate-all` | `scripts/tenancy/migrate-all-tenants.ts` | `prisma migrate deploy` em cada tenant |
| `tenancy:deactivate` / `:reactivate` | `scripts/tenancy/` | Suspender / repor (flag `--slug`) |
| `tenancy:cleanup-failed` | `scripts/tenancy/cleanup-failed-tenant.ts` | Limpa tenants **FAILED** (recusa ACTIVE) |
| `control:create-global-admin` | `scripts/control/create-global-admin.ts` | Primeiro GlobalAdmin do control plane |
| `control:migrate:deploy` / `:status` | `scripts/control/` | Migrations do control plane |

### 1.4 Importação de dados

| Ferramenta | Caminho | Alvo de escrita | Estado |
|---|---|---|---|
| Importador Excel | `scripts/import-excel.ts` + `lib/importer.ts` | **base legacy** (`legacyPrisma`) | Legado — não multi-tenant |
| Agent de pasta | `scripts/agent/ingest-folder.ts` | API `/api/ingest/v1/*` | Activo, multi-tenant |
| Catálogo mestre | `scripts/catalog-master/{export,import,audit}-catalog.ts` | control plane + tenants | Activo |
| INFARMED / regulatório | `scripts/import-infarmed-snapshot.ts`, `import-regulatory-record.ts`, `import-details-to-regulatory.ts`, `import-mapping-to-regulatory-record.ts` | legacy/enriquecimento | Activo |
| Fabricantes XLSX | `scripts/update-fabricantes-from-xlsx.ts` | legacy | Ad-hoc |

O próprio `scripts/import-excel.ts` documenta a fronteira: *"CLI default:
legacy DB. Para multi-tenant, usar `/api/ingest/v1/*`."*

### 1.5 Diagnóstico e suporte

`pilot:precheck` (`scripts/pilot-precheck.ts`), `env:doctor`
(`scripts/env-doctor.ts`), `pipeline:health`, `tenancy:health`,
`tenancy:debug-ingest-auth`, `tenancy:smoke-resolver`,
`/api/admin/enrichment-health`, e ~43 scripts ad-hoc em `scripts/admin/`
(`check-*`, `inspect-*`, `diag-*`, `smoke-*`, `verify-*`).

Do lado da infra-estrutura: `deploy/scripts/verify-platform.sh`,
`healthcheck.sh`, `backup-platform.sh`, `restore-platform.sh`,
`update-platform.sh`.

### 1.6 API de administração

| Rota | Métodos | Função |
|---|---|---|
| `/api/admin/v1/ping` | GET | Vivo? `agentBaseConfigured`? |
| `/api/admin/v1/tenants` | **GET apenas** | Listar |
| `/api/admin/v1/tenants/{slug}/farmacias` | POST | Criar farmácia |
| `/api/admin/v1/tenants/{slug}/users` | POST | Criar utilizador |
| `/api/admin/v1/tenants/{slug}/agent-package` | POST | Emitir key + devolver `agent.config.json` e `baseAgentUrl` |
| `/api/admin/v1/tenants/{slug}/status` | GET | Estado |
| `/api/admin/v1/tenants/{slug}/precheck` | GET | Pré-check de go-live |

Autenticação: `ADMIN_API_TOKENS` (`lib/admin/api-token.ts`).

---

## 2. Mapa de fluxos

**Onboarding de cliente** — Admin Wizard §A → `tenancy:create` (npm,
**só local**) → §B farmácias (API) → §C utilizadores (API) → §D Agent ZIP
(API + montagem local do ZIP) → §E precheck (API).

**Criação de tenant** — `tenant:create --provider=local --create-db`:
`selectProvider` → `LocalPostgresProvider.createDatabase` (CREATE ROLE +
CREATE DATABASE + GRANT) → registo no control plane → admin + farmácias →
ingest key. Depois `tenancy:migrate-all` aplica o schema.

**Instalação do agent** — `agent:package` (base) → `agent:publish-base`
(Vercel Blob) → wizard §D pede `agent-package` à API → descarrega o base,
injecta `agent.config.json`, zipa → operador extrai na farmácia e corre
`run-test-connection.bat`.

**Importação inicial** — `run-discover.bat` → `run-*-preview.bat` →
`run-bootstrap-dry-run.bat` → `run-bootstrap-upload.bat` (ou
`run-full-sync-upload.bat`) → `/api/ingest/v1/bootstrap/*`.

**Sincronização diária** — `run-daily-pipeline-auto.bat` no Task
Scheduler → `daily-sync` + agregação → `/api/ingest/v1/snapshot/*` e
`/api/admin/pipeline/*`. Dead-man switch opcional (`healthcheckUrl`).

**Manutenção e suporte** — `tenancy:status`, `:health`,
`pilot:precheck`, `debug-ingest-auth`, `run-health.bat`, `iva-audit`,
`movimentos-audit`.

**Desactivação e recuperação** — `tenancy:deactivate --slug`
(suspend/deactivate, `--revoke-connect`) → `tenancy:reactivate --slug`.
`tenancy:cleanup-failed` só para FAILED.

---

## 3. Compatibilidade com a stack self-hosted

### Funciona sem alterações

- Agent CLI e os 39 `run-*.bat` — o endpoint é dado por
  `agent.config.json`; apontar para a VPS é editar um campo
- Wizard em **modo API**: farmácias, utilizadores, status, precheck
- Todos os comandos `tenancy:*`, `control:*`, `tenant:create` **dentro do
  container migrator** (verificado: 36/36 no `live-tenant-lifecycle.sh`)
- `catalog-master`, `ingest-folder`

### Funciona com configuração

- Wizard em modo API: mudar o URL base para a VPS e colar o
  `ADMIN_API_TOKEN` que o `install-platform.sh` já gera
  (`install-platform.sh:483`, exportado como `ADMIN_API_TOKENS` em
  `install-stack.sh:465`)
- `?__tenant=<slug>`: `TENANT_FALLBACK_ENABLED=1` já é escrito
  (`install-platform.sh:638`)

### Está partido na VPS

- **Wizard §A (criar tenant)** — chama `npm run tenancy:create` na
  máquina do técnico. Contra a VPS, essa máquina não tem
  `CONTROL_DATABASE_URL` nem alcance à base (o PostgreSQL não publica
  porto). Sem terminal na VPS, não há como criar um cliente.
- **Wizard §D (Agent ZIP)** — `agent-package` devolve
  `baseAgentUrl: process.env.AGENT_BASE_ZIP_URL ?? null`
  (`lib/admin/ops/agent-package.ts:207`) e **nenhum script de deploy
  escreve `AGENT_BASE_ZIP_URL`** (confirmado: 0 ocorrências em
  `deploy/`). O wizard responde *"Servidor nao devolveu baseAgentUrl"* e
  pára.
- **`admin:package-agent`** — não está no manifesto da imagem tools e
  depende de `dist-agent/SPharmMT-Agent/` existir em disco.

### Depende da Vercel / Neon

- `agent:publish-base` — `@vercel/blob` + `BLOB_READ_WRITE_TOKEN`. É o
  **único** acoplamento à Vercel no caminho operacional.
- `--provider=neon` — opcional; continua a funcionar, não é usado na VPS.

### Depende da base legacy

- `scripts/import-excel.ts` (+ `lib/importer.ts`) e ~40 scripts de
  enriquecimento/análise em `scripts/` que importam `legacyPrisma`.

### Não deve ser usado em produção

- `scripts/onboarding-wizard.ps1` e `onboarding-wizard.bat` — o
  `SPharmMT-Admin-Wizard.bat` diz-se explicitamente o substituto
- Os ~43 scripts ad-hoc de `scripts/admin/` (`check-*`, `inspect-*`,
  `diag-*`) — investigação pontual, deliberadamente fora da imagem
- `scripts/delete-farmacia-teste.ts` e afins

---

## 4. Duplicações

| Sobreposição | Oficial | Manter porquê |
|---|---|---|
| `tenant:create` ≡ `tenancy:create` | qualquer (mesmo ficheiro) | Os dois nomes circulam na documentação |
| `tenant:create` vs `tenancy:provision` vs `tenant:onboard` | **`tenant:create`** | `provision` é a camada de baixo nível que o `create` usa; `onboard` é fluxo assistido |
| Admin Wizard (GUI) vs `onboarding-wizard.ps1` (consola) | **Admin Wizard** | O de consola pode sair quando o GUI cobrir a criação de tenant |
| `SPharmMT-Admin-Wizard.bat` vs `onboarding-wizard.bat` | **o primeiro** | — |
| `tenancy:list` vs `scripts/admin/list-tenants.ts` | **`tenancy:list`** | O de `admin/` é ad-hoc |
| `import-excel` vs `ingest-folder` vs API de ingest | **API de ingest** | O Excel serve dados históricos legados |
| Wizard modo API vs modo npm | **API** | O npm é a rede de segurança quando a API não responde |

---

## 5. Lacunas

**Deixou de funcionar**

1. Criar tenant a partir do wizard contra a VPS (não há `POST /tenants`).
2. Gerar Agent ZIP no wizard contra a VPS (`AGENT_BASE_ZIP_URL` não é
   configurado por nenhum script de deploy).

**Falta integrar com a VPS**

3. `AGENT_BASE_ZIP_URL` no `platform.env` — e um sítio de onde servir o
   ZIP que não seja a Vercel Blob (a alternativa mais simples é servi-lo
   do próprio nginx, a partir de `/opt/spharmmt/`).
4. `admin:package-agent` no manifesto `tools-scripts.txt`, se se quiser
   gerar pacotes na VPS.
5. Risco de artefacto: `dist-admin/SPharmMT-Admin-Wizard.exe` está em
   HEAD, mas o `.ps1` ao lado dele **não está** (só em *staging*). Não é
   verificável se o `.exe` publicado corresponde ao `.ps1` actual — só
   reconstruindo. O `.exe` é o que o técnico executa por duplo-clique.

**Para um técnico trabalhar sem terminal**

6. Só falta o ponto 1 (criar tenant) e o ponto 2 (Agent ZIP). Tudo o
   resto do ciclo já é acessível pela GUI via API.

**Para importar dados de uma farmácia real**

7. Nada em falta no caminho principal: o agent fala com
   `/api/ingest/v1/*` por ingest key, e o endpoint é configurável. O que
   falta é operacional — gerar o ZIP (ponto 2) e publicar um base
   actualizado (o publicado é rev39, o local é rev45).

---

## 6. Plano mínimo de adaptação

Sem CLI nova, sem EXE novo, sem substituir nada. Por ordem de risco
crescente:

**1 — `AGENT_BASE_ZIP_URL` no `platform.env`** *(risco: nenhum)*
Acrescentar a chave ao `install-platform.sh`, vazia por defeito. Desbloqueia
o §D do wizard assim que houver um URL. Serve já para apontar ao Blob
existente enquanto a Vercel estiver de pé.

**2 — Servir o ZIP base a partir do nginx** *(risco: baixo)*
`location /agent-base/` sobre um directório em `/opt/spharmmt/`. Remove o
último acoplamento à Vercel no caminho operacional. O
`upload-agent-base.ts` fica para trás sem ser apagado.

**3 — `admin:package-agent` na imagem tools** *(risco: baixo)*
Uma linha em `tools-scripts.txt`; a auditoria do build diz que ficheiros
faltam. Precisa de decidir onde vive o `dist-agent/` na VPS.

**4 — `POST /api/admin/v1/tenants`** *(risco: médio — é a única mudança
de superfície)*
Um handler fino sobre `lib/admin/create-client-workflow.ts`, que é
exactamente o que o `tenant:create` já usa. Não é uma ferramenta nova: é
a mesma lógica exposta pelo transporte que o wizard já fala. Requer
cuidado com o tempo de execução (criar base + migrations pode passar dos
30 s do `maxDuration` actual) e com o facto de a senha e a ingest key só
poderem ser mostradas uma vez.

**5 — Reconstruir e recommitar `dist-admin/`** *(risco: baixo)*
Para que o `.exe` e o `.ps1` sejam verificavelmente o mesmo código.

**6 — Publicar um base rev45** *(risco: baixo, depende de 1/2)*

Não recomendo tocar em: `scripts/import-excel.ts` (legado, funciona para
o que serve), nos scripts ad-hoc de `scripts/admin/`, nem no wizard de
consola — que pode ser retirado, mas só depois do ponto 4.

---

## 6b. Auditoria rev39 (publicada) vs rev45 (construída)

Veredicto: **não publicar a rev45.** Duas razões independentes, ambas
verificáveis em git.

**1. A rev45 não existe em git.** `HEAD:agent/build.mjs` tem
`AGENT_REV = "44"`. A rev45 é o estado da working tree, com
`agent/src/commands/products-upload.ts` por versionar e
`bootstrap-upload.ts`, `http-client.ts` e `cli.ts` modificados. Publicar
a partir daí entregaria às farmácias código que ninguém consegue
recuperar de um commit — a mesma classe de falha do
`prisma-control.config.ts`, que já custou um build inteiro.

**2. Precisa de um endpoint que não está implantado.**
`agent/src/http-client.ts:157` chama
`POST /api/ingest/v1/bootstrap/products/finalize`. Esse handler existe em
disco (`app/api/ingest/v1/bootstrap/products/finalize/route.ts`) mas
**não está em HEAD**. Um agent rev45 contra qualquer build actual do SaaS
recebe 404 no fecho do upload de produtos.

A rev44 (HEAD) não usa esse endpoint — `git show
HEAD:agent/src/commands/bootstrap-upload.ts | grep -c finalize` dá 0.

Entre a rev39 publicada e a rev44 em HEAD há quatro revisões, todas de
IVA (`4a1c121` rev40, `9c54511` rev41, `8b4f85c` rev42, `2e0e3ef` rev44)
mais o bugfix `2d972fa`. Nenhuma introduz endpoints novos.

**Ordem correcta para actualizar o agent publicado:**

1. commitar o trabalho da rev45 **e** o endpoint `finalize`;
2. implantar o SaaS com esse endpoint;
3. só então `npm run agent:package` e publicar;
4. testar `run-bootstrap-upload.bat` contra a stack antes de entregar a
   uma farmácia.

Enquanto isso não acontecer, publicar a **rev44** é seguro (não precisa
de nada que não esteja implantado) e traz as quatro revisões de IVA.

## 7. Prova

**Executado** (dois comandos, ambos de leitura):

- Verificação de que os 54 `scripts` do `package.json` têm o ficheiro de
  entrada em disco → **54/54 presentes, 0 em falta**.
- `git cat-file -t HEAD:<ficheiro>` para cada ferramenta Windows → todas
  em HEAD **excepto** `dist-admin/SPharmMT-Admin-Wizard.ps1`.

Reaproveitado de trabalho já validado nesta sessão (execução real, não
inspecção): `deploy/tests/live-tenant-lifecycle.sh` (36/36) provou
`tenant:create --provider=local --create-db`, `tenancy:migrate-all`,
`list`, `status`, `health`, `add-farmacia`, `add-user`,
`reset-user-password`, `issue-ingest-key`, `deactivate`, `reactivate` e
`GET /login?__tenant=` dentro da stack self-hosted.
`deploy/docker/audit-tools-entrypoints.mjs` reporta **22 entrypoints e
100 módulos** presentes na imagem migrator.

**Apenas inspeccionado** (não executado): Admin Wizard e o `.exe`, agent
CLI contra um SQL Server real, `agent:publish-base`, `import-excel`,
`catalog-master`, e as rotas `/api/admin/v1/*`.

**Ficheiros que sustentam as conclusões principais**

| Conclusão | Ficheiro |
|---|---|
| Criar tenant é npm-only no wizard | `admin-wizard/SPharmMT-Admin-Wizard.ps1:1725` |
| As outras acções são API-first | idem, linhas 1791, 1851, 1972, 2017, 2029 |
| Não há `POST /tenants` | `app/api/admin/v1/tenants/route.ts:18` (só `GET`) |
| `baseAgentUrl` pode vir nulo | `lib/admin/ops/agent-package.ts:207` |
| `AGENT_BASE_ZIP_URL` não é configurado no deploy | ausência em `deploy/scripts/*.sh` |
| `ADMIN_API_TOKEN` é gerado na VPS | `install-platform.sh:483`, `install-stack.sh:465` |
| `TENANT_FALLBACK_ENABLED=1` na VPS | `install-platform.sh:638` |
| Único acoplamento à Vercel | `scripts/admin/upload-agent-base.ts` (`@vercel/blob`) |
| Importador escreve na legacy | `scripts/import-excel.ts:20` (`legacyPrisma`) |
| Criação de base de dados | `lib/db-providers/local-postgres.ts:42` |
| 39 `run-*.bat` | `agent/build.mjs` |
| `AGENT_REV=45` vs publicado rev39 | `agent/build.mjs:51`, `dist-agent/*.zip` |
