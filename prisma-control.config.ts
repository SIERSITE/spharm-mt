import "dotenv/config";
import { defineConfig } from "prisma/config";

// Config dedicada ao CONTROL PLANE. Existe em paralelo com
// `prisma.config.ts` (que cobre o schema da app/tenant).
//
// Razão de ser: em Prisma 7, `migrations.path` na config tem precedência
// sobre o flag `--schema`. Antes desta separação, correr
// `prisma migrate deploy --schema prisma-control/schema.prisma` com
// DATABASE_URL=CONTROL_DATABASE_URL aplicava migrations de
// `prisma/migrations` (app) contra a BD de control — corrompia o
// control plane. Ver `scripts/control/_common.ts` para o consumo.
export default defineConfig({
  schema: "prisma-control/schema.prisma",
  migrations: {
    path: "prisma-control/migrations",
  },
  datasource: {
    url: process.env.CONTROL_DATABASE_URL!,
  },
});
