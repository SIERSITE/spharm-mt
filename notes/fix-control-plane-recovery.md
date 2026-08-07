# Recovery: control:migrate:deploy aplicou schema errado

## Causa raiz

`prisma.config.ts` (raiz do projecto) define `migrations.path: "prisma/migrations"`.
Em Prisma 7, esta opção tem precedência sobre o flag CLI `--schema`. Resultado:
o `scripts/control/_common.ts` antigo passava `--schema prisma-control/schema.prisma`
mas o Prisma continuava a aplicar as migrations de `prisma/migrations` (app) contra
`CONTROL_DATABASE_URL`.

## Fix aplicado no repo

1. Criada `prisma-control.config.ts` separada (schema + migrations path do control + lê `CONTROL_DATABASE_URL`).
2. `scripts/control/_common.ts` passa `--config prisma-control.config.ts` (em vez de `--schema`).

## Passos para limpar e reaplicar (execução do operador)

A BD `spharmmt_control` tem agora:
- Tabelas da app: `Produto`, `InfarmedSnapshot`, `RegulatoryRecord`, etc. (lixo)
- `_prisma_migrations` com rows das migrations da app aplicadas indevidamente

Como **ainda não há tenants nem dados reais no control plane**, o caminho mais limpo
é dropar e recriar o schema `public`. Conectar à BD `spharmmt_control` como
super-user (a mesma role usada para criar a BD) e correr:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
```

Em Neon SQL editor (apontado ao DB `spharmmt_control`):
- Cola o bloco acima
- Executa

Depois, reaplica as migrations correctas do control plane:

```bash
npm run control:migrate:deploy
```

Esperado no stdout:
```
Loaded Prisma config from prisma-control.config.ts.
Prisma schema loaded from prisma-control/schema.prisma.
...
The following migrations have been applied:
  20260414130000_init_control_plane
  20260414141000_add_ingest_key_heartbeat
  20260511131622_add_sync_run
```

## Validação

```bash
npm run tenancy:list
```

Esperado: lista vazia (não erro). Output similar a:
```
Tenants registados: 0
```

(ou o equivalente — qualquer output sem `P2021 The table public.Tenant does not exist` indica fix bem sucedido.)

## Regressão app

A config da app (`prisma.config.ts`) **não foi alterada**.
`prisma migrate deploy` continua a usar `prisma/schema.prisma` + `prisma/migrations`
+ `DATABASE_URL` como antes. Não há regressão no fluxo de tenant DBs nem no `build`.
