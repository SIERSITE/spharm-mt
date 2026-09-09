/**
 * scripts/tests/test-utilizacoes-ciclo.ts
 *
 * Fixa a decisão que substitui a fila de pedidos.
 *
 * Não há tabela de trabalho pendente: o job compara o instante da última
 * alteração do catálogo com o do último backfill. Esta comparação é o
 * coração do automatismo — se estiver errada, ou a faceta nunca se
 * actualiza (farmácia nova fica sem pesquisa por necessidade), ou o
 * catálogo inteiro é reprocessado a cada 10 minutos sem razão.
 *
 * ── O QUE MUDOU EM SETEMBRO DE 2026 ──────────────────────────────────
 *
 * O sinal era `IngestProdutoRun.finalizadaEm` — "houve um upload de
 * produtos que fechou". Estava errado, e a produção mostrou-o: em
 * garantia havia 31 corridas ABANDONADA, 5 ABERTA e zero FINALIZADA, e o
 * backfill nunca tinha corrido em nenhum dos três tenants.
 *
 * A causa não era uma avaria. Só o comando `products-upload` chama
 * `/bootstrap/products/finalize`; a sincronização diária faz um upload
 * DELTA e não o chama — nem deve, porque o `/finalize` dispara o sweep de
 * `flagRetirado` e varrer a partir de um delta marcaria como retirado o
 * catálogo todo. "Corrida finalizada" responde a "o catálogo foi
 * observado por inteiro", que é a pergunta do sweep, não desta.
 *
 * O sinal certo é `max(Produto.dataAtualizacao)`, que sobe com o delta
 * diário, com o upload completo, com os campos do ERP e com a projecção
 * do catálogo global. Como em produção isso muda quase de contínuo,
 * entrou também um piso de tempo entre varreduras.
 *
 * As asserções deste ficheiro estão reescritas para o contrato novo. As
 * do bloco final são a regressão de produção, escrita como teste.
 *
 * Uso: npx tsx scripts/tests/test-utilizacoes-ciclo.ts
 */
import { precisaBackfill, INTERVALO_MINIMO_BACKFILL_MS } from "../../lib/catalog/utilizacoes-ciclo";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}`); }
};

const T = (iso: string) => new Date(iso);
/** Relógio fixo, para o teste não depender de quando corre. */
const agora = T("2026-09-09T18:00:00Z");
/** Um instante suficientemente antigo para o piso nunca ser o travão. */
const HA_MUITO = T("2026-09-08T00:00:00Z");

console.log("=== farmácia nova ===");
check(
  precisaBackfill({ ultimaAlteracaoCatalogo: T("2026-09-09T10:00:00Z"), ultimoBackfillEm: null, agora }),
  "primeiro catálogo sem backfill nenhum → há trabalho",
);
// Sem catálogo não há nada para classificar. Correr o backfill aqui seria
// varrer uma tabela vazia a cada 10 minutos.
check(
  !precisaBackfill({ ultimaAlteracaoCatalogo: null, ultimoBackfillEm: null, agora }),
  "tenant sem catálogo → não há nada a fazer",
);
check(
  !precisaBackfill({ ultimaAlteracaoCatalogo: null, ultimoBackfillEm: T("2026-09-01T00:00:00Z"), agora }),
  "backfill antigo mas catálogo vazio → continua sem trabalho",
);

console.log("\n=== regime normal ===");
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T10:00:00Z"),
    ultimoBackfillEm: HA_MUITO,
    agora,
  }),
  "catálogo alterado depois do backfill → há produtos novos por classificar",
);
// É esta asserção que impede o catálogo inteiro de ser reprocessado a
// cada passagem do scheduler.
check(
  !precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-08T09:00:00Z"),
    ultimoBackfillEm: T("2026-09-09T10:00:00Z"),
    agora,
  }),
  "backfill posterior à última alteração → nada a fazer",
);
check(
  !precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T10:00:00Z"),
    ultimoBackfillEm: T("2026-09-09T10:00:00Z"),
    agora,
  }),
  "instantes iguais → nada a fazer (não repete)",
);

console.log("\n=== o piso entre varreduras ===");
// O backfill lê o catálogo inteiro. Sem piso, e com o gatilho novo, o job
// de 10 em 10 minutos varria 35 000 produtos seis vezes por hora para
// escrever zero — porque em produção há escrita em `Produto` quase
// contínua (o ciclo de enriquecimento corre de 15 em 15 minutos).
check(
  !precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T17:55:00Z"),
    ultimoBackfillEm: T("2026-09-09T17:30:00Z"),
    agora,
  }),
  "catálogo mudou mas varreu-se há 30 min → espera",
);
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T17:55:00Z"),
    ultimoBackfillEm: new Date(agora.getTime() - INTERVALO_MINIMO_BACKFILL_MS),
    agora,
  }),
  "exactamente no piso → corre (fronteira inclusiva)",
);
// O piso atrasa, não perde: a alteração continua a ser verdade na
// passagem seguinte. É o que torna isto recuperável sem fila.
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T11:00:00Z"),
    ultimoBackfillEm: T("2026-09-09T10:00:00Z"),
    agora: T("2026-09-09T16:30:00Z"),
  }),
  "a mesma alteração que esperou às 11:30 dispara às 16:30",
);
// O piso nunca trava um tenant que nunca foi varrido — senão uma
// farmácia acabada de instalar esperava seis horas pela faceta.
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T17:59:00Z"),
    ultimoBackfillEm: null,
    agora,
  }),
  "primeira vez de todas ignora o piso",
);

console.log("\n=== um segundo chega ===");
// A comparação com o backfill é estrita e não tem tolerância: uma
// alteração é uma alteração. Quem trava a cadência é o piso, não esta.
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T10:00:01Z"),
    ultimoBackfillEm: T("2026-09-09T10:00:00Z"),
    agora: T("2026-09-09T20:00:00Z"),
  }),
  "um segundo depois já conta",
);

console.log("\n=== regressão: o mês em que o backfill não correu ===");
// Retrato do tenant garantia em 2026-09-09: catálogo a ser escrito todos
// os dias, 31 corridas ABANDONADA, 5 ABERTA, 0 FINALIZADA, e
// `CatalogoBackfillRun` vazia. Com o sinal antigo isto era `false` — e
// esteve `false` durante um mês, em silêncio.
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T11:26:04Z"),
    ultimoBackfillEm: null,
    agora,
  }),
  "catálogo a mexer + nenhuma corrida finalizada + nunca varrido → corre",
);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
