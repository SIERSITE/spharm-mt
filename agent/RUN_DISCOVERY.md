# Run Discovery — Guia Operacional

> Para correr **uma vez** no servidor on-premise da farmácia. Recolhe metadata do schema do ERP SPharm (read-only, sem dados de negócio) e produz dois ficheiros para enviar ao dev fazer o mapping.

**Tempo estimado:** 15 minutos (5 min setup + 5 min config + 5 min execução).

---

## 0. Pré-requisitos no servidor

| Requisito | Como confirmar |
|---|---|
| **Node.js ≥ 20** instalado | `node --version` deve mostrar `v20.x.x` ou superior |
| **Acesso ao SQL Server** SPharm | Capaz de abrir SQL Server Management Studio e fazer SELECT na BD |
| **Permissão para criar login SQL read-only** | Tipicamente é o informático/responsável do ERP. Ver [agent/SECURITY.md §1](SECURITY.md) |
| **Ingest key** comunicada pelo dev | 64 chars hex, geralmente partilhada via vault (1Password/Bitwarden) ou em chamada |
| **Acesso internet** para `https://app.spharmmt.app` | `curl -I https://app.spharmmt.app` ou abrir no browser |

Se algum falha, **pára aqui** e resolve antes de continuar.

---

## 1. Instalar o agent no servidor

### 1.1 Copiar a pasta `agent/` para o servidor

Escolhe um dos métodos:

| Método | Como |
|---|---|
| **Git** (recomendado se servidor tem git + acesso ao repo) | `git clone <repo> spharmmt-mt` e depois `cd spharmmt-mt/agent` |
| **ZIP via USB / shared drive** | Copia a pasta `agent/` inteira do dev para `C:\spharm-agent\` (ou local equivalente) |
| **SCP / robocopy** | `scp -r dev@laptop:repo/agent server:C:\spharm-agent\` |

Caminho final tipico: **`C:\spharm-agent\`** com a estrutura:

```
C:\spharm-agent\
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── RUN_DISCOVERY.md     ← este ficheiro
├── SECURITY.md
└── src\
    ├── cli.ts
    ├── config.ts
    ├── http-client.ts
    ├── sql-client.ts
    └── commands\
        ├── test-connection.ts
        ├── discover.ts
        └── health.ts
```

### 1.2 Instalar dependências

Abre `cmd` ou PowerShell **como utilizador normal** (não Administrator — não é preciso):

```bash
cd C:\spharm-agent
npm install
```

Espera ~30s. Saída esperada termina com algo como `added 195 packages in 30s`.

---

## 2. Criar o login SQL Server read-only

> Esta secção é obrigatória. **Não usar `sa` nem o user da aplicação SPharm.** Ver [agent/SECURITY.md](SECURITY.md) para o porquê.

Abre **SQL Server Management Studio (SSMS)** conectado como `sa` ou admin equivalente. Cola num "New Query" (substitui `<PW>` por uma password forte aleatória):

```sql
-- 1. Criar login server-level
USE master;
CREATE LOGIN spharm_readonly WITH PASSWORD = '<PW>', CHECK_POLICY = OFF;

-- 2. Criar utilizador na BD SPharm (ajusta o nome da BD se necessário)
USE SPHARM;
CREATE USER spharm_readonly FOR LOGIN spharm_readonly;

-- 3. Atribuir permissão SELECT em todo o schema
EXEC sp_addrolemember 'db_datareader', 'spharm_readonly';

-- 4. (Recomendado) Garantir explicitamente que NÃO tem permissão de escrita
EXEC sp_addrolemember 'db_denydatawriter', 'spharm_readonly';
```

Verificação rápida:

```sql
-- Deve devolver linhas (qualquer SELECT funciona)
EXECUTE AS USER = 'spharm_readonly';
SELECT TOP 1 name FROM sys.tables;
REVERT;
```

**Anota** o login + password — vão para o `.env` no passo seguinte.

---

## 3. Configurar `agent/.env`

```bash
cd C:\spharm-agent
copy .env.example .env
notepad .env
```

Preenche **7 campos obrigatórios**:

| Campo | Valor para o piloto demo-neon | Notas |
|---|---|---|
| `SPHARMMT_ENDPOINT` | `https://app.spharmmt.app` | Confirma com o dev se o domínio for diferente |
| `SPHARMMT_TENANT_SLUG` | `demo-neon` | Slug exacto do tenant |
| `SPHARMMT_INGEST_KEY` | (64 hex chars do dev) | Cola **directamente entre aspas** — não escapar `=` ou outros chars |
| `SPHARMMT_FARMACIA` | `Farmácia Central` | Nome **exacto** como aparece no painel (case-sensitive na resolução) |
| `ERP_SQLSERVER_HOST` | `localhost` ou IP | Conforme topologia da rede |
| `ERP_SQLSERVER_DATABASE` | `SPHARM` | Confirma o nome real da BD |
| `ERP_SQLSERVER_USER` | `spharm_readonly` | Do passo 2 |
| `ERP_SQLSERVER_PASSWORD` | (PW do passo 2) | |

Outros campos (porta, encrypt, trust cert) — deixa os defaults a não ser que sejas instruído ao contrário.

**Antes de salvar:** lê o ficheiro de cima a baixo e confirma que NENHUM placeholder `<COLAR_...>` ficou.

---

## 4. Validar com `test-connection`

```bash
npm run test-connection
```

Saída esperada (verde):

```
─────────────────────────────────────────────────────────────────────
SPharm.MT agent — test-connection
─────────────────────────────────────────────────────────────────────
  saasEndpoint         https://app.spharmmt.app
  tenantSlug           demo-neon
  ingestKey            a*****f
  farmacia             Farmácia Central
  sqlHost              localhost:1433
  sqlDatabase          SPHARM
  sqlUser              s*******y
  sqlPassword          ***
  sqlEncrypt           false
  sqlTrustCert         true
  outputDir            C:\spharm-agent\output
  agentVersion         0.1.0
─────────────────────────────────────────────────────────────────────

Resultados:
  ✓ SQL Server SELECT 1          (123ms)  OK
  ✓ SaaS heartbeat               (245ms)  tenant=demo-neon serverTime=2026-05-12T16:30:42Z
  ✓ SaaS list farmácias          (180ms)  farmácia Farmácia Central resolvida → cm... (estado=ATIVO)

✓ Tudo OK — pronto para `discover`.
```

### Se algo falhar:

| Sintoma | Provável causa | Acção |
|---|---|---|
| `Config inválida` lista N envs em falta | Esqueceste valores no `.env` | Re-edita `.env`, confere as 7 obrigatórias |
| `SQL Server SELECT 1 ✗ login failed` | Password errada ou login não criado | Re-valida no SSMS o passo 2 |
| `SQL Server SELECT 1 ✗ ECONNREFUSED / ETIMEDOUT` | SQL Server não acessível ou porta errada | Confirma serviço SQL Server a correr + porta TCP/IP habilitada + firewall |
| `SaaS heartbeat ✗ HTTP 401` | Ingest key inválida | Pede ao dev para rodar com `--rotate` e nova key |
| `SaaS heartbeat ✗ HTTP 404` | tenantSlug errado | Confirma o slug com o dev |
| `SaaS heartbeat ✗ falha de rede` | DNS / firewall do servidor | `ping app.spharmmt.app` + `curl -I https://app.spharmmt.app` |
| `SaaS list farmácias ✗ "Farmácia Central" não encontrada` | Nome diferente no painel | Lista exibida no erro mostra os nomes reais — copia exactamente |

**Não avances para o passo 5** até `test-connection` ficar todo verde.

---

## 5. Correr o `discover`

```bash
npm run discover
```

Saída esperada (~30s-2min dependendo do tamanho do schema):

```
─────────────────────────────────────────────────────────────────────
SPharm.MT agent — discover (SQL Server)
─────────────────────────────────────────────────────────────────────
Host         : localhost:1433
Database     : SPHARM
User         : s*******y
...
─────────────────────────────────────────────────────────────────────
▶ A ligar ao SQL Server…
  ✓ ligação OK
▶ A ler db info…
  edition       : Standard Edition (64-bit)
  version       : 14.0.3...
  collation     : Latin1_General_CI_AS
  ...
▶ A enumerar schemas…
  3 schema(s)
▶ A enumerar tabelas + row counts…
  142 tabela(s)
▶ A enumerar colunas…
  1834 coluna(s)
▶ A enumerar primary keys / índices / FKs / triggers…
▶ A amostrar min/max de datas em candidatos…
  16 probes (0 falhas)
─────────────────────────────────────────────────────────────────────
✓ Discovery concluído em 47.3s
  JSON     : C:\spharm-agent\output\spharm-sqlserver-discovery.json
  Markdown : C:\spharm-agent\output\spharm-sqlserver-discovery.md
```

> O comando **lê apenas metadata** (`sys.tables`, `sys.columns`, etc.) e MIN/MAX de colunas-data em tabelas candidatas. **Não envia nada para a SaaS.** Não lê qualquer linha de dados clínicos ou comerciais.

---

## 6. Devolver os outputs ao dev

Tens 2 ficheiros em `C:\spharm-agent\output\`:

| Ficheiro | Para que serve |
|---|---|
| `spharm-sqlserver-discovery.md` | **Humano-legível** — abre num editor markdown ou GitHub para confirmar visualmente. Resumo das categorias detectadas, top 20 tabelas, candidatas com PKs e date ranges. |
| `spharm-sqlserver-discovery.json` | **Máquina-legível** — completo, com TODAS as tabelas/colunas. O dev usa para o mapping automático. |

**Como enviar:**

| Método | Quando |
|---|---|
| Anexar **ambos** num email ao dev | Mais simples |
| ZIP da pasta `output/` e enviar via shared drive | Para outputs grandes (>5 MB JSON) |
| Cola apenas o conteúdo do `.md` em chat (se for curto) + envia o `.json` separadamente | Diagnose rápido |

**Importante:** os outputs **não contêm passwords, dados de pacientes nem dados comerciais** — apenas nomes de tabelas/colunas, tipos, índices, FKs, e min/max de datas em colunas-data. Podes envia-los por canais normais.

---

## 7. (Opcional) `health` para diagnose verboso

Se quiseres um screenshot completo para enviar ao dev em caso de dúvida:

```bash
npm run agent:health
```

Mostra hostname, versão Node, versão SQL Server, edition, collation, contagem de farmácias do tenant — útil em troubleshooting remoto.

---

## Próximos passos (do lado do dev)

1. Dev analisa o `.json` + `.md` enviados.
2. Dev escreve `notes/erp-direct-sync-mapping.md` (mapeamento entidade-a-entidade ERP→SPharm.MT).
3. Dev implementa comandos `bootstrap` e `daily-sync` no agent.
4. Volta-se a contactar o operador para correr `npm run bootstrap` (importação histórica).

**Nada do passo 1-4 acima depende de mais acção do operador agora.** Após enviar os outputs do passo 6, podes encerrar a sessão SSMS e o terminal — o agent só vai voltar a correr quando o dev preparar o passo 4.
