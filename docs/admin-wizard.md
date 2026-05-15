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
