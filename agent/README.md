# SPharm.MT — Local Agent (SQL Server)

Agent que corre **on-premise** no servidor da farmácia, lê o ERP
SPharm (Softreis) em SQL Server **read-only**, e envia dados para a
SaaS SPharm.MT via HTTPS autenticado.

> Não conhece Neon. Não conhece o control plane. Não tem acesso a
> outros tenants. Toda a saída passa pelos endpoints
> `/api/ingest/v1/*` e `/api/outbox/v1/*` autenticados com a
> `SPHARMMT_INGEST_KEY` bound ao tenant deste grupo.

**Para correr o discovery agora:** [`RUN_DISCOVERY.md`](RUN_DISCOVERY.md) (guia passo-a-passo).
**Antes de configurar:** [`SECURITY.md`](SECURITY.md) (checklist invariante).

Arquitectura completa: [`notes/local-agent-architecture.md`](../notes/local-agent-architecture.md) (no repo SaaS).
Plano de execução SQL Server específico: [`notes/local-agent-sqlserver-plan.md`](../notes/local-agent-sqlserver-plan.md).

---

## Quick start

```bash
cd agent
npm install                    # uma vez, na máquina da farmácia
cp .env.example .env           # editar com credenciais reais

npm run test-connection        # valida envs + SaaS + SQL Server
npm run discover               # introspecciona schema ERP (read-only, sem dados)
npm run health                 # status detalhado: config + connectivity + diagnostics
```

## Comandos disponíveis (v0.1)

| Comando | Função |
|---|---|
| `test-connection` | Ping ao endpoint SaaS + SELECT 1 no SQL Server + GET `/api/ingest/v1/farmacias`. Falha-rápido se algo não está pronto para sync. |
| `discover` | Lê metadata do schema ERP (sys.*, sem dados de negócio). Output: `output/spharm-sqlserver-discovery.{json,md}`. |
| `health` | Resumo de configuração + connectivity + identificadores. Útil para diagnose remoto via screenshot. |

Comandos planeados (próxima iteração, após mapping ERP→SPharm.MT):
- `bootstrap` — importa histórico completo (default 24 meses)
- `daily-sync` — incremental usando cursor server-side

## Segurança

- **Read-only:** o login SQL Server tem apenas `db_datareader`. O agent não invoca nenhuma função `INSERT`/`UPDATE`/`DELETE` no ERP.
- **Credenciais SQL ficam locais** — nunca enviadas para a SaaS.
- **Ingest key bound ao tenant** — não autoriza acesso a outros grupos. Rotável via Platform Admin Tool sem reinstalar o agent.
- **Logs mascarados** — password SQL e ingest key são parcialmente substituídas por `***` em todos os outputs e ficheiros JSONL.
- **TLS sempre na comunicação SaaS** — `SPHARMMT_ENDPOINT` validado para começar por `https://`.

## Standalone vs monorepo

Este pacote é deliberadamente isolado:
- Sem dependência do runtime Next.js
- Sem Prisma
- Sem importação de `lib/*` do repo SaaS
- Dependencies: `mssql`, `dotenv`, `tsx` (dev)
- Node ≥ 20 (usa `fetch` nativo + ES modules)

Pode ser empacotado como npm package separado (`@spharmmt/agent`) ou
binário standalone (`spharmmt-agent.exe`) em iterações futuras.
