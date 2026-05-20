# SPharm.MT Admin Wizard v1

Aplicação desktop Windows para o admin do piloto criar e gerir tenants,
farmácias, utilizadores e pacotes agent — sem terminal.

Substitui o `onboarding-wizard.bat` (CLI interactiva) como ponto de
entrada oficial. O BAT antigo continua a funcionar como fallback
técnico para o developer.

## Princípio

O admin não corre comandos `npm`. Toda a operação é por UI gráfica.
Internamente, o wizard apenas faz shell-out aos scripts npm existentes
(`tenancy:create`, `tenancy:add-farmacia`, `tenancy:add-user`,
`tenancy:status`, `pilot:precheck`, `admin:package-agent`) — não
duplica lógica de negócio nem toca em pipelines, agent runtime ou
schema Prisma.

## Stack

- PowerShell 5.1+ (default em Windows 10/11) + System.Windows.Forms
- Sem novos runtimes no repositório (sem Node extra, sem .NET SDK,
  sem Electron/Tauri)
- Empacotamento via [ps2exe](https://github.com/MScholtes/PS2EXE)
  para gerar `.exe` self-contained
- Fallback `.bat` que arranca o `.ps1` directamente se o `.exe` não
  estiver disponível

## Como arrancar (admin)

**Opção 1 — duplo-click no atalho do root:**

```
C:\projetos\spharm-mt\SPharmMT-Admin-Wizard.bat
```

Este `.bat` usa o `.exe` em `dist-admin/` se existir; senão arranca o
`.ps1` directamente via PowerShell.

**Opção 2 — duplo-click no `.exe` (após build):**

```
C:\projetos\spharm-mt\dist-admin\SPharmMT-Admin-Wizard.exe
```

## Dois modos: STANDALONE e DEV

O wizard funciona em dois modos, detectados automaticamente no arranque:

| | **STANDALONE** | **DEV** |
|---|---|---|
| Para quem | PC de instalação/cliente | developer |
| Como faz o trabalho | HTTPS → endpoints admin do SaaS | shell-out `npm run ...` |
| Precisa de repo/Node/npm/Git | **NÃO** | sim |
| Criar tenant | não (fica em dev) | sim |
| Default | `.exe` fora do repo | `.exe`/`.ps1` dentro do repo |

**Detecção de modo** (no arranque):
1. `SPHARMMT_WIZARD_MODE = dev | standalone` força o modo (override).
2. Senão, se encontrar um repo (`SPHARMMT_REPO_ROOT` ou `package.json`
   subindo da pasta do `.exe`) → **DEV**.
3. Senão → **STANDALONE**.

Em STANDALONE **nunca** aparece diálogo a pedir o repo/`package.json`.

### STANDALONE — porque é replicável

O `.exe` é um cliente HTTPS fino. Os segredos (BD control-plane, chave de
encriptação, Neon) **ficam no servidor** — nunca no PC de instalação. O
PowerShell faz HTTPS nativamente, por isso o PC só precisa do `.exe`.

Operações suportadas em STANDALONE (via `/api/admin/v1/*`):
- listar tenants, ver **status**, **precheck**
- adicionar **farmácias**, criar **utilizadores**
- gerar **Agent ZIP** (o servidor emite/rotaciona a ingest key e devolve
  o `agent.config.json` + a URL do template base; o wizard descarrega o
  base, injecta o config e zipa localmente)

**Criar tenant não está em STANDALONE**: o provisionamento (BD novo +
migrations + Neon) é pesado/privilegiado e corre apenas no ambiente
dev/trusted.

A 1.ª execução pede o **endpoint SaaS** + **admin token**; testa via
`/api/admin/v1/ping` e guarda em
`%APPDATA%\SPharmMT\AdminWizard\config.json`. Os ZIPs gerados e os logs
ficam em `%APPDATA%\SPharmMT\AdminWizard\{output,logs}`.

## Como distribuir para outro PC (STANDALONE)

Pré-requisitos no **servidor** (Vercel) — variáveis de ambiente:

| Variável | Para quê |
|---|---|
| `ADMIN_API_TOKENS` | tokens admin do wizard, separados por vírgula (rotação: adicionar novo, remover antigo). Gerar p.ex. com `openssl rand -hex 32`. |
| `AGENT_BASE_ZIP_URL` | URL (object storage: Vercel Blob / S3 / estática) do ZIP **base** do agente. O wizard descarrega daqui para montar o ZIP por-farmácia. |
| `SPHARMMT_PUBLIC_ENDPOINT` | (opcional) endpoint default do agente no `agent.config.json`. |

Publicar o **artefacto base único** da release (uma vez por release):

```powershell
npm run agent:package
```

Isto produz, além da pasta `dist-agent/SPharmMT-Agent/`, o ZIP base:

```
dist-agent/spharmmt-agent-base-rev<N>.zip      # <N> = AGENT_REV (ex.: 26)
```

Esse ZIP contém **apenas** o runtime/template comum do agent (node.exe,
agent.cjs, wrappers .bat, `agent.config.example.json`) — **sem** dados de
tenant/farmácia, sem `agent.config.json` real. É o único artefacto a
publicar em storage por release.

**Onde configurar `AGENT_BASE_ZIP_URL`:** Vercel → projeto SPharm.MT →
**Settings → Environment Variables** → adicionar
`AGENT_BASE_ZIP_URL = <url público do zip>` → **Redeploy**.

No **PC de instalação**:
1. Copiar **apenas** a pasta `dist-admin/` para qualquer sítio (ex.:
   `C:\SPHARMMT\`).
2. Duplo-click em `SPharmMT-Admin-Wizard.exe`.
3. Na 1.ª vez, introduzir o **endpoint SaaS** e o **admin token**. O
   wizard testa e guarda. Pronto a usar.

Não é preciso repo, Node, npm nem Git no PC. Para mudar de servidor/token
mais tarde: clicar **Refresh** com credenciais inválidas → o wizard
oferece reconfigurar (ou apagar o `config.json`).

## Agent ZIP standalone — fluxo e teste

Geração de um ZIP por farmácia, **sem dev/Claude** envolvido:

1. O wizard faz `POST /api/admin/v1/tenants/{slug}/agent-package` com a
   farmácia, endpoint, key (existente ou `rotate`) e pré-fill SQL.
2. O servidor **resolve a farmácia** na BD do tenant, **emite/rotaciona**
   a ingest key (control plane) e devolve:
   - `baseAgentUrl` (do `AGENT_BASE_ZIP_URL`)
   - `tenantSlug`, `farmaciaId`, `farmaciaNome`, `endpoint`
   - `key` (em claro, se emitida/rotacionada) + `keyAction`
   - `config` (o `agent.config.json` pronto) + `suggestedName`
3. O wizard **descarrega** o `baseAgentUrl`, **injecta** o
   `agent.config.json` da farmácia e **zipa** localmente em
   `%APPDATA%\SPharmMT\AdminWizard\output\<slug>-<data>-<rand>.zip`.

O ZIP base é descarregado tal-e-qual; só o `agent.config.json` é
gerado/injectado por farmácia. O `node.exe`/runtime nunca passa pela
função Vercel.

**Como testar pelo wizard:**
1. Garantir no Vercel: `ADMIN_API_TOKENS` + `AGENT_BASE_ZIP_URL` (apontar
   para o `spharmmt-agent-base-rev<N>.zip` publicado) + redeploy.
2. Abrir `dist-admin\SPharmMT-Admin-Wizard.exe` (fora do repo). Configurar
   endpoint SaaS + admin token (1.ª vez).
3. Seleccionar o tenant → Tab **Agent ZIP** → indicar a farmácia (nome
   exacto, tem de existir no tenant) + endpoint + key/rotate → **Gerar**.
4. Confirmar no painel: farmácia resolvida + caminho do ZIP. Abrir a
   pasta com **Abrir pasta dos ZIPs**.

## Endpoints admin do SaaS (`/api/admin/v1/*`)

Auth: `Authorization: Bearer <token de ADMIN_API_TOKENS>`.

| Método | Rota | Operação |
|---|---|---|
| GET | `/ping` | teste de ligação/auth |
| GET | `/tenants` | listar tenants |
| GET | `/tenants/{slug}/status` | status do tenant |
| GET | `/tenants/{slug}/precheck` | precheck go-live |
| POST | `/tenants/{slug}/farmacias` | adicionar farmácia |
| POST | `/tenants/{slug}/users` | criar utilizador |
| POST | `/tenants/{slug}/agent-package` | emitir/rotar key + config do agente |

A lógica reutiliza os mesmos libs privilegiados dos scripts CLI
(`lib/control-plane`, `lib/admin/*`) — sem duplicar provisionamento.

## Modo DEV (developer) — repo root

Em DEV o wizard resolve a raiz do repo por: `SPHARMMT_REPO_ROOT` →
auto-detecção (sobe da pasta do `.exe`/`.ps1`) → selector de pasta se
forçado a DEV sem repo. Para forçar uma raiz fixa:

```powershell
$env:SPHARMMT_REPO_ROOT = "C:\projetos\spharm-mt"
```

## Como compilar o `.exe` (developer)

```powershell
npm run admin-wizard:build
```

ou directamente:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File admin-wizard\build.ps1
```

O build:
1. Copia `SPharmMT-Admin-Wizard.ps1` para `dist-admin/`
2. Gera `dist-admin/SPharmMT-Admin-Wizard.bat` (launcher fallback)
3. Tenta instalar o módulo `ps2exe` para o utilizador actual (PSGallery)
4. Compila `dist-admin/SPharmMT-Admin-Wizard.exe`

Se `ps2exe` não puder ser instalado (sem internet, sem permissões),
o build termina com fallback `.bat` apenas e mensagem clara.

Para skipar a compilação (só gerar o `.bat` + cópia do `.ps1`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File admin-wizard\build.ps1 -SkipExe
```

## Para correr em modo dev (sem build)

```powershell
npm run admin-wizard:run
```

Arranca o `.ps1` directamente. Útil para iterar sem rebuild.

## Estrutura da UI

### Cabeçalho

- Dropdown **Tenant activo** — carrega via `tenancy:list --json` no
  arranque e quando se clica em **Refresh**
- Repo root (read-only)
- Status bar — mostra a operação em curso

### Tab A — Grupo / Tenant

Cria um novo grupo (tenant) com BD, migrations, admin e ingest key.

Campos:
- Slug (lowercase + hífens, obrigatório, único)
- Nome grupo (obrigatório)
- Email admin (obrigatório, validação `contém @`)
- Provider: `neon` / `manual` / `local`
- Database URL (só visível se provider=manual)
- Region (default `eu-west-2`)
- Farmácias iniciais (lista separada por vírgulas, opcional)
- Dry-run (checkbox — valida sem criar)

Acção:
- **Criar tenant** (botão vermelho) — exige confirmação `CONFIRMO`
- No fim: dialog modal mostra **uma vez** as credenciais
  (admin email + password + ingest key + tenant id) com botão
  copy-to-clipboard

Internamente chama: `npm run tenancy:create -- --json --quiet ...`

### Tab B — Farmácias

Adiciona uma farmácia ao tenant seleccionado.

Campos:
- Nome (obrigatório, único no tenant)
- Código ANF (opcional)
- Morada, Contacto (opcional)

Acções:
- **Adicionar farmácia** — exige `CONFIRMO`
- **Listar farmácias (via status)** — corre `tenancy:status` e mostra
  a secção das farmácias

Internamente chama: `npm run tenancy:add-farmacia -- ...`

### Tab C — Utilizadores

Cria um utilizador no tenant seleccionado.

Campos:
- Email (obrigatório, validado)
- Nome (obrigatório)
- Role (ComboBox): `ADMINISTRADOR` / `GESTOR_GRUPO` /
  `GESTOR_FARMACIA` / `OPERADOR`
- Farmácia (obrigatório para `GESTOR_FARMACIA` / `OPERADOR`)
- Password manual (opcional — vazio gera aleatória)

Acção:
- **Criar utilizador** — exige `CONFIRMO`
- Se a password foi gerada: dialog modal mostra **uma vez** a password
  com copy-to-clipboard
- Utilizador é criado com `mustChangePassword=true` (trocar no
  primeiro login)

Internamente chama: `npm run tenancy:add-user -- ...`

### Tab D — Agent ZIP

Gera o pacote ZIP do agent para uma farmácia.

Campos:
- Farmácia (nome exacto, deve coincidir com o de B)
- Endpoint SaaS (default `https://app.spharmmt.app`)
- Healthcheck URL (opcional, https://hc-ping.com/&lt;uuid&gt;)
- Ingest key:
  - **Usar key existente** (default) — cola a key actual (não invalida
    agents existentes)
  - **Rotacionar** — emite nova key, **invalida** todas as anteriores;
    exige confirmação adicional escrevendo `ROTACIONAR`
- Pré-fill SQL Server (opcional): host, port, database, user

Acções:
- **Gerar ZIP agent**
- **Abrir pasta dos ZIPs** — abre `dist-agent/clients/` no Explorer

Se rotacionou: dialog modal mostra **uma vez** a nova key.

Internamente chama: `npm run admin:package-agent -- ...`

### Tab E — Status / Precheck

Operações read-only sobre o tenant seleccionado.

Acções:
- **Ver status** — corre `tenancy:status`
- **Rodar pilot:precheck** — corre `pilot:precheck`
- **Abrir pasta dos ZIPs**
- **Abrir logs**

Internamente chama: `npm run tenancy:status`, `npm run pilot:precheck`

## Segurança

- **Secrets** (admin password, ingest key) só aparecem em dialog modal
  com botão copy-to-clipboard; nunca são escritos no log textual
- **Confirmação explícita** (`CONFIRMO`) para todas as acções com
  side-effect:
  - Criar tenant
  - Adicionar farmácia
  - Criar utilizador
  - Gerar ZIP
  - Rotacionar ingest key (`ROTACIONAR` em vez de `CONFIRMO`)
- **Duplicados** detectados antes da chamada npm (slug já existente
  na lista carregada)
- **Args sensíveis** (`--admin-password`, `--password`, `--key`)
  redacted no log com `[REDACTED]` antes de escrever
- **Logs** vão para `logs/admin-wizard-YYYY-MM-DD.log`, append-only,
  sem secrets

## Log e auditoria

Cada operação escreve uma linha no log com:
- timestamp ISO
- nível (`INFO`, `ERROR`)
- comando npm sanitizado (args com secrets substituídos)

Exemplo:
```
2026-05-15 14:32:01 [INFO] wizard arrancado (repo=C:\projetos\spharm-mt)
2026-05-15 14:33:12 [INFO] npm run --silent tenancy:create -- --slug=novo --name=Novo --admin-email=a@b.pt --provider=neon --json --quiet
2026-05-15 14:33:38 [INFO] npm run --silent admin:package-agent -- --tenant=novo --farmacia=Farmácia X --endpoint=https://app.spharmmt.app --key=[REDACTED]
```

## Limitações conhecidas

- Apenas Windows (depende de WinForms + PowerShell). Não corre em
  Linux/macOS — mas o admin do piloto opera em Windows.
- O wizard exige que `npm` esteja no PATH (já é requisito do repo).
- Operações são síncronas: cada tab só pode correr uma operação de
  cada vez; os botões ficam desactivados enquanto npm está a correr.
  Para piloto (volume baixo) é aceitável.
- Sem listagem visual de farmácias/utilizadores existentes — para
  ver, usar Tab E → **Ver status**.

## Não inclui

Conforme o escopo autorizado do freeze:
- Não toca no pipeline ingest
- Não toca no dashboard
- Não toca no agent runtime
- Não adiciona features SaaS
- Não introduz queues/workers/websockets
- Não altera schema Prisma nem cria migrations
- Não muda o contrato agent↔SaaS

É **apenas camada UI sobre os scripts existentes**.

## Rollback

Se o wizard introduzir um bug bloqueante:
1. O admin volta a `onboarding-wizard.bat` (que continua a funcionar)
2. Os scripts npm subjacentes não foram tocados, logo o fluxo CLI
   continua disponível na íntegra
3. Apagar `dist-admin/` e remover os ficheiros `admin-wizard/` reverte
   a entrega sem efeitos colaterais (não há migrations, não há schema
   changes)
