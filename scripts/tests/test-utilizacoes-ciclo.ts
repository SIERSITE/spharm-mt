/**
 * scripts/tests/test-utilizacoes-ciclo.ts
 *
 * Fixa a decisão que substitui a fila de pedidos.
 *
 * Não há tabela de trabalho pendente: o job compara o instante do último
 * `products-upload` fechado com o do último backfill. Esta comparação é
 * o coração do automatismo — se estiver errada, ou a faceta nunca se
 * actualiza (farmácia nova fica sem pesquisa por necessidade), ou o
 * catálogo inteiro é reprocessado a cada 10 minutos sem razão.
 *
 * Uso: npx tsx scripts/tests/test-utilizacoes-ciclo.ts
 */
import { precisaBackfill } from "../../lib/catalog/utilizacoes-ciclo";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}`); }
};

const T = (iso: string) => new Date(iso);

console.log("=== farmácia nova ===");
check(
  precisaBackfill({ ultimoUploadFinalizadoEm: T("2026-08-12T10:00:00Z"), ultimoBackfillEm: null }),
  "primeiro upload sem backfill nenhum → há trabalho",
);
// Sem upload não há produtos vindos do ERP. Correr o backfill aqui seria
// varrer um catálogo vazio a cada 10 minutos.
check(
  !precisaBackfill({ ultimoUploadFinalizadoEm: null, ultimoBackfillEm: null }),
  "tenant sem uploads → não há nada a fazer",
);
check(
  !precisaBackfill({ ultimoUploadFinalizadoEm: null, ultimoBackfillEm: T("2026-08-01T00:00:00Z") }),
  "backfill antigo mas nenhum upload → continua sem trabalho",
);

console.log("\n=== regime normal ===");
check(
  precisaBackfill({
    ultimoUploadFinalizadoEm: T("2026-08-12T10:00:00Z"),
    ultimoBackfillEm: T("2026-08-12T09:00:00Z"),
  }),
  "upload posterior ao backfill → há produtos novos por classificar",
);
// É esta asserção que impede o catálogo inteiro de ser reprocessado a
// cada passagem do scheduler.
check(
  !precisaBackfill({
    ultimoUploadFinalizadoEm: T("2026-08-12T09:00:00Z"),
    ultimoBackfillEm: T("2026-08-12T10:00:00Z"),
  }),
  "backfill posterior ao upload → nada a fazer",
);
check(
  !precisaBackfill({
    ultimoUploadFinalizadoEm: T("2026-08-12T10:00:00Z"),
    ultimoBackfillEm: T("2026-08-12T10:00:00Z"),
  }),
  "instantes iguais → nada a fazer (não repete)",
);

console.log("\n=== o job é barato quando não há trabalho ===");
// Um segundo de diferença chega para disparar: a comparação é estrita e
// não tem tolerância, porque um upload que fechou é um upload que fechou.
check(
  precisaBackfill({
    ultimoUploadFinalizadoEm: T("2026-08-12T10:00:01Z"),
    ultimoBackfillEm: T("2026-08-12T10:00:00Z"),
  }),
  "um segundo depois já conta",
);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
