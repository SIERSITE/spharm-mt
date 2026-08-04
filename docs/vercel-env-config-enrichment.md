# Config em falta no Vercel — Pipeline de Enriquecimento

**Data:** 2026-08-04
**Causa raiz confirmada:** `CRON_SECRET` não configurado em Production → todos os 5 crons retornam 503 `server_misconfigured` desde 11-Maio-2026.

Evidência:
```
curl https://spharm-mt.vercel.app/api/jobs/enqueue-regulatory
{"ok":false,"error":"server_misconfigured","message":"CRON_SECRET not configured"}
HTTP 503
```

Todas as 5 rotas /api/jobs/* devolvem exactamente a mesma resposta.

## Passos no dashboard Vercel

1. Abrir: **Vercel → Project `spharm-mt` → Settings → Environment Variables**

2. Verificar/adicionar as seguintes vars **em ambos os ambientes** `Production` e `Preview`:

   | Nome | Origem | Notas |
   |---|---|---|
   | `CRON_SECRET` | Copiar de `.env` local (chave `CRON_SECRET`, 64 hex chars) | **CRÍTICO** — sem isto, os 5 crons /api/jobs/* devolvem 503 |
   | `TENANT_ENCRYPTION_SECRET` | Copiar de `.env` local | Decifra as connection strings dos tenants no control plane. Se em falta, `getTenantPrismaOrLegacy` cai silenciosamente na BD `neondb` legacy |
   | `CONTROL_DATABASE_URL` | Copiar de `.env.local` | Postgres control plane (`spharmmt_control`) |
   | `DATABASE_URL` | Já deve estar | BD legacy (`neondb`) — usada como fallback |

3. Depois de gravar, **redeploy do último commit** (Deployments → mais recente → Redeploy). Environment vars só entram no build seguinte.

4. **Confirmar** com curl (esperado: HTTP 200 com JSON `ok: true`):
   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET>" \
        "https://spharm-mt.vercel.app/api/jobs/enqueue-regulatory?onlySlugs=grupo-silveira&maxNewJobs=1"
   ```
   Se responder 401 → o secret enviado não bate com o de env.
   Se responder 503 → env var ainda não entrou no build (falta redeploy).
   Se responder 200 → OK.

5. **Confirmar cron ligado** em: **Vercel → Project → Cron Jobs**. Devem aparecer 5 entradas com next-run agendado.

6. **Primeira execução manual** (para não esperar 24h):
   ```bash
   # (a) enfileirar até 200 candidatos no grupo-silveira
   curl -H "Authorization: Bearer <SECRET>" \
        "https://spharm-mt.vercel.app/api/jobs/enqueue-regulatory?onlySlugs=grupo-silveira&maxNewJobs=200"
   # (b) processar até 50 jobs (1.5s rate limit; ~2min)
   curl -H "Authorization: Bearer <SECRET>" \
        "https://spharm-mt.vercel.app/api/jobs/acquire-regulatory?onlySlugs=grupo-silveira&maxJobsPerTenant=50"
   # (c) sincronizar campos dos RegulatoryRecord para Produto
   curl -H "Authorization: Bearer <SECRET>" \
        "https://spharm-mt.vercel.app/api/jobs/enrich-catalog?onlySlugs=grupo-silveira"
   ```
