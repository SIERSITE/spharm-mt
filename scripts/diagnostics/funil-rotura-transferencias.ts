/**
 * scripts/diagnostics/funil-rotura-transferencias.ts
 *
 * Diagnóstico READ-ONLY. Não escreve, não altera, não corre migrations.
 * Responde a duas perguntas com números reais do tenant:
 *
 *   1. Como se chega aos "em rotura" do Dashboard, e como é que esses
 *      produtos se distribuem por recência e por volume de procura.
 *
 *   2. Como se chega às N sugestões de transferência — etapa a etapa,
 *      com a contagem de eliminados em cada regra.
 *
 * ── PORQUE É QUE ISTO NÃO IMPORTA `lib/transferencias-data` ──────────
 *
 * Corre na imagem `migrate`, que é Node puro — não é o runtime do Next.
 * Vários módulos da aplicação começam com `import "server-only"`, um
 * módulo que só existe dentro do build do Next; importá-los aqui dá
 * `Cannot find module 'server-only'` antes da primeira linha correr.
 * `lib/control-plane.ts` documenta a mesma convenção no seu cabeçalho.
 *
 * Este ficheiro importa APENAS módulos puros:
 *
 *   · lib/operational/motor-stock      — a aritmética partilhada
 *   · lib/operational/janela-meses     — as janelas
 *   · lib/operational/policy           — a calibração da farmácia
 *   · lib/catalog/target-db            — o resolvedor `--tenant`
 *   · lib/control-plane                — credenciais do control plane
 *
 * As QUERIES são reproduzidas aqui, à vista. Não é duplicação alegre:
 * cada regra copiada tem, ao lado, uma verificação do ficheiro-fonte. Se
 * mudar lá, este diagnóstico grita em vez de continuar a medir a regra
 * antiga em silêncio. E há um teste (`test:diagnostico-tools`) que
 * percorre o grafo de imports e falha se algum trouxer `server-only`.
 *
 * ── LIGAÇÃO ─────────────────────────────────────────────────────────
 *
 * Pelo control plane, com `--tenant=<slug>` — o mesmo caminho de todos
 * os outros scripts do perfil `tools`. NÃO usa `getPrisma()`: fora de um
 * request esse resolve o tenant como `null` e cai na base legacy, ou
 * seja, mediria a base errada sem dizer nada.
 *
 *   npx tsx scripts/diagnostics/funil-rotura-transferencias.ts --tenant=silveira
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { classificarRotura, temRecorrencia, temVolume } from "../../lib/operational/rotura";
import {
  descreverPolicy,
  getOperationalPolicy,
  reservaOrigemDias,
} from "../../lib/operational/policy";
import {
  avaliarLinha,
  ehAccionavel,
  ehDestinoElegivel,
  emparelhar,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "../../lib/operational/motor-stock";
import {
  diasDaJanela,
  janelaOperacionalPorOmissao,
  janelaParaIndicesMensais,
} from "../../lib/operational/janela-meses";

const nf = (n: number) => n.toLocaleString("pt-PT");
const linha = (r: string) => console.log(r);
const titulo = (t: string) => {
  console.log("");
  console.log("═".repeat(72));
  console.log(t);
  console.log("═".repeat(72));
};

function tabela(rotulos: string[], valores: number[], total: number) {
  const larg = Math.max(...rotulos.map((r) => r.length));
  rotulos.forEach((r, i) => {
    const v = valores[i];
    const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0.0";
    const barra = "█".repeat(Math.round((total > 0 ? v / total : 0) * 40));
    linha(`  ${r.padEnd(larg)}  ${String(nf(v)).padStart(7)}  ${pct.padStart(5)}%  ${barra}`);
  });
}

/**
 * Confirma que uma regra copiada continua a ser a regra do código.
 *
 * Um diagnóstico que mede uma regra já mudada é pior do que nenhum: dá
 * um número com ar de verdade. Isto lê o ficheiro-fonte e avisa.
 */
function confirmarRegra(ficheiro: string, fragmento: string, descricao: string): boolean {
  let fonte = "";
  try {
    fonte = readFileSync(ficheiro, "utf8");
  } catch {
    linha(`  !! não consegui ler ${ficheiro} — regra não confirmada: ${descricao}`);
    return false;
  }
  if (fonte.includes(fragmento)) {
    linha(`  ✓ ${descricao}`);
    return true;
  }
  linha(`  !! ATENÇÃO: ${descricao}`);
  linha(`     MUDOU em ${ficheiro}. Este diagnóstico mede a regra antiga:`);
  linha(`     ${fragmento}`);
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// As queries, reproduzidas à vista.
// ══════════════════════════════════════════════════════════════════════

type LinhaPf = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  stockAtual: number;
  dataUltimaVenda: Date | null;
};

/**
 * A parte de `loadPfAndSales` que interessa (lib/transferencias-data).
 *
 * `incluirSemStock` espelha `includeOutOfStock`: os Excessos usam o
 * default (só stock > 0); a regra de rotura precisa das linhas a zero.
 */
async function carregarProdutoFarmacia(
  prisma: PrismaClient,
  farmaciaIds: string[],
  incluirSemStock: boolean,
): Promise<LinhaPf[]> {
  const stockClause = incluirSemStock
    ? Prisma.sql`pf."stockAtual" IS NOT NULL`
    : Prisma.sql`pf."stockAtual" IS NOT NULL AND pf."stockAtual" > 0`;

  return prisma.$queryRaw<LinhaPf[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome                  AS "farmaciaNome",
      pf."stockAtual"::float  AS "stockAtual",
      pf."dataUltimaVenda"    AS "dataUltimaVenda"
    FROM "ProdutoFarmacia" pf
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    WHERE ${stockClause}
      AND pf."flagRetirado" = false
      AND f.id = ANY(${farmaciaIds})
  `);
}

/** Soma de VendaMensal por (produto, farmácia) numa janela de meses. */
async function somarVendas(
  prisma: PrismaClient,
  farmaciaIds: string[],
  inicioIndice: number,
  fimExclusivo: number,
): Promise<Map<string, number>> {
  const linhas = await prisma.$queryRaw<
    Array<{ produtoId: string; farmaciaId: string; totalQty: number }>
  >(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId", SUM(vm.quantidade)::float AS "totalQty"
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= ${inicioIndice}
      AND (vm.ano * 12 + vm.mes) < ${fimExclusivo}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  const mapa = new Map<string, number>();
  for (const l of linhas) mapa.set(`${l.produtoId}:${l.farmaciaId}`, Number(l.totalQty) || 0);
  return mapa;
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  // Impresso ANTES de qualquer trabalho: é por esta linha que o teste de
  // fumo sabe que o grafo de imports carregou até ao fim.
  linha("SPharm.MT · funil rotura/transferências · diagnóstico read-only");

  let alvo;
  try {
    alvo = await resolverAlvo(process.argv.slice(2), {
      getTenantBySlug,
      buildTenantConnectionString,
    });
  } catch (e) {
    if (e instanceof AlvoRecusado) {
      linha("");
      linha(e.message);
      process.exit(2);
    }
    throw e;
  }
  linha(`Alvo: ${descreverAlvo(alvo)}`);

  // A POLICY do tenant, impressa antes de qualquer numero. Sem isto
  // nao se sabe o que esta a ser medido: os mesmos dados dao
  // resultados diferentes consoante a calibracao, e um relatorio sem
  // cabecalho e um relatorio que se atribui a farmacia errada.
  const policy = getOperationalPolicy(alvo.tenant ?? null);
  linha("");
  for (const l of descreverPolicy(policy)) linha(l);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: alvo.url }),
  });

  try {
    const farmacias = await prisma.farmacia.findMany({
      where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    });
    linha(`Farmácias activas: ${farmacias.map((f) => f.nome).join(", ") || "(nenhuma)"}`);
    const farmaciaIds = farmacias.map((f) => f.id);
    if (farmaciaIds.length === 0) {
      linha("Sem farmácias activas — nada a medir.");
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // PARTE 1 · "EM ROTURA"
    //
    //     row.stockAtual <= 0 && row.salesQty90d > 0
    //
    // `salesQty90d` vem de `loadPfAndSales` SEM janela — os três meses
    // civis ANTERIORES ao corrente. Uma unidade vendida chega.
    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 1 · Em rotura — a regra actual e o que ela apanha");

    confirmarRegra(
      "lib/stock-shared.ts",
      "return row.stockAtual <= 0 && row.salesQty90d > 0;",
      "regra de rotura: stock <= 0 E vendas na janela > 0",
    );
    confirmarRegra(
      "lib/transferencias-data.ts",
      "periodStart: janelaDefault.periodEnd - 3",
      "janela por omissão: os 3 meses ANTERIORES ao corrente",
    );

    const agora = new Date();
    const idxMesCorrente = agora.getUTCFullYear() * 12 + agora.getUTCMonth() + 1;
    const vendas90 = await somarVendas(prisma, farmaciaIds, idxMesCorrente - 3, idxMesCorrente);
    const pfTodos = await carregarProdutoFarmacia(prisma, farmaciaIds, true);

    const stockRows = pfTodos.map((p) => ({
      ...p,
      salesQty90d: vendas90.get(`${p.produtoId}:${p.farmaciaId}`) ?? 0,
    }));
    const semStock = stockRows.filter((r) => Number(r.stockAtual) <= 0);
    const emRotura = semStock.filter((r) => r.salesQty90d > 0);

    linha("");
    linha(`  linhas (produto × farmácia) ................. ${nf(stockRows.length)}`);
    linha(`  com stock <= 0 ............................. ${nf(semStock.length)}`);
    linha(`  …e vendas > 0 na janela  ⇒ EM ROTURA ....... ${nf(emRotura.length)}`);
    linha(`  (stock 0 sem vendas na janela, excluídos) ... ${nf(semStock.length - emRotura.length)}`);

    // ── Recência da última venda ──────────────────────────────────────
    const hoje = Date.now();
    const diasDesde = (d: Date | null) =>
      d ? Math.floor((hoje - new Date(d).getTime()) / 86_400_000) : null;

    const baldesRecencia = ["<= 7 dias", "8–30", "31–60", "61–90", "> 90", "sem data"];
    const contagemRecencia = [0, 0, 0, 0, 0, 0];
    for (const r of emRotura) {
      const d = diasDesde(r.dataUltimaVenda);
      if (d === null) contagemRecencia[5]++;
      else if (d <= 7) contagemRecencia[0]++;
      else if (d <= 30) contagemRecencia[1]++;
      else if (d <= 60) contagemRecencia[2]++;
      else if (d <= 90) contagemRecencia[3]++;
      else contagemRecencia[4]++;
    }
    linha("");
    linha("  Última venda (ProdutoFarmacia.dataUltimaVenda):");
    tabela(baldesRecencia, contagemRecencia, emRotura.length);

    // ── Volume vendido na janela ──────────────────────────────────────
    const baldesVolume = ["1 unidade", "2–3", "4–10", "> 10"];
    const contagemVolume = [0, 0, 0, 0];
    for (const r of emRotura) {
      const q = r.salesQty90d;
      if (q <= 1) contagemVolume[0]++;
      else if (q <= 3) contagemVolume[1]++;
      else if (q <= 10) contagemVolume[2]++;
      else contagemVolume[3]++;
    }
    linha("");
    linha("  Unidades vendidas na janela de 3 meses:");
    tabela(baldesVolume, contagemVolume, emRotura.length);

    // ── Recorrência: meses distintos com venda ────────────────────────
    //
    // `VendaMensal` é mensal. "Dias distintos com venda" NÃO é
    // calculável sem ir às linhas de venda; o mais fino aqui é o número
    // de MESES com quantidade > 0. Dizê-lo é melhor do que fingir uma
    // precisão que os dados não têm.
    const janela12 = janelaOperacionalPorOmissao();
    const idx12 = janelaParaIndicesMensais(janela12);
    const ocorrencias = await prisma.$queryRaw<
      Array<{ produtoId: string; farmaciaId: string; meses: bigint }>
    >(Prisma.sql`
      SELECT vm."produtoId", vm."farmaciaId", COUNT(*)::bigint AS meses
      FROM "VendaMensal" vm
      WHERE vm."farmaciaId" = ANY(${farmaciaIds})
        AND vm.quantidade > 0
        AND (vm.ano * 12 + vm.mes) >= ${idx12.inicioIndice}
        AND (vm.ano * 12 + vm.mes) < ${idx12.fimExclusivo}
      GROUP BY 1, 2
    `);
    const mesesPorChave = new Map(
      ocorrencias.map((o) => [`${o.produtoId}:${o.farmaciaId}`, Number(o.meses)]),
    );
    const baldesOcorr = ["1 mês só", "2–3 meses", "4–6 meses", "> 6 meses", "nenhum"];
    const contagemOcorr = [0, 0, 0, 0, 0];
    for (const r of emRotura) {
      const m = mesesPorChave.get(`${r.produtoId}:${r.farmaciaId}`) ?? 0;
      if (m === 0) contagemOcorr[4]++;
      else if (m === 1) contagemOcorr[0]++;
      else if (m <= 3) contagemOcorr[1]++;
      else if (m <= 6) contagemOcorr[2]++;
      else contagemOcorr[3]++;
    }
    linha("");
    linha(`  Meses distintos com venda (${janela12.inicio} a ${janela12.fim}):`);
    tabela(baldesOcorr, contagemOcorr, emRotura.length);

    // ── Recorte exploratório ──────────────────────────────────────────
    let critico = 0;
    let pontual = 0;
    let semProcura = 0;
    for (const r of emRotura) {
      const d = diasDesde(r.dataUltimaVenda) ?? 999;
      const m = mesesPorChave.get(`${r.produtoId}:${r.farmaciaId}`) ?? 0;
      if (d <= 30 && m >= 2) critico++;
      else if (d <= 90 && m >= 1) pontual++;
      else semProcura++;
    }
    linha("");
    linha("  Recorte exploratório (NÃO implementado em lado nenhum):");
    tabela(
      [
        "A · <=30d e >=2 meses com venda",
        "B · <=90d, procura esporádica  ",
        "C · sem procura recente        ",
      ],
      [critico, pontual, semProcura],
      emRotura.length,
    );

    // ══════════════════════════════════════════════════════════════════
    // REGRA FINAL DE ROTURA · os dois ramos, medidos em separado
    //
    // Usa `classificarRotura` — o MESMO classificador que a aplicação
    // passou a usar, não uma reprodução. Se a regra mudar lá, muda aqui.
    // ══════════════════════════════════════════════════════════════════
    linha("");
    linha("  ─── REGRA FINAL (a que está implementada) ───");
    confirmarRegra(
      "lib/operational/rotura.ts",
      "if (dias <= ROTURA_RECENCIA_DIAS && (temRecorrencia(linha) || temVolume(linha)))",
      "crítica = recência E (recorrência OU volume)",
    );
    linha(
      `  parâmetros (policy de ${policy.slug ?? "default"}): <= ${policy.rotura.recenciaDias}d · >= ${policy.rotura.mesesMinimos} meses em 12M · >= ${policy.rotura.unidadesMinimas} un em 3M`,
    );
    linha(
      `  modo no Dashboard: ${policy.rotura.modo}` +
        (policy.rotura.modo === "classica"
          ? "  — os números abaixo são exploratórios, o cartão ainda é o único"
          : ""),
    );

    const agoraMs = Date.now();
    let nCritica = 0;
    let nOcasional = 0;
    let nSemProcura = 0;
    // Os dois ramos, contados independentemente DENTRO das críticas.
    let soRecorrencia = 0;
    let soVolume = 0;
    let ambos = 0;

    for (const r of emRotura) {
      const alvoRotura = {
        stockAtual: r.stockAtual,
        dataUltimaVenda: r.dataUltimaVenda,
        salesQty90d: r.salesQty90d,
        mesesComVenda12M: mesesPorChave.get(`${r.produtoId}:${r.farmaciaId}`) ?? 0,
      };
      const nivel = classificarRotura(alvoRotura, policy.rotura, agoraMs);
      if (nivel === "CRITICA") {
        nCritica++;
        const rec = temRecorrencia(alvoRotura, policy.rotura);
        const vol = temVolume(alvoRotura, policy.rotura);
        if (rec && vol) ambos++;
        else if (rec) soRecorrencia++;
        else soVolume++;
      } else if (nivel === "OCASIONAL") nOcasional++;
      else nSemProcura++;
    }

    linha("");
    tabela(
      [
        "Roturas críticas               ",
        "Sem stock · procura ocasional  ",
        "Sem stock · sem procura recente",
      ],
      [nCritica, nOcasional, nSemProcura],
      emRotura.length,
    );
    linha("");
    linha("  Dentro das críticas, de onde vêm:");
    tabela(
      [
        "só pelo ramo da recorrência (>=2 meses)",
        "só pelo ramo do volume (>=4 unidades)  ",
        "pelos dois ao mesmo tempo              ",
      ],
      [soRecorrencia, soVolume, ambos],
      nCritica || 1,
    );
    linha("");
    linha(`  O ramo do volume acrescenta ${nf(soVolume)} linhas que a recorrência sozinha`);
    linha("  perderia — são os artigos novos, com procura a arrancar e sem histórico.");
    linha("");
    linha(`  Antes (regra única): ${nf(emRotura.length)} linhas num só cartão.`);
    linha(`  Depois: ${nf(nCritica)} no cartão de alerta, ${nf(nOcasional + nSemProcura)} nos secundários.`);

    // ══════════════════════════════════════════════════════════════════
    // PARTE 2 · FUNIL DAS TRANSFERÊNCIAS
    //
    // A aritmética é a REAL: `avaliarLinha`, `emparelhar`, `ehAccionavel`
    // e `ehDestinoElegivel` vêm de `motor-stock`, o mesmo módulo que
    // `getTransferenciasData` usa. Só o carregamento é reproduzido.
    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 2 · Funil das transferências");

    confirmarRegra(
      "lib/transferencias-data.ts",
      "excessoMinimo: policy.excesso.minimoUnidades,",
      "o corte mínimo vem da policy da farmácia",
    );
    confirmarRegra(
      "lib/transferencias-data.ts",
      "reservaDias: reservaOrigemDias(",
      "a reserva da origem é derivada do alvo efectivo",
    );
    confirmarRegra(
      "lib/transferencias-data.ts",
      "if (!ehAccionavel(par)) continue;",
      "filtro final: excesso > 0 E necessidade > 0 E sugestão > 0",
    );
    confirmarRegra(
      "lib/transferencias-data.ts",
      "result.slice(0, 200)",
      "corte final a 200 linhas",
    );

    const janela = janelaOperacionalPorOmissao();
    const params: ParametrosMotor = {
      diasJanela: diasDaJanela(janela),
      thresholdDays: policy.excesso.thresholdDias,
      targetDays: policy.excesso.targetDias,
      excessoMinimo: policy.excesso.minimoUnidades,
      reservaDias: reservaOrigemDias(policy),
    };
    linha("");
    linha(`  janela ................ ${janela.inicio} a ${janela.fim} (${params.diasJanela} dias)`);
    linha(`  threshold de excesso .. cobertura > ${params.thresholdDays} dias`);
    linha(`  cobertura-alvo ........ ${params.targetDays} dias`);
    linha(`  excesso mínimo ........ ${params.excessoMinimo} unidades`);
    linha(`  reserva na origem ..... ${params.reservaDias} dias (derivada do alvo)`);

    const idxJanela = janelaParaIndicesMensais(janela);
    const vendasJanelaMap = await somarVendas(
      prisma,
      farmaciaIds,
      idxJanela.inicioIndice,
      idxJanela.fimExclusivo,
    );
    // Os Excessos usam o default de `loadPfAndSales`: só stock > 0.
    const pfComStock = await carregarProdutoFarmacia(prisma, farmaciaIds, false);

    type LinhaMotor = LinhaStock & { produtoId: string };
    const grupos = new Map<string, EstadoStock<LinhaMotor>[]>();
    for (const row of pfComStock) {
      const estado = avaliarLinha<LinhaMotor>(
        {
          produtoId: row.produtoId,
          farmaciaId: row.farmaciaId,
          farmaciaNome: row.farmaciaNome,
          stockAtual: Number(row.stockAtual),
          vendasJanela: vendasJanelaMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0,
        },
        params,
      );
      const lista = grupos.get(row.produtoId);
      if (lista) lista.push(estado);
      else grupos.set(row.produtoId, [estado]);
    }

    const todos = Array.from(grupos.values()).flat();
    const semConsumo = todos.filter((e) => e.avgDaily <= 0).length;
    const semCobertura = todos.filter((e) => e.coberturaDias === null).length;
    const acimaThreshold = todos.filter(
      (e) => e.coberturaDias !== null && e.coberturaDias > params.thresholdDays,
    ).length;
    const comExcesso = todos.filter((e) => e.excesso > 0).length;
    const comNecessidade = todos.filter((e) => e.necessidade > 0).length;
    const destinosElegiveis = todos.filter(ehDestinoElegivel).length;

    linha("");
    linha("  ETAPA                                              LINHAS   (queda)");
    linha(`  1. produto × farmácia (stock > 0) .............. ${String(nf(pfComStock.length)).padStart(8)}`);
    linha(`     · CNP distintos ........................... ${String(nf(grupos.size)).padStart(8)}`);
    linha(`  2. sem consumo mensurável (avgDaily = 0) ....... ${String(nf(semConsumo)).padStart(8)}`);
    linha(`     · logo, sem cobertura definida ............ ${String(nf(semCobertura)).padStart(8)}`);
    linha(`  3. cobertura > ${params.thresholdDays}d .......................... ${String(nf(acimaThreshold)).padStart(8)}`);
    linha(`  4. …e excesso >= ${params.excessoMinimo} un.  ⇒ COM EXCESSO ....... ${String(nf(comExcesso)).padStart(8)}   (−${nf(acimaThreshold - comExcesso)})`);
    linha(`  5. linhas com necessidade > 0 .................. ${String(nf(comNecessidade)).padStart(8)}`);
    linha(`  6. destinos elegíveis (consumo E necessidade) .. ${String(nf(destinosElegiveis)).padStart(8)}`);

    let cnpComExcesso = 0;
    let cnpComAmbos = 0;
    let gruposUmaFarmacia = 0;
    let paresCandidatos = 0;
    let semDestino = 0;
    let cortadosPorStockOrigem = 0;
    let accionaveis = 0;

    for (const grupo of grupos.values()) {
      const origens = grupo.filter((e) => e.excesso > 0);
      if (origens.length > 0) cnpComExcesso++;
      if (grupo.length < 2) {
        if (origens.length > 0) gruposUmaFarmacia++;
        continue;
      }
      if (origens.length > 0 && grupo.some(ehDestinoElegivel)) cnpComAmbos++;

      for (const origem of origens) {
        const candidatos = grupo.filter(
          (c) => c.farmaciaId !== origem.farmaciaId && ehDestinoElegivel(c),
        );
        paresCandidatos += candidatos.length;
        const par = emparelhar(origem, grupo);
        if (!par.destino) {
          if (candidatos.length === 0) semDestino++;
          else cortadosPorStockOrigem++;
          continue;
        }
        if (ehAccionavel(par)) accionaveis++;
      }
    }

    linha("");
    linha(`  7. CNP com pelo menos uma origem em excesso .... ${String(nf(cnpComExcesso)).padStart(8)}`);
    linha(`     · desses, só existem numa farmácia ........ ${String(nf(gruposUmaFarmacia)).padStart(8)}`);
    linha(`  8. CNP com excesso numa E necessidade noutra ... ${String(nf(cnpComAmbos)).padStart(8)}`);
    linha(`  9. pares origem→destino candidatos ............ ${String(nf(paresCandidatos)).padStart(8)}`);
    linha(` 10. origens sem nenhum destino elegível ........ ${String(nf(semDestino)).padStart(8)}`);
    linha(` 11. cortadas pelo stock da origem (sugestão 0) . ${String(nf(cortadosPorStockOrigem)).padStart(8)}`);
    linha(` 12. ⇒ LINHAS NO RELATÓRIO ..................... ${String(nf(accionaveis)).padStart(8)}`);
    linha("");
    linha(
      `  O relatório aplica ainda .slice(0, 200): neste tenant ${accionaveis > 200 ? "CORTA" : "não corta"} nada.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
