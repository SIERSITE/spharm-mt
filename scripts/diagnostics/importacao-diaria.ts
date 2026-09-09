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
 *   LoteIngestao       um lote recebido pela API, com estado e erro.
 *   IngestProdutoRun   a corrida de produtos, com o último batch.
 *   frescura           a data máxima dos dados por dataset — o resultado.
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
  C: "C · o agent correu mas não entregou nada à API",
  D: "D · possível recusa da API — invisível na base, ver logs do proxy",
  E: "E · a API recebeu e o backend não concluiu o processamento",
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
type Lote = {
  farmaciaId: string;
  ultimoRecebido: Date | null;
  ultimoProcessado: Date | null;
  estado: string | null;
  mensagemErro: string | null;
  pendentes: number;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const slug = valorArg(argv, "tenant") ?? "garantia";
  const dias = Number(valorArg(argv, "dias") ?? 10);
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

  // ── Última corrida do agent, por farmácia ─────────────────────────
  const runs = await prisma.$queryRawUnsafe<Run[]>(
    `select distinct on (p."farmaciaId")
            p."farmaciaId", p.kind, p.status, p."startedAt", p."finishedAt",
            p."dateRef", p."errorMessage", p."triggeredBy"
       from "PipelineRun" p
      order by p."farmaciaId", p."startedAt" desc`,
  );
  const runPorFarmacia = new Map(runs.map((r) => [r.farmaciaId, r]));

  // A última corrida BEM SUCEDIDA é outra pergunta: uma farmácia pode
  // ter corrido ontem e falhado, e o que interessa saber é quando foi a
  // última vez que correu até ao fim.
  const okRuns = await prisma.$queryRawUnsafe<Run[]>(
    `select distinct on (p."farmaciaId")
            p."farmaciaId", p.kind, p.status, p."startedAt", p."finishedAt",
            p."dateRef", p."errorMessage", p."triggeredBy"
       from "PipelineRun" p
      where p.status = 'OK'
      order by p."farmaciaId", p."startedAt" desc`,
  );
  const okPorFarmacia = new Map(okRuns.map((r) => [r.farmaciaId, r]));

  // ── Lotes recebidos pela API ──────────────────────────────────────
  const lotes = await prisma.$queryRawUnsafe<Lote[]>(
    `select l."farmaciaId",
            max(l."dataCriacao")                                    as "ultimoRecebido",
            max(l."dataProcessamento")                              as "ultimoProcessado",
            (array_agg(l.estado::text order by l."dataCriacao" desc))[1]     as estado,
            (array_agg(l."mensagemErro" order by l."dataCriacao" desc))[1]   as "mensagemErro",
            count(*) filter (where l."dataProcessamento" is null)::int       as pendentes
       from "LoteIngestao" l
      group by l."farmaciaId"`,
  );
  const lotePorFarmacia = new Map(lotes.map((l) => [l.farmaciaId, l]));

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
    const lote = lotePorFarmacia.get(f.id);
    const recente = (d: Date | null | undefined) => !!d && d >= desde;

    if (!recente(run?.startedAt) && !recente(lote?.ultimoRecebido)) {
      return {
        fase: "AB",
        nota: run
          ? `a última corrida foi ${dia(run.startedAt)} — desde então, silêncio`
          : "nunca houve corrida registada para esta farmácia",
      };
    }
    if (run?.status === "ERROR") {
      const m = (run.errorMessage ?? "").toLowerCase();
      const sql = /sql|conex|connection|login|timeout|server/.test(m);
      return {
        fase: sql ? "AB" : "G",
        nota: sql ? "a corrida falhou a ler a origem" : "a corrida terminou em erro",
      };
    }
    if (recente(run?.startedAt) && !recente(lote?.ultimoRecebido)) {
      return { fase: "C", nota: "o agent correu mas não há lote recebido na janela" };
    }
    if ((lote?.pendentes ?? 0) > 0) {
      return { fase: "E", nota: `${lote?.pendentes} lote(s) recebidos e por processar` };
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
      `${"últ. upload".padEnd(18)}${"últ. process.".padEnd(18)}${"vendas até".padEnd(12)}estado`,
  );
  linha(`      ${"─".repeat(112)}`);

  const veredictos = new Map<string, { fase: string; nota: string }>();
  for (const f of farmacias) {
    const run = runPorFarmacia.get(f.id);
    const ok = okPorFarmacia.get(f.id);
    const lote = lotePorFarmacia.get(f.id);
    const v = diagnosticar(f);
    veredictos.set(f.id, v);

    linha(
      `      ${corta(f.nome, 20)}${corta(stamp(run?.startedAt), 18)}${corta(stamp(ok?.startedAt), 18)}` +
        `${corta(stamp(lote?.ultimoRecebido), 18)}${corta(stamp(lote?.ultimoProcessado), 18)}` +
        `${corta(dia(dataMaxVendas(f.id)), 12)}${run?.status ?? "—"}`,
    );
    linha(`        id=${f.id}${run ? `  ·  kind=${run.kind} dateRef=${run.dateRef ?? "—"} por=${run.triggeredBy}` : ""}`);
    if (run?.errorMessage) linha(`        ERRO: ${run.errorMessage.slice(0, 96)}`);
    if (lote?.mensagemErro) linha(`        LOTE: ${lote.mensagemErro.slice(0, 96)}`);
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

  // ── PARTE 3 · o que a base não sabe ───────────────────────────────
  linha("");
  linha("  3 · O QUE ESTE DIAGNÓSTICO NÃO CONSEGUE VER");
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

  // ── PARTE 4 · resumo ──────────────────────────────────────────────
  linha("");
  linha("  4 · RESUMO");
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
