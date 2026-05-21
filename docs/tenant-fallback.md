# Tenant resolution — fallback piloto (sem wildcard DNS)

## Contexto

O multi-tenant resolve o tenant pelo **subdomínio do Host** em TODOS os
requests (`middleware.ts` → header `x-tenant-slug` → `getPrisma()` /
`getSession()`). Isso exige wildcard DNS (`*.<dominio>`), que ainda não
existe — só há `https://spharm-mt.vercel.app`. `*.vercel.app` não aceita
subdomínios de utilizador, por isso o login de tenant não funciona em
produção sem um domínio próprio.

## Fallback (additive, flag-gated)

Quando `TENANT_FALLBACK_ENABLED=1`, o `middleware.ts` resolve o tenant por:

1. **Subdomínio** do Host — sempre prioritário e canónico.
2. **Cookie `__tenant`** — persistência do fallback (httpOnly, secure em prod).
3. **Query param `?__tenant=<slug>`** — bootstrap/switch; escreve o cookie.

Sem a flag, o comportamento é o oficial: subdomínio (+ `?__tenant` só em
dev). A flag é um kill switch reversível.

### Como activar (Vercel, piloto)

1. Vercel → projeto → Settings → Environment Variables:
   `TENANT_FALLBACK_ENABLED=1` (Production).
2. **Redeploy**.

### URL de login do grupo-silveira (com fallback activo)

```
https://spharm-mt.vercel.app/login?__tenant=grupo-silveira
```

- O middleware resolve `grupo-silveira` do query param, injecta
  `x-tenant-slug` e **grava o cookie `__tenant`**.
- O login valida as credenciais na BD do tenant e vincula a sessão ao
  slug. Os requests seguintes (já sem `?__tenant`) resolvem pelo cookie.
- Para **trocar de tenant** em fallback: abrir `/login?__tenant=<outro>`
  (query refresca o cookie só quando não há cookie; para forçar troca,
  limpar o cookie `__tenant` ou usar uma janela anónima).

## Segurança

O fallback muda apenas **como se escolhe** o tenant, não a autenticação:

- O login continua a validar credenciais na BD do tenant escolhido.
- A sessão fica vinculada ao slug; `getSession()` rejeita se o tenant
  resolvido do request não bater com o da sessão.
- Apontar `?__tenant` a outro tenant só mostra o login desse tenant —
  sem credenciais válidas não há acesso.
- A consola admin exige `LEGACY_TENANT` + `PLATFORM_ADMIN_EMAILS`, logo o
  fallback não dá escalonamento de privilégios.
- Endpoints `/api/ingest|outbox|jobs` estão fora do middleware (auth
  própria) — o fallback não os afecta.

## Migração futura → wildcard DNS (remover o fallback)

Quando o domínio próprio com wildcard estiver pronto:

1. DNS: registo wildcard `*.<dominio>` → `cname.vercel-dns.com` (conforme
   a Vercel indicar).
2. Vercel → Domains: adicionar `*.<dominio>` (+ apex/www). Vercel emite
   cert TLS wildcard.
3. Passar os tenants a `https://<slug>.<dominio>` (ex.:
   `https://grupo-silveira.<dominio>/login`).
4. **Desactivar o fallback**: remover/`0` em `TENANT_FALLBACK_ENABLED` +
   redeploy. A resolução volta a ser só por subdomínio (canónico).
5. (Opcional) os cookies `__tenant` existentes deixam de ser lidos
   quando a flag está off; expiram sozinhos (maxAge 30d).

Sem código a remover — o fallback fica dormente quando a flag está off.
