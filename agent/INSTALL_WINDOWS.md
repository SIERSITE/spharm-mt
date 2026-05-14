# SPharm.MT Agent — Instalação Windows

Guia para instalar e correr o agent num servidor Windows da farmácia. **Não requer Node.js, npm, nem código fonte.** Só copiar a pasta + editar 1 ficheiro de configuração + correr 2 ficheiros `.bat`.

**Tempo estimado:** 15 minutos (sem contar criação do login SQL no SQL Server, que é mais 5 min).

---

## 0. O que recebeste

Um ZIP `SPharmMT-Agent.zip` (~35 MB). Quando extrair, fica uma pasta `SPharmMT-Agent\` com:

```
SPharmMT-Agent\
├── node.exe                        ← runtime Node portable, 30 MB
├── agent.cjs                       ← código do agent
├── agent.config.example.json       ← template — copia para agent.config.json
├── run-test-connection.bat         ← duplo-clique para validar
├── run-discover.bat                ← duplo-clique para inspeccionar schema
├── run-health.bat                  ← duplo-clique para diagnose
├── INSTALL_WINDOWS.md              ← este ficheiro
├── SECURITY.md                     ← checklist de segurança
├── README.txt                      ← resumo 1-página
├── output\                         ← onde o discover deposita ficheiros
└── logs\                           ← reservado (sync futuro)
```

---

## 1. Instalar (copiar pasta)

Extrai o ZIP para um caminho **sem espaços** preferencialmente:

```
✓ C:\SPharmMT-Agent\
✓ D:\Apps\SPharmMT-Agent\
✗ C:\Program Files\SPharmMT-Agent\        (espaço — pode causar problemas em alguns .bat)
✗ C:\Users\<Nome>\Desktop\SPharmMT-Agent\  (estado do Desktop muda, perde-se)
```

Confirma que dentro dessa pasta consegues ver `node.exe`, `agent.cjs`, e os 3 `.bat`. Se sim, está extraído ok.

---

## 2. Criar login SQL Server read-only

> **OBRIGATÓRIO.** Não usar `sa` nem o utilizador da aplicação SPharm. Razões em [SECURITY.md §1](SECURITY.md).

Abre **SQL Server Management Studio (SSMS)** conectado como `sa` ou admin equivalente. Cola e executa (substitui `<PW>` por uma password forte aleatória — anota-a):

```sql
USE master;
CREATE LOGIN spharm_readonly WITH PASSWORD = '<PW>', CHECK_POLICY = OFF;

-- Substitui SPHARM pelo nome real da BD do ERP se for diferente
USE SPHARM;
CREATE USER spharm_readonly FOR LOGIN spharm_readonly;
EXEC sp_addrolemember 'db_datareader', 'spharm_readonly';
EXEC sp_addrolemember 'db_denydatawriter', 'spharm_readonly';
```

Verificação rápida — deve devolver linhas sem erro:

```sql
EXECUTE AS USER = 'spharm_readonly';
SELECT TOP 1 name FROM sys.tables;
REVERT;
```

---

## 3. Configurar `agent.config.json`

Na pasta extraída:

1. **Renomeia** (não copies) `agent.config.example.json` para `agent.config.json`
   - Ou: copia, dá-lhe novo nome, e mantém o `.example` por referência.
2. Abre `agent.config.json` num editor de texto (Notepad serve, mas **Notepad++** ou **VSCode** mostram cores e detectam erros JSON).
3. Preenche os campos. Aqui está um exemplo realista para o piloto:

```json
{
  "saas": {
    "endpoint": "https://app.spharmmt.app",
    "tenantSlug": "demo-neon",
    "ingestKey": "abc123...64hex...def789",
    "farmacia": "Farmácia Central"
  },
  "sqlServer": {
    "host": "localhost",
    "port": 1433,
    "database": "SPHARM",
    "user": "spharm_readonly",
    "password": "a-password-segura-do-passo-2",
    "encrypt": false,
    "trustServerCertificate": true
  },
  "options": {
    "outputDir": "output",
    "agentVersion": "0.1.0"
  }
}
```

**Notas por campo:**

| Campo | Notas |
|---|---|
| `saas.endpoint` | URL pública do SPharm.MT, com `https://`, sem `/` no fim. Pede ao dev se não souberes. |
| `saas.tenantSlug` | Slug do tenant (grupo de farmácias). Para o piloto: `demo-neon`. |
| `saas.ingestKey` | 64 caracteres hex que o dev te entregou. Cola directamente entre aspas. |
| `saas.farmacia` | Nome **exacto** da farmácia como criada no painel admin, ou o CUID directo (ex: `ckxg...`). |
| `sqlServer.host` | `localhost` se o agent corre no mesmo PC do SQL Server; IP/hostname caso contrário. Para instâncias nomeadas (ex: `SERVER\\SQLEXPRESS`), expor TCP/IP no SQL Server Configuration Manager e usar só `SERVER` aqui + a porta TCP fixa. |
| `sqlServer.port` | `1433` por defeito. |
| `sqlServer.database` | Nome real da BD SPharm — confirma se for diferente de `SPHARM`. |
| `sqlServer.user` | `spharm_readonly` do passo 2. |
| `sqlServer.password` | A password do passo 2. **Cuidado com aspas dentro da string** — JSON exige escapar `"` como `\"` se houver. |
| `sqlServer.encrypt` | `false` em LAN local (default). `true` se o SQL Server tiver certificado configurado. |
| `sqlServer.trustServerCertificate` | `true` se `encrypt=true` mas o certificado for self-signed (default LAN). |

> **JSON é estrito:** vírgula a faltar entre campos = ficheiro inválido = agent recusa arrancar. Se o `run-test-connection.bat` se queixa de JSON malformado, verifica:
> - Aspas duplas em toda a parte (não `'simples'`)
> - Vírgulas entre campos do mesmo objecto, **não** após o último
> - Sem comentários `//` (não suportados em JSON)

Quando guardas o ficheiro, NÃO o partilhes — contém a ingest key e a password do SQL Server.

---

## 4. Validar com `run-test-connection.bat`

Duplo-clique em `run-test-connection.bat`. Abre uma janela preta (cmd) com algo assim:

```
─────────────────────────────────────────────────────────────────────
SPharm.MT agent — test-connection
─────────────────────────────────────────────────────────────────────
  saasEndpoint         https://app.spharmmt.app
  tenantSlug           demo-neon
  ingestKey            a*****9
  farmacia             Farmácia Central
  sqlHost              localhost:1433
  ...
─────────────────────────────────────────────────────────────────────

Resultados:
  ✓ SQL Server SELECT 1          (123ms)  OK
  ✓ SaaS heartbeat               (245ms)  tenant=demo-neon serverTime=2026-05-12T...
  ✓ SaaS list farmácias          (180ms)  farmácia Farmácia Central resolvida → ck... (estado=ATIVO)

✓ Tudo OK — pronto para `discover`.

Press any key to continue . . .
```

Pressiona uma tecla para fechar a janela.

### Se algo falha (✗):

A janela mantém-se aberta com `pause` — lê o erro e a dica accionável que aparece logo a seguir.

Casos comuns:

| Sintoma | O que fazer |
|---|---|
| `Config inválida — N envs em falta` | Re-abrir `agent.config.json` e preencher os campos listados |
| `agent.config.json inválido (JSON malformado)` | Validar JSON em [jsonlint.com](https://jsonlint.com/) (cuidado a não colar secrets — testa local com Notepad++) |
| `SQL Server SELECT 1 ✗ login failed` | Password errada no `.json` ou SQL Authentication desligado no SQL Server (Configuration Manager → "Server Authentication" deve estar em "SQL Server and Windows") |
| `SQL Server SELECT 1 ✗ ECONNREFUSED / ETIMEDOUT` | Verifica `host`/`port`, firewall do Windows, e se o serviço "SQL Server (MSSQLSERVER)" está a correr (`services.msc`) |
| `SaaS heartbeat ✗ HTTP 401` | Ingest key errada ou foi rotacionada. Pede ao dev nova key. |
| `SaaS heartbeat ✗ HTTP 404` | `tenantSlug` errado no JSON. |
| `SaaS heartbeat ✗ falha de rede` | Servidor sem acesso à internet ou DNS bloqueado. Testa no browser: `https://app.spharmmt.app` |
| `Farmácia "X" não encontrada no tenant` | O erro mostra a lista de farmácias disponíveis — copia exactamente o nome |

**Não avances** para o passo 5 até este passar todo verde. Liga ao dev se ficares preso > 10 min.

---

## 5. Correr o `discover`

Duplo-clique em `run-discover.bat`. Ficheiro corre por ~30s a 2 min consoante o tamanho do schema. Output:

```
─────────────────────────────────────────────────────────────────────
SPharm.MT agent — discover (SQL Server)
─────────────────────────────────────────────────────────────────────
...
▶ A ligar ao SQL Server…
  ✓ ligação OK
▶ A ler db info…
▶ A enumerar schemas…
▶ A enumerar tabelas + row counts…
  142 tabela(s)
▶ A enumerar colunas…
  1834 coluna(s)
...
─────────────────────────────────────────────────────────────────────
✓ Discovery concluído em 47.3s
  JSON     : C:\SPharmMT-Agent\output\spharm-sqlserver-discovery.json
  Markdown : C:\SPharmMT-Agent\output\spharm-sqlserver-discovery.md
```

**Esta operação é segura:**
- Lê apenas **metadata** (estrutura) do SQL Server.
- **Não envia nada para a SaaS.**
- Não lê dados de pacientes nem vendas individuais.

Mais detalhe em [SECURITY.md §5](SECURITY.md).

---

## 6. Enviar outputs ao dev

A pasta `output\` agora tem 2 ficheiros:

- `spharm-sqlserver-discovery.md` — humano-legível, podes abrir em qualquer editor de Markdown
- `spharm-sqlserver-discovery.json` — formato para o dev consumir

Envia **ambos**:
- Por email (anexa os 2 ficheiros)
- Ou por drive partilhado (OneDrive / Google Drive)
- Ou ZIP a pasta `output\` toda

> **Não contêm dados sensíveis** — apenas nomes de tabelas, colunas, tipos, e algumas datas mínima/máxima. Mais detalhe em [SECURITY.md §5](SECURITY.md).

---

## 7. (Opcional) `run-health.bat` para diagnose

Se o dev pedir diagnose remoto, duplo-clique em `run-health.bat` e tira screenshot da janela ou envia o texto.

Mostra:
- Nome do PC + sistema operativo + versão Node embebida
- Configuração actual (secrets mascarados)
- Status de cada serviço (SQL local + SaaS)

Útil quando algo não corre como esperado mas não conseguimos perceber só pelo erro do `test-connection`.

---

## 8. Manter o agent (agora e a longo prazo)

### 8.1 Agora (apenas discovery)

Não precisas mais nada. O agent corre uma vez (`discover`), produz os ficheiros, e o dev faz o resto. Podes fechar a sessão do servidor — o agent não fica "instalado" como serviço.

### 8.2 Daqui a algumas semanas (após mapping + bootstrap/daily-sync)

O dev vai entregar uma nova versão do agent com mais 2 ficheiros:

- `run-bootstrap.bat` — corre **uma vez** para importar histórico (24 meses por defeito). Demora 5-30 min consoante volume.
- `run-daily-sync.bat` — corre todos os dias automaticamente.

Para o `daily-sync` ficar automático, na altura criamos uma **Task Scheduler** que dispara o `.bat` todos os dias às 3:00 AM. Documentação completa virá com essa entrega.

### 8.4 Encomendas SaaS → SPharm local (rev16+)

Quando o SaaS finalizar uma encomenda, fica em fila no outbox SaaS. O agent puxa periodicamente e escreve no SPharm local. **Não há comunicação directa SaaS → SQL Server.**

Dois BATs para este fluxo:

- **`run-export-orders-auto.bat`** — para Task Scheduler. Sem prompts, sem janela visível.
  - Cada execução: GET pending → write SPharm (ou JSON em modo stub) → ack/nack SaaS.
  - Log em `logs\export-orders-<YYYY-MM-DD>.log` (append, um ficheiro por dia).
  - Exit code 0 = OK, ≠0 = falha (Task Scheduler regista no histórico).
  - Resumo final no log: `pulled / inserted / idempotent / acked / failed`.
  - Configurar no Task Scheduler para correr a cada 5-10 minutos.

- **`run-export-orders-once.bat`** — execução manual interactiva. Pede `pause` antes de correr e no fim. Output visível em tempo real na janela. Útil para debug manual ou primeira validação.

Modos (controlado por `options.ordersWriteMode` em `agent.config.json`):

- `"stub"` (default): exporta JSON em `output\orders-export\<data>\<outboxId>.json` e ack a SaaS com docId STUB-*. **NÃO escreve no SPharm.** O log mostra aviso explícito.
- `"insert"`: INSERT transaccional em `dbo.Encomendas` + `dbo.[Encomendas Detalhe]`. Requer secção `ordersInsert` preenchida e SQL login com `db_datawriter` (ou INSERT grant nas tabelas-alvo). Idempotente via `outboxId` em `[VVM_ID]`.

**Antes de activar `ordersWriteMode=insert` em produção:**
1. Validar schema com `run-inspect-orders-schema.bat`
2. Smoke test com `run-test-order-write.bat` (modo 1 = DRY-RUN; modo 2 = COMMIT)
3. Só depois agendar `run-export-orders-auto.bat` no Task Scheduler

Detalhes completos em [pilot-operator-guide.md](pilot-operator-guide.md#rev15).

### 8.3 Como parar / desinstalar

Como o agent não é um serviço Windows na v0.1:
- **Parar (manualmente):** fechar a janela cmd onde está a correr. Se nenhuma janela está aberta, não está a correr.
- **Desinstalar:** apaga a pasta `C:\SPharmMT-Agent\`. É só.

Nenhuma chave de Registry escrita. Nenhum serviço Windows. Nenhum certificado instalado. Limpeza limpa.

---

## 9. Logs e troubleshooting avançado

A pasta `logs\` está reservada para a próxima versão (`daily-sync`). Hoje os comandos imprimem logs no terminal directamente.

Se precisares de guardar o output do `discover` para o dev analisar:

```cmd
cd C:\SPharmMT-Agent
node.exe agent.cjs discover > logs\discover-2026-05-12.log 2>&1
```

(Cmd directo sem `.bat`. Redirecciona stdout+stderr para um ficheiro.)

---

## Resumo — 1 página

| Passo | Comando | Tempo |
|---|---|---|
| 1. Extrair ZIP para `C:\SPharmMT-Agent\` | Explorer / 7-Zip | 1 min |
| 2. Criar login SQL `spharm_readonly` em SSMS | SQL script no SSMS | 5 min |
| 3. Renomear `agent.config.example.json` → `agent.config.json` + preencher | Editor texto | 5 min |
| 4. Validar | `run-test-connection.bat` | 1 min |
| 5. Inspeccionar | `run-discover.bat` | 1-2 min |
| 6. Enviar outputs ao dev | Email / drive | 1 min |

**Total:** ~15 min do ZIP ao output enviado.
