# Ingestion Agent — Folder Mode

**Data:** 2026-05-12 · **Script:** `scripts/agent/ingest-folder.ts` · **npm:** `agent:ingest-folder`

## O que é

CLI leve que vê uma pasta no PC da farmácia, detecta ficheiros ERP
(stock + vendas mensais), faz upload para a API SPharm.MT e move os
ficheiros consoante a resposta. Sem daemon, sem serviço Windows, sem
UI.

Operacionalização típica:
- **Piloto manual:** `--once` invocado pelo operador 1×/dia
- **Semi-automático:** Windows Task Scheduler chamando `--once` num cron
- **Watch:** processo a correr indefinido (`--watch`) — só recomendado em PC sempre ligado

## Convenção de pastas

```
<input>/                              ← novos ficheiros aparecem aqui
   ├── processed/                     ← upload OK (status=processed)
   │   └── duplicates/                ← skipped_duplicate (mesmo hash já PROCESSADO)
   ├── failed/                        ← upload falhou (HTTP 4xx/5xx ou network)
   ├── quarantine/                    ← tipo desconhecido ou extensão inválida
   └── ingest-agent.log               ← JSONL append-only (1 linha por evento)
```

Subpastas criadas automaticamente se não existirem. Cada move usa
prefixo `<epoch_ms>_<filename>` para evitar colisão se o mesmo
ficheiro reaparecer na origem.

## Comando

```bash
npm run agent:ingest-folder -- \
  --tenant=<slug> \
  --farmacia=<cuid> \
  --input=<folder> \
  --endpoint=<baseUrl> \
  --key=<ingest-key> \
  (--once | --watch) \
  [--dry-run] \
  [--watch-interval=<ms>]
```

| Flag | Obrigatório | Default | Descrição |
|---|---|---|---|
| `--tenant` | sim | — | Slug do tenant (header `X-Tenant-Slug`) |
| `--farmacia` | sim | — | cuid da farmácia dentro do tenant (form field `farmaciaId`) |
| `--input` | sim | — | Caminho absoluto da pasta de input |
| `--endpoint` | sim | — | Base URL da SPharm.MT (sem trailing slash) |
| `--key` | sim | — | Ingest API key emitida por `tenancy:issue-ingest-key` |
| `--once` | xor | — | Processa pasta uma vez e sai |
| `--watch` | xor | — | Loop indefinido com polling (Ctrl+C para parar) |
| `--dry-run` | opcional | false | Detecta + classifica sem fazer upload nem mover ficheiros |
| `--watch-interval` | opcional | 5000 (ms) | Intervalo entre polls em watch mode |

> **Nota sobre `--farmacia`:** hoje exige o **cuid** da farmácia
> dentro do tenant (ex: `ckhxgzps700001abcde123456`). Para o
> descobrir: `npm run tenancy:health -- --slug=<tenant>` lista as
> farmácias e os cuids. Quando existir um endpoint `/api/ingest/v1/farmacias`,
> o agent passará a aceitar nome.

## Detecção de tipo

| Estratégia | Resultado |
|---|---|
| **1. Extensão** | Se não for `.xlsx` → `quarantine` |
| **2. Filename match** | `stock` (substring case-insensitive) → `STOCK` |
| | `mapaevolucao` / `vendas` / `sales` → `VENDAS_MENSAIS` |
| **3. Header check** (fallback) | Colunas `jan 2025`/`fev 2025`/... → `VENDAS_MENSAIS` |
| | Colunas `Stock Atual` / `stock` / `quantidade` / `puc` → `STOCK` |
| **4. Não decidido** | `quarantine` |

Fixtures testados:
- `stock_Atual.xlsx` → STOCK ✓
- `stock_castelo.xlsx` → STOCK ✓
- `MapaEvolucaoVendas.xlsx` → VENDAS_MENSAIS ✓
- `MapaEvolucaoVendas_c.xlsx` → VENDAS_MENSAIS ✓
- `novo_fabricante.xlsx` → quarantine ✓ (xlsx mas conteúdo não bate)
- `fabricante.csv` → quarantine ✓ (extensão errada)

## Safety: ficheiros mid-write

Antes de processar, o agent verifica:
- `size > 0`
- `mtime ≥ 2s atrás`

Ficheiros que falham este check são `skipped_unstable` (não movidos,
ficam no input para o próximo tick). Resolve o caso comum do operador
a copiar o ficheiro do ERP enquanto o agent corre.

## Decisão por resposta da API

| Resposta servidor | Acção do agent |
|---|---|
| HTTP 200 `{ status: "processed" }` | Move → `processed/` |
| HTTP 200 `{ status: "skipped_duplicate" }` | Move → `processed/duplicates/` |
| HTTP 4xx / 5xx (qualquer outro) | Move → `failed/` |
| Network error / timeout | Move → `failed/` |
| Non-JSON response (ex: HTML 500) | Move → `failed/`, errorMessage tem snippet do body |

Hash idempotente é calculado **antes** do upload — quando o agent
reenvia um ficheiro já processado, o servidor devolve
`skipped_duplicate` sem tocar nos dados (verificado em
`notes/ingestion-api-completion.md`).

## JSONL — formato de cada linha

```json
{
  "ts": "2026-05-12T08:01:15.781Z",
  "file": "C:\\spharm-inbox\\MapaEvolucaoVendas.xlsx",
  "hash": "0a1c80d0a42fd5e9b64f497da78cea05c0a70e492304f33ad7e6db7e8e2d9e7f",
  "type": "VENDAS_MENSAIS",
  "status": "processed" | "duplicate" | "failed" | "quarantined" | "skipped_unstable" | "dry-run",
  "recordsRead": 12345,
  "recordsInserted": 12300,
  "recordsFailed": 45,
  "durationMs": 4123,
  "httpStatus": 200,
  "errorCode": null,
  "errorMessage": null
}
```

Para debugging operacional: `grep '"status":"failed"' ingest-agent.log` mostra falhas.

## Smoke local validado

Testado em `/tmp/agent-smoke/` com 4 fixtures (`example_files/*`):

| Caso | Esperado | Observado |
|---|---|---|
| `stock_Atual.xlsx` | STOCK detected | ✓ STOCK |
| `MapaEvolucaoVendas.xlsx` | VENDAS_MENSAIS detected | ✓ VENDAS_MENSAIS |
| `fabricante.csv` | quarantine (extensão) | ✓ quarantined |
| `novo_fabricante.xlsx` | quarantine (conteúdo) | ✓ quarantined |
| File mtime < 2s | `skipped_unstable` | ✓ skipped, próximo tick processa |
| Upload contra dev sem control plane | `failed` com HTTP 500 + snippet | ✓ failed, body snippet no log |
| File moves | timestamp prefix em destino | ✓ `1778572762604_<nome>` |
| JSONL append | linhas por cada evento | ✓ 12 linhas em smoke |

Happy-path (upload com 200 processed) e duplicate skip (segundo
upload do mesmo ficheiro) **só podem ser validados quando o
control plane estiver provisionado** (CONTROL_DATABASE_URL).
Inspecção de código confirma: paths corretos para mover para
`processed/` e `processed/duplicates/` respectivamente.

## Operacionalização Windows (sem serviço)

### Opção A — operador manual (piloto)
```
1. Operador copia exports do ERP para C:\spharm-inbox\
2. Operador corre: npm run agent:ingest-folder -- --once ...
3. Confirma resumo no terminal
```

### Opção B — Windows Task Scheduler (semi-automático)
```cmd
schtasks /create /tn "SPharmIngest" /tr ^
  "cmd /c cd /d C:\spharm-mt && npm run agent:ingest-folder -- --once --tenant=... --farmacia=... --input=C:\spharm-inbox --endpoint=https://app.spharm.mt --key=<key>" ^
  /sc hourly /mo 1
```

### Opção C — watch mode (PC sempre ligado)
```
npm run agent:ingest-folder -- --watch ...
```
Recomendado fechar com `Ctrl+C` antes de reboot.

**Não há serviço Windows neste batch.** Quando o piloto provar valor,
empacotar com `node-windows` ou `nssm` é trivial (~1h).

## Limitações conhecidas

| Limitação | Mitigação | Crítica? |
|---|---|---|
| `--farmacia` exige cuid (não nome) | Comando `tenancy:health --slug=<tenant>` lista cuids | Baixa — 1× por setup |
| Sem suporte a `compras` | Endpoint `/api/ingest/v1/snapshot/compras` ainda não existe | Baixa — fora do scope piloto |
| Sem retry automático | Ficheiros em `failed/` precisam de mover manualmente de volta a input para retry | Baixa — falhas são raras com auth correcta |
| Polling 5s não em real-time | Aceitável para snapshots diários/horários | Não |
| Sem checksum cross-session (state file) | Hash de cada ficheiro é calculado a cada tick, mas a movimentação para `processed/` evita reprocess | Não — operacionalmente OK |
| `process.exit()` no Windows imprime assertion libuv | Cosmético, exit code está correcto | Não |

## Erros operacionais comuns

| Sintoma | Causa provável | Fix |
|---|---|---|
| `HTTP 401 · unauthorized` | Key errada ou slug errado | Reemitir key com `tenancy:issue-ingest-key`; verificar `--tenant=<slug>` |
| `HTTP 404 · farmacia_not_found` | cuid errado / farmácia não existe no tenant | Listar farmácias com `tenancy:health --slug=<tenant>` |
| `HTTP 500 · <!DOCTYPE html...` | Servidor mal-configurado (CONTROL_DATABASE_URL ausente) | Provisionar control plane — ver `notes/infra-strategy.md` |
| `network error` em todos os ficheiros | DNS / firewall do PC da farmácia | Validar `curl -I https://<endpoint>/api/outbox/v1/heartbeat` |
| Todos `quarantined` | Filenames não batem padrão | Renomear para conter `stock` ou `vendas`/`MapaEvolucao` |

## Próximos passos (não inicio sem aprovação)

1. **Endpoint `/api/ingest/v1/farmacias`** (~30 min) — destranca `--farmacia=<nome>`.
2. **Endpoint `/api/ingest/v1/snapshot/compras`** (~1h) — quando pipeline de Compras estiver definido.
3. **Retry manual via CLI** (~30 min) — `npm run agent:retry-failed -- --input=<folder>` que move tudo de `failed/` de volta a `input/` para nova tentativa.
4. **Empacotar como serviço Windows** (~1-2h) — `nssm` ou `node-windows` quando piloto provar valor.

---

_CLI leve · zero novo backend · 1 script + 1 npm alias · smoke local validado · pronto para piloto manual ou Windows Task Scheduler._
