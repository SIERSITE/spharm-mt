/**
 * scripts/diagnostics/importacao-diaria.ts
 *
 * Onde é que a importação diária parou, farmácia a farmácia.
 *
 * ─────────────────────────────────────────────────────────────────────
 * A CADEIA, E O QUE CADA ELO DEIXA ESCRITO
 *
 *   tarefa agendada no PC  →  agent lê o SQL Server  →  POST /api/ingest
 *   →  a API aceita  →  o backend processa  →  os dados aparecem
 *
 * Nem todos os elos deixam rasto NA BASE, e é isso que decide o que este
 * diagnóstico consegue afirmar:
 *
 *   PipelineRun        o agent regista aqui cada corrida diária. É o
 *                      primeiro sinal de que a tarefa local ARRANCOU.
 *   staging            o que a API ACEITOU e gravou: IngestVendaLinhaRaw,
 *                      IngestProdutoRun, StagingCompraRawLine,
 *                      StagingDevolucaoFornecedorRawLine, IngestStocksMovRaw.
 *   frescura           a data máxima dos dados por dataset — o resultado.
 *
 * ── O ERRO QUE ESTE FICHEIRO JÁ TEVE ─────────────────────────────────
 *
 * A primeira versão media «o que chegou à API» por `LoteIngestao`. Está
 * errado, e não por pouco: `LoteIngestao` é escrito por
 * `/api/ingest/v1/snapshot/*` — o caminho dos ficheiros/snapshot — e a
 * cadeia diária do agent entra por `/api/ingest/v1/bootstrap/*`, que
 * **nunca** escreve um lote. A tabela está vazia para toda a gente que
 * usa o agent, portanto a regra "correu mas não há lote" dava fase C a
 * qualquer farmácia, sempre, independentemente do que tivesse chegado.
 *
 * Na Castelo isso foi desmentido pelos logs do proxy: seis endpoints
 * `bootstrap/*` servidos às 03:30, com o diagnóstico a dizer que ela não
 * tinha entregue nada. Um diagnóstico que acusa o elo errado é pior do
 * que nenhum — manda arranjar o PC quando o problema está no servidor.
 *
 * A entrega passa a ser medida onde ela realmente aterra: os `max()` dos
 * carimbos de ingestão das cinco tabelas de staging, por farmácia.
 *
 * ── E A FASE QUE FALTAVA ─────────────────────────────────────────────
 *
 * Faltava o caso em que TUDO funciona e o dia na mesma não fecha: o
 * `aggregate-month` recusa-se a agregar (409) e o agent devolve erro. Os
 * dados entraram em staging, a cadeia está sã, e o dia nunca é marcado
 * OK — portanto o catch-up volta a propô-lo para sempre. Isso agora tem
 * nome próprio (fase GATE) em vez de cair no balde "outro".
 *
 * O QUE NÃO SE VÊ DAQUI, e é preciso dizê-lo em vez de o adivinhar: um
 * pedido RECUSADO pela API (401, 403, tenant errado, farmaciaId
 * inválido) não escreve linha nenhuma na base do tenant. Se o agent
 * está a bater à porta e a levar com a porta na cara, a base fica igual
 * a se ele nunca tivesse tentado. Essa pergunta responde-se nos logs do
 * proxy e da app, e o relatório diz onde.
 *
 * Pela mesma razão, a fase A (tarefa não arrancou) e a B (arrancou mas
 * não leu o SQL) são indistinguíveis do lado do servidor quando nada
 * chega: as duas produzem exactamente o mesmo silêncio. O diagnóstico
 * di-lo — «A ou B ou D» — em vez de escolher uma à sorte.
 *
 * ─────────────────────────────────────────────────────────────────────
 * READ-ONLY
 *
 * `default_transaction_read_only` nas duas ligações antes da primeira
 * consulta. Sem escritas, sem reimportações, sem tocar no scheduler.
 *
 * Uso:
 *   npm run diag:importacao-diaria-garantia
 *   npm run diag:importacao-diaria-garantia -- --tenant=silveira
 *   npm run diag:importacao-diaria-garantia -- --dias=14
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, controlPrisma, getTenantBySlug } from "../../lib/control-plane";
import { getFrescuraPorFarmacia, type FrescuraCelula } from "../../lib/pipeline-freshness";

const linha = (s = "") => console.log(s);
const corta = (s: string | null | undefined, n: number) => (s ?? "—").slice(0, n).padEnd(n);
const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const stamp = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

const idade = (d: Date | null | undefined): string => {
  if (!d) return "—";
  const h = Math.floor((Date.now() - d.getTime()) / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

const valorArg = (argv: string[], nome: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=").trim();

/** As fases da cadeia, pela ordem em que se partem. */
const FASES: Record<string, string> = {
  AB: "A/B · nada chegou ao servidor — tarefa não arrancou, ou o agent não leu o SQL",
  C: "C · o agent correu mas não entregou nada à API (nenhuma staging avançou)",
  D: "D · possível recusa da API — invisível na base, ver logs do proxy",
  E: "E · a API recebeu e o backend não concluiu o processamento",
  GATE: "GATE · entregou tudo; o aggregate-month recusou fechar o dia (409)",
  F: "F · a cadeia está sã; não há dados novos na origem",
  OK: "OK · a correr dentro do normal",
  G: "G · outro — ver as colunas em bruto",
};

type Farmacia = { id: string; nome: string };
type Run = {
  farmaciaId: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  dateRef: string | null;
  errorMessage: string | null;
  triggeredBy: string;
};
/**
 * O que a API aceitou e gravou, por farmácia — uma coluna por tabela de
 * staging da cadeia diária. É isto que prova entrega; ver o cabeçalho.
 */
type Entrega = {
  farmaciaId: string;
  vendas: Date | null;
  produtos: Date | null;
  compras: Date | null;
  devolucoes: Date | null;
  movimentos: Date | null;
};

const maisRecente = (e: Entrega | undefined): Date | null => {
  if (!e) return null;
  const ds = [e.vendas, e.produtos, e.compras, e.devolucoes, e.movimentos].filter(
    (d): d is Date => !!d,
  );
  return ds.length ? new Date(Math.max(...ds.map((d) => d.getTime()))) : null;
};

type Orfa = {
  farmacia: string;
  externalProductId: number;
  documento: string | null;
  externalSaleId: number;
  dataVenda: Date | null;
  tipoDocumento: number | null;
  tipoDocumentoClass: string;
  sourceNamespace: string;
  noCatalogo: boolean;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const slug = valorArg(argv, "tenant") ?? "garantia";
  const dias = Number(valorArg(argv, "dias") ?? 10);
  const hoje = new Date();
  const desde = new Date(Date.now() - dias * 86_400_000);

  linha("SPharm.MT · importação diária, farmácia a farmácia · READ-ONLY");
  linha(`  revisão da imagem: ${process.env.APP_REVISION ?? "(não carimbada)"}`);

  await controlPrisma.$executeRawUnsafe("set session default_transaction_read_only = on");
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`\nO tenant "${slug}" não existe no control plane.\n`);
    process.exit(2);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  linha("═".repeat(118));
  linha(`  tenant ${slug} · janela ${dias} dias (desde ${dia(desde)})`);
  linha("═".repeat(118));

  // ── O heartbeat é do TENANT, não da farmácia ──────────────────────
  //
  // `Tenant.lastAgentHeartbeatAt` é uma coluna do control plane e há uma
  // por tenant. Com cinco farmácias a reportar para o mesmo tenant, o
  // heartbeat mostra que ALGUÉM reportou — não quem. Serve para excluir
  // "o tenant inteiro está morto", e mais nada.
  linha("");
  linha("  0 · AGENT (por TENANT — não há heartbeat por farmácia)");
  linha(`      último heartbeat ... ${stamp(tenant.lastAgentHeartbeatAt)}  (${idade(tenant.lastAgentHeartbeatAt)})`);
  linha(`      versão ............. ${tenant.lastAgentVersion ?? "—"}`);
  linha(`      ip ................. ${tenant.lastAgentIp ?? "—"}`);
  linha("");
  linha("      Um só valor para as cinco farmácias: se uma delas parou e as");
  linha("      outras continuam, este campo continua fresco e não acusa nada.");

  const farmacias = await prisma.$queryRawUnsafe<Farmacia[]>(
    `select id, nome from "Farmacia" where estado = 'ATIVO' order by nome`,
  );

  // ── Última corrida DIÁRIA, por farmácia ───────────────────────────
  //
  // `kind = 'daily-pipeline'` não é um detalhe de filtro, é a correcção
  // de uma leitura errada. `/api/admin/pipeline/aggregate-month` grava a
  // sua run (kind='aggregate-month') com `farmacias[0].id` — a primeira
  // farmácia por nome — independentemente de qual agent a disparou. Como
  // essa run aborta sempre que o mês tem órfãs, a farmácia que calha ser
  // a primeira por ordem alfabética colecciona os ABORTED de todas as
  // outras.
  //
  // Sem este filtro, essa farmácia aparecia com "última execução
  // ABORTED" tendo os dados frescos e o seu próprio diário a correr bem
  // — e era a leitura da run de outra pessoa. O endpoint do catch-up já
  // filtra por `kind` (ver dias-concluidos), portanto a discrepância era
  // só do diagnóstico.
  const runs = await prisma.$queryRawUnsafe<Run[]>(
    `select distinct on (p."farmaciaId")
            p."farmaciaId", p.kind, p.status, p."startedAt", p."finishedAt",
            p."dateRef", p."errorMessage", p."triggeredBy"
       from "PipelineRun" p
      where p.kind = 'daily-pipeline'
      order by p."farmaciaId", p."startedAt" desc`,
  );
  const runPorFarmacia = new Map(runs.map((r) => [r.farmaciaId, r]));

  // As runs de agregação, à parte e sem fingir dono. Interessam porque
  // dizem se o mês está a abortar — não a quem.
  const aggs = await prisma.$queryRawUnsafe<Run[]>(
    `select p."farmaciaId", p.kind, p.status, p."startedAt", p."finishedAt",
            p."dateRef", p."errorMessage", p."triggeredBy"
       from "PipelineRun" p
      where p.kind = 'aggregate-month'
      order by p."startedAt" desc
      limit 12`,
  );

  // A última corrida BEM SUCEDIDA é outra pergunta: uma farmácia pode
  // ter corrido ontem e falhado, e o que interessa saber é quando foi a
  // última vez que correu até ao fim.
  const okRuns = await prisma.$queryRawUnsafe<Run[]>(
    `select distinct on (p."farmaciaId")
            p."farmaciaId", p.kind, p.status, p."startedAt", p."finishedAt",
            p."dateRef", p."errorMessage", p."triggeredBy"
       from "PipelineRun" p
      where p.status = 'OK' and p.kind = 'daily-pipeline'
      order by p."farmaciaId", p."startedAt" desc`,
  );
  const okPorFarmacia = new Map(okRuns.map((r) => [r.farmaciaId, r]));

  // ── O que a API ACEITOU, por farmácia ─────────────────────────────
  //
  // Cinco tabelas, uma por passo da cadeia diária. Um `max()` por cada:
  // é o carimbo do servidor, portanto responde "quando é que isto
  // chegou cá", que é exactamente a pergunta — e não "de que dia eram os
  // dados", que é outra.
  //
  // `LoteIngestao` NÃO entra aqui, de propósito: é do caminho snapshot.
  // Ver o cabeçalho.
  const entregas = await prisma.$queryRawUnsafe<Entrega[]>(
    `select "farmaciaId",
            max(vendas)     as vendas,
            max(produtos)   as produtos,
            max(compras)    as compras,
            max(devolucoes) as devolucoes,
            max(movimentos) as movimentos
       from (
         select "farmaciaId",
                max("importedAt")::timestamptz as vendas,
                null::timestamptz as produtos, null::timestamptz as compras,
                null::timestamptz as devolucoes, null::timestamptz as movimentos
           from "IngestVendaLinhaRaw" group by 1
         union all
         select "farmaciaId", null::timestamptz,
                max("lastBatchAtServer")::timestamptz,
                null::timestamptz, null::timestamptz, null::timestamptz
           from "IngestProdutoRun" group by 1
         union all
         select "farmaciaId", null::timestamptz, null::timestamptz,
                max("ingestedAt")::timestamptz,
                null::timestamptz, null::timestamptz
           from "StagingCompraRawLine" group by 1
         union all
         select "farmaciaId", null::timestamptz, null::timestamptz, null::timestamptz,
                max("ingestedAt")::timestamptz, null::timestamptz
           from "StagingDevolucaoFornecedorRawLine" group by 1
         union all
         select "farmaciaId", null::timestamptz, null::timestamptz, null::timestamptz,
                null::timestamptz, max("ingestedAt")::timestamptz
           from "IngestStocksMovRaw" group by 1
       ) t
      group by 1`,
  );
  const entregaPorFarmacia = new Map(entregas.map((e) => [e.farmaciaId, e]));

  // ── A frescura dos dados, reutilizando o loader do /admin/pipeline ─
  //
  // Mesma função que a página usa. Duas implementações da mesma pergunta
  // dariam dois números, e o que se ia acreditar era no mais recente.
  const frescura = await getFrescuraPorFarmacia(prisma);
  const frescPorFarmacia = new Map<string, FrescuraCelula[]>();
  for (const c of frescura) {
    frescPorFarmacia.set(c.farmaciaId, [...(frescPorFarmacia.get(c.farmaciaId) ?? []), c]);
  }
  const dataMaxVendas = (id: string): Date | null =>
    frescPorFarmacia.get(id)?.find((c) => c.dataset.startsWith("vendas"))?.dataMax ?? null;

  // ── O veredicto ───────────────────────────────────────────────────
  const diagnosticar = (f: Farmacia): { fase: string; nota: string } => {
    const run = runPorFarmacia.get(f.id);
    const entrega = maisRecente(entregaPorFarmacia.get(f.id));
    const recente = (d: Date | null | undefined) => !!d && d >= desde;

    if (!recente(run?.startedAt) && !recente(entrega)) {
      return {
        fase: "AB",
        nota: run
          ? `a última corrida foi ${dia(run.startedAt)} — desde então, silêncio`
          : "nunca houve corrida registada para esta farmácia",
      };
    }

    // A ordem importa: o gate vem ANTES de qualquer leitura de erro,
    // porque um dia travado no `aggregate-month` chega aqui com a
    // corrida em ABORTED/ERROR e com a entrega feita. Testar o erro
    // primeiro classificava-o como falha do agent — que é precisamente
    // a acusação errada que este ficheiro já fez uma vez.
    const msg = (run?.errorMessage ?? "").toLowerCase();
    const travadoNoGate =
      /aggregate-month|operational orphan|unknowns_present|totals_negative|http 409/.test(msg) ||
      (run?.status === "ABORTED" && recente(entrega));
    if (travadoNoGate) {
      return {
        fase: "GATE",
        nota: recente(entrega)
          ? `entregou até ${stamp(entrega)}; o mês não fecha`
          : "o mês não fecha — ver a parte 3",
      };
    }

    if (run?.status === "ERROR") {
      const sql = /sql|conex|connection|login|timeout|server/.test(msg);
      return {
        fase: sql ? "AB" : "G",
        nota: sql ? "a corrida falhou a ler a origem" : "a corrida terminou em erro",
      };
    }
    if (recente(run?.startedAt) && !recente(entrega)) {
      return {
        fase: "C",
        nota: "a corrida arrancou e nenhuma tabela de staging avançou na janela",
      };
    }
    const dm = dataMaxVendas(f.id);
    if (dm && dm < desde) {
      return { fase: "F", nota: `cadeia sã, mas os dados param em ${dia(dm)}` };
    }
    return { fase: "OK", nota: "" };
  };

  // ── PARTE 1 · a tabela ────────────────────────────────────────────
  linha("");
  linha("  1 · POR FARMÁCIA");
  linha("");
  linha(
    `      ${"farmácia".padEnd(20)}${"últ. execução".padEnd(18)}${"últ. OK".padEnd(18)}` +
      `${"últ. entrega".padEnd(18)}${"vendas até".padEnd(12)}estado`,
  );
  linha(`      ${"─".repeat(94)}`);

  const veredictos = new Map<string, { fase: string; nota: string }>();
  for (const f of farmacias) {
    const run = runPorFarmacia.get(f.id);
    const ok = okPorFarmacia.get(f.id);
    const e = entregaPorFarmacia.get(f.id);
    const v = diagnosticar(f);
    veredictos.set(f.id, v);

    linha(
      `      ${corta(f.nome, 20)}${corta(stamp(run?.startedAt), 18)}${corta(stamp(ok?.startedAt), 18)}` +
        `${corta(stamp(maisRecente(e)), 18)}` +
        `${corta(dia(dataMaxVendas(f.id)), 12)}${run?.status ?? "—"}`,
    );
    linha(`        id=${f.id}${run ? `  ·  kind=${run.kind} dateRef=${run.dateRef ?? "—"} por=${run.triggeredBy}` : ""}`);
    // A entrega, aberta por tabela: é isto que distingue "não entregou
    // nada" de "entregou tudo e o mês não fechou".
    linha(
      `        entregue: vendas=${stamp(e?.vendas)} produtos=${stamp(e?.produtos)} ` +
        `compras=${stamp(e?.compras)} devol=${stamp(e?.devolucoes)} movs=${stamp(e?.movimentos)}`,
    );
    if (run?.errorMessage) linha(`        ERRO: ${run.errorMessage.slice(0, 110)}`);
    linha(`        >>> ${FASES[v.fase]}${v.nota ? `  —  ${v.nota}` : ""}`);
    linha("");
  }

  // ── PARTE 2 · frescura, dataset a dataset ─────────────────────────
  linha("  2 · DATA MÁXIMA POR DATASET");
  const datasets = [...new Set(frescura.map((c) => c.dataset))];
  linha("");
  linha(`      ${"farmácia".padEnd(20)}${datasets.map((d) => d.slice(0, 16).padEnd(18)).join("")}`);
  linha(`      ${"─".repeat(20 + datasets.length * 18)}`);
  for (const f of farmacias) {
    const celulas = frescPorFarmacia.get(f.id) ?? [];
    linha(
      `      ${corta(f.nome, 20)}` +
        datasets
          .map((d) => {
            const c = celulas.find((x) => x.dataset === d);
            const atras = c?.diasAtras && c.diasAtras > 0 ? ` (-${c.diasAtras}d)` : "";
            return `${dia(c?.dataMax ?? null)}${atras}`.padEnd(18);
          })
          .join(""),
    );
  }
  linha("");
  linha("      `-Nd` = dias atrás da farmácia MAIS FRESCA deste dataset, não de hoje.");
  linha("      Comparar com hoje acusava toda a gente num fim-de-semana sem vendas.");

  // ── PARTE 3 · o gate do aggregate-month ───────────────────────────
  //
  // O passo 2 do `daily-pipeline` chama `/api/admin/pipeline/aggregate-month`
  // para o MÊS do dia que está a processar. Esse endpoint agrega o mês
  // inteiro de TODAS as farmácias activas do tenant — o `farmaciaId` que
  // lá vai é metadata da run, não um filtro. Logo: uma linha órfã de UMA
  // farmácia aborta o mês de TODAS, e cada agent recebe HTTP 409.
  //
  // É por isso que esta parte não é por farmácia. O gate também não é.
  linha("");
  linha("  3 · O GATE DO AGGREGATE-MONTH (é do TENANT, não da farmácia)");
  linha("");
  linha("      Um dia só fecha se o mês agregar. O mês agrega uma vez para todas");
  linha("      as farmácias activas, portanto duas linhas órfãs numa farmácia");
  linha("      travam o mês — e o dia — das cinco.");
  linha("");

  const desdeMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 2, 1));
  const porMes = await prisma.$queryRawUnsafe<
    Array<{ mes: string; linhas: number; orfaos: number; servicos: number; unknowns: number }>
  >(
    `select to_char(date_trunc('month', "dataVenda"), 'YYYY-MM')                    as mes,
            count(*)::int                                                           as linhas,
            count(*) filter (where "produtoId" is null
                               and "isNonStockService" = false)::int                as orfaos,
            count(*) filter (where "produtoId" is null
                               and "isNonStockService" = true)::int                 as servicos,
            count(*) filter (where "tipoDocumentoClass" = 'UNKNOWN')::int           as unknowns
       from "IngestVendaLinhaRaw"
      where "dataVenda" >= '${desdeMes.toISOString()}'
      group by 1
      order by 1 desc`,
  );

  if (aggs.length > 0) {
    linha("      ÚLTIMAS AGREGAÇÕES (do tenant — o `farmaciaId` gravado nestas");
    linha("      linhas é a 1ª farmácia por nome, não quem as disparou):");
    linha("");
    for (const a of aggs.slice(0, 6)) {
      linha(
        `        ${stamp(a.startedAt)}  ${corta(a.dateRef, 9)}${corta(a.status, 10)}` +
          `${(a.errorMessage ?? "").slice(0, 74)}`,
      );
    }
    linha("");
  }

  linha(`      ${"mês".padEnd(10)}${"linhas".padStart(10)}${"ÓRFÃS".padStart(10)}${"serviços".padStart(10)}${"unknowns".padStart(10)}   gate`);
  linha(`      ${"─".repeat(64)}`);
  for (const m of porMes) {
    const trava = m.orfaos > 0 || m.unknowns > 0;
    linha(
      `      ${m.mes.padEnd(10)}${String(m.linhas).padStart(10)}${String(m.orfaos).padStart(10)}` +
        `${String(m.servicos).padStart(10)}${String(m.unknowns).padStart(10)}   ` +
        (trava ? "ABORTA" : "passa"),
    );
  }
  linha("");
  linha("      «serviços» são órfãs benignas (Processa_Stocks=0 no ERP): taxas,");
  linha("      administração de injectáveis, rastreios. Não travam nada.");
  linha("      «ÓRFÃS» são as operacionais — o ERP diz que é artigo com stock e");
  linha("      o CodigoID não existe em ProdutoFarmacia dessa farmácia.");

  // As linhas concretas. Sem isto, "2 operational orphans" é um número
  // sem acção: o gate diz quantas são e não diz quais, e a única forma
  // de saber era abrir a base à mão.
  const orfas = await prisma.$queryRawUnsafe<Orfa[]>(
    `select f.nome                                        as farmacia,
            r."externalProductId", r.documento, r."externalSaleId",
            r."dataVenda", r."tipoDocumento", r."tipoDocumentoClass",
            r."sourceNamespace",
            exists (select 1 from "ProdutoFarmacia" pf
                     where pf."farmaciaId" = r."farmaciaId"
                       and pf."externalProductId" = r."externalProductId") as "noCatalogo"
       from "IngestVendaLinhaRaw" r
       join "Farmacia" f on f.id = r."farmaciaId"
      where r."produtoId" is null
        and r."isNonStockService" = false
        and r."dataVenda" >= '${desdeMes.toISOString()}'
      order by r."dataVenda" desc, r."externalProductId"
      limit 60`,
  );

  linha("");
  if (orfas.length === 0) {
    linha("      Sem linhas órfãs operacionais na janela. O gate não é o travão.");
  } else {
    linha(`      AS ${orfas.length} LINHAS QUE TRAVAM O MÊS:`);
    linha("");
    linha(
      `      ${"farmácia".padEnd(18)}${"CodigoID".padStart(10)}  ${"documento".padEnd(16)}` +
        `${"dia".padEnd(12)}${"tipoDoc".padStart(8)}  ${"classe".padEnd(20)}catálogo`,
    );
    linha(`      ${"─".repeat(104)}`);
    for (const o of orfas) {
      linha(
        `      ${corta(o.farmacia, 18)}${String(o.externalProductId).padStart(10)}  ` +
          `${corta(o.documento, 16)}${corta(dia(o.dataVenda), 12)}` +
          `${String(o.tipoDocumento ?? "—").padStart(8)}  ${corta(o.tipoDocumentoClass, 20)}` +
          (o.noCatalogo ? "JÁ EXISTE" : "ausente"),
      );
    }
    linha("");
    linha("      A coluna «catálogo» decide a correcção, e são correcções");
    linha("      diferentes:");
    linha("");
    linha("        JÁ EXISTE  o produto entrou em ProdutoFarmacia DEPOIS da venda");
    linha("                   ter sido ingerida. A linha nunca foi re-resolvida.");
    linha("                   → ingest:reprocess-produto-mapping (re-resolve o");
    linha("                     produtoId a partir do raw guardado; não é preciso");
    linha("                     re-enviar do PC)");
    linha("");
    linha("        ausente    o CodigoID não está mesmo no catálogo desta farmácia.");
    linha("                   → confirmar no ERP com run-inspect-codigoid.bat.");
    linha("                     Se Processa_Stocks=0, é serviço e o lugar dele é");
    linha("                     ingest:backfill-services. Se for artigo a sério,");
    linha("                     falta o /products dessa farmácia — corrigir isso,");
    linha("                     não o gate.");
    linha("");
    linha("      allowOrphans NÃO é a correcção: manda somar o mês deixando as");
    linha("      linhas de fora, em silêncio e para sempre.");

  }

  // ── PARTE 4 · o que a base não sabe ───────────────────────────────
  linha("");
  linha("  4 · O QUE ESTE DIAGNÓSTICO NÃO CONSEGUE VER");
  linha("");
  linha("      Um pedido RECUSADO pela API não escreve nada nesta base. 401, 403,");
  linha("      tenant errado ou farmaciaId inválido deixam a base exactamente como");
  linha("      se o agent nunca tivesse tentado — e por isso a fase D é uma");
  linha("      hipótese, nunca uma conclusão, a partir daqui.");
  linha("");
  linha("      Para a confirmar, nos logs do servidor:");
  linha("");
  linha("        sudo docker logs --since 72h spharmmt-proxy 2>&1 | grep '/api/ingest' | grep -v ' 200 '");
  linha("        sudo docker logs --since 72h spharmmt-web   2>&1 | grep -i 'ingest\\|unauthorized\\|farmacia'");
  linha("");
  linha("      E a fase A (a tarefa agendada não arrancou) só se vê no PC da");
  linha("      farmácia: Agendador de Tarefas, e o log do agent na pasta dele.");
  linha("");
  linha("      `LoteIngestao` não é consultado aqui: é do caminho snapshot");
  linha("      (/api/ingest/v1/snapshot/*), não da cadeia diária do agent, que");
  linha("      entra por /api/ingest/v1/bootstrap/*. Medir a entrega por lotes");
  linha("      dava fase C a toda a gente — foi o defeito que esta versão corrige.");

  // ── PARTE 5 · resumo ──────────────────────────────────────────────
  linha("");
  linha("  5 · RESUMO");
  for (const [fase, texto] of Object.entries(FASES)) {
    const quais = farmacias.filter((f) => veredictos.get(f.id)?.fase === fase);
    if (quais.length === 0) continue;
    linha(`      ${String(quais.length).padStart(3)} × ${texto}`);
    linha(`            ${quais.map((f) => f.nome).join(", ")}`);
  }

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
