/**
 * scripts/catalog-master/knowledge-enrich.ts
 *
 * Fase 3 do catálogo: knowledge-enrichment sobre o residual que as regras
 * determinísticas deixaram.
 *
 * Corre-o DEPOIS de classify-backfill e fill-rules, nunca antes. Se as
 * regras ainda não correram, este script paga o modelo para resolver
 * coisas que uma keyword resolvia de graça.
 *
 * A base é SEMPRE explícita — resolvida por `lib/catalog/target-db.ts`,
 * que recusa omissões e recusa hosts que não sejam produção. Não há
 * `--db` por omissão neste ficheiro, de propósito: um nome por omissão é
 * uma decisão tomada há meses por outra pessoa noutro contexto.
 *
 * Custa dinheiro real. Por isso:
 *   · dry-run é o default — sem `--apply` não escreve nada, nem cache;
 *   · `--canary` faz uma amostra ESTRATIFICADA (40/30/30) em vez dos
 *     primeiros N, que seriam só os cnp mais baixos;
 *   · `--tecto-usd` corta por custo estimado, que é a unidade em que a
 *     fatura vem.
 *
 * ── O CANARY MEDE, E NUNCA ESCREVE ───────────────────────────────────
 *
 * `--canary` é incompatível com `--apply`: pedir os dois é recusado, não
 * ignorado. E atravessa as exclusões por poupança da pré-selecção
 * (designação opaca, subcategoria de baixa cobertura), porque um canary
 * que as respeita pode não medir nada — foi o que aconteceu na Silveira,
 * com 1 193 produtos no estrato SEM_UTILIZACOES e ZERO enviados ao
 * modelo. Uma amostra de zero não é uma amostra barata.
 *
 * A corrida NORMAL (sem `--canary`) não muda: continua a poupar esses
 * produtos, que é a razão de a pré-selecção existir.
 *
 * Uso:
 *   # canary estratificado de 100, dry-run obrigatório
 *   npx tsx scripts/catalog-master/knowledge-enrich.ts --tenant=silveira --canary
 *
 *   # bootstrap por lotes, com tecto de custo
 *   npx tsx scripts/catalog-master/knowledge-enrich.ts --tenant=silveira --limite=2000 --tecto-usd=15 --apply
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { SAIDA, codigoDeSaida } from "../../lib/catalog/knowledge-enrich-saida";
import {
  CAMPOS_ESCRITOS,
  CAMPOS_PROIBIDOS,
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_PERSISTENCIA,
  LIMIAR_CLINICO,
  MAX_RETENTATIVAS,
  TIMEOUT_MS,
} from "../../lib/catalog/knowledge-enrichment";
import {
  QUOTAS_CANARY,
  runKnowledgeEnrichment,
  type LinhaRelatorio,
  type QuotaEstrato,
} from "../../lib/catalog/knowledge-enrichment-runner";

function corta(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`;
}

function imprimirRelatorio(linhas: LinhaRelatorio[]): void {
  const ordem: Record<string, number> = { APPLY: 0, REVIEW: 1, SKIP: 2 };
  const ordenadas = [...linhas].sort(
    (a, b) => ordem[a.decisao] - ordem[b.decisao] || a.estrato.localeCompare(b.estrato),
  );

  console.log("\n── relatório por produto ──────────────────────────────────────────────");
  let estratoActual = "";
  for (const l of ordenadas) {
    const cabeca = `${l.decisao}/${l.estrato}`;
    if (cabeca !== estratoActual) {
      console.log(`\n  ▸ ${l.decisao} · ${l.estrato}`);
      estratoActual = cabeca;
    }
    console.log(`    cnp ${String(l.cnp).padStart(7)}  ${corta(l.designacao, 46)}`);
    console.log(`      actual   : ${l.estadoAtual}   [pedido: ${l.alvo}]`);
    console.log(`      proposta : ${l.proposta}   [${l.evidenceType} conf=${l.confidence.toFixed(2)}${l.verificado ? " ✓verificado" : ""}]`);
    if (l.anomalia) console.log(`      ⚠ anomalia: ${l.anomalia}`);
    if (l.utilizacoes.length) console.log(`      utiliz.  : ${l.utilizacoes.join(", ")}`);
    console.log(`      razão    : ${l.motivo}`);
    if (l.criterios && l.decisao !== "APPLY") {
      const falhados = Object.entries(l.criterios)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (falhados.length) console.log(`      critérios falhados: ${falhados.join(", ")}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const canary = argv.includes("--canary");

  // O CANARY NUNCA ESCREVE.
  //
  // Recusar em vez de ignorar em silêncio: quem escreveu `--canary
  // --apply` queria escrever, e uma corrida que ignora metade da linha
  // de comando e diz "ok" é pior do que uma que se recusa a correr.
  // Para escrever, corre-se o backlog com --limite, que é outra decisão.
  if (canary && apply) {
    console.error(
      "\n--canary e --apply são incompatíveis: o canary é uma MEDIÇÃO e nunca escreve.\n" +
        "\n  · medir uma amostra estratificada:  --canary" +
        "\n  · escrever a sério:                 --limite=<n> --apply\n",
    );
    process.exit(2);
  }
  const semRelatorio = argv.includes("--sem-relatorio");
  const limite = Number(argv.find((a) => a.startsWith("--limite="))?.split("=")[1] ?? 100);
  const tectoUsd = Number(argv.find((a) => a.startsWith("--tecto-usd="))?.split("=")[1] ?? 5);

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      "Sem credencial da API. Exporta ANTHROPIC_API_KEY, ou corre `ant auth login`\n" +
        'e reexporta com: set -a; eval "$(ant auth print-credentials --env)"; set +a',
    );
    process.exit(1);
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (e) {
    if (e instanceof AlvoRecusado) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  // Sem `--apply` a sessão fica read-only na própria base. O runner já
  // não escreve em dry-run; isto é a segunda tranca, do lado do Postgres,
  // para o caso de um dia alguém acrescentar uma escrita no sítio errado.
  await prisma.$executeRawUnsafe(
    `set session default_transaction_read_only = ${apply ? "off" : "on"}`,
  );

  console.log(
    `${descreverAlvo(alvo)}${apply ? "" : "   (dry-run — sessão read-only; não escreve Produto, ProdutoUtilizacao nem cache)"}`,
  );
  console.log(`regras: ${KNOWLEDGE_VERSION} · modelo ${KNOWLEDGE_MODEL} · limiar ${LIMIAR_PERSISTENCIA}`);
  console.log(`rede: timeout ${TIMEOUT_MS / 1000}s · até ${MAX_RETENTATIVAS} retentativas (só 429/5xx/timeout)`);
  console.log(`escreve: ${CAMPOS_ESCRITOS.join(", ")}`);
  console.log(`nunca escreve: ${CAMPOS_PROIBIDOS.join(", ")}`);
  console.log(
    canary
      ? `amostra: canary estratificado ${Object.entries(QUOTAS_CANARY).map(([k, v]) => `${v} ${k}`).join(" + ")}` +
        "\n         (dry-run obrigatório; atravessa as exclusões por poupança para a amostra ser efectiva)"
      : `amostra: ${limite} produtos (ordem de cnp)`,
  );
  console.log(`tecto: $${tectoUsd}\n`);

  const r = await runKnowledgeEnrichment(prisma, {
    limite,
    dryRun: !apply,
    tectoUsd,
    canary: canary ? QUOTAS_CANARY : undefined,
    // SÓ com --canary. Atravessa as exclusões por poupança da
    // pré-selecção para a amostra medir mesmo o estrato — ver
    // `forcarExcluidos` no runner. A corrida normal não passa por aqui.
    forcarExcluidos: canary,
    // SEM ISTO O BACKLOG NAO PROMOVIA NADA. O runner exige `tenantSlug`
    // para registar a origem do conhecimento; sem ele limita-se a avisar
    // "N candidatos nao promovidos: falta tenantSlug" e a promocao nao
    // acontece. Era este o caminho da corrida de backlog — 1 548
    // produtos classificados que so chegaram ao catalogo global porque
    // alguem correu, a mao, o `catalog:bootstrap-global` a seguir.
    //
    // Pode nao existir: este comando aceita `--db=<base>` alem de
    // `--tenant=<slug>`. Sem tenant o comportamento e o de antes — avisa
    // e nao promove, porque nao ha origem para registar.
    tenantSlug: alvo.tenant ?? undefined,
    onProgress: (feito, total) => process.stdout.write(`\r  ${feito}/${total}`),
  });

  if (!semRelatorio) imprimirRelatorio(r.relatorio);

  const pad = (n: number) => String(n).padStart(6);
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
  // A reconciliação não é decorativa: se não fechar, o comando sai com
  // código 2. Um relatório que denuncia um defeito e devolve 0 é lido
  // pelo scheduler como sucesso, e foi assim que os 4 e os 2 produtos
  // sem destino passaram duas corridas sem ninguém parar.
  let falhaContabilistica = false;
  // Saldo, credencial, 429/5xx persistente, rede. Distinta da
  // contabilística: esta não é defeito do código, é o mundo lá fora.
  let falhaInfra = false;

  console.log("\n\n── amostra ────────────────────────────────────────");
  console.log(`  ${pad(r.residualAnalisado)}  produtos entraram`);
  for (const [k, v] of Object.entries(r.porEstrato)) console.log(`  ${pad(v)}  ${k}`);

  if (r.quotasCanary) {
    // QUATRO COLUNAS, E CADA UMA RESPONDE A UMA PERGUNTA.
    //
    // A versão antiga tinha uma coluna "elegíveis" a significar duas
    // coisas e um TOTAL que punha `residualAnalisado` debaixo dela: na
    // Silveira lia-se «TOTAL 1200» ao lado de `obtido=0`, que qualquer
    // pessoa lê como «havia 1200 e mandámos 0 por opção». O que se
    // passava era outra coisa — havia 1200 no residual, a pré-selecção
    // recusava-os todos, e o canary não mediu nada.
    console.log("\n── quotas por estrato ─────────────────────────────");
    console.log("  estrato                 pedido  universo  elegíveis  selec.  enviados  forçados  défice");
    for (const q of r.quotasCanary) {
      const marca = q.defice > 0 ? "  ⚠" : "";
      console.log(
        `  ${q.estrato.padEnd(22)}${String(q.pedido).padStart(6)}` +
          `${String(q.universo).padStart(10)}${String(q.elegiveis).padStart(11)}` +
          `${String(q.seleccionados).padStart(8)}${String(q.enviados).padStart(10)}` +
          `${String(q.forcados).padStart(10)}${String(q.defice).padStart(8)}${marca}`,
      );
    }
    const somaQ = (f: (q: QuotaEstrato) => number) =>
      (r.quotasCanary ?? []).reduce((acc, q) => acc + f(q), 0);
    console.log(
      `  ${"TOTAL".padEnd(22)}${String(somaQ((q) => q.pedido)).padStart(6)}` +
        `${String(somaQ((q) => q.universo)).padStart(10)}${String(somaQ((q) => q.elegiveis)).padStart(11)}` +
        `${String(somaQ((q) => q.seleccionados)).padStart(8)}${String(somaQ((q) => q.enviados)).padStart(10)}` +
        `${String(somaQ((q) => q.forcados)).padStart(10)}${String(somaQ((q) => q.defice)).padStart(8)}`,
    );
    console.log(
      "\n  universo  = existem no estrato        elegíveis = passariam a pré-selecção" +
        "\n  selec.    = entraram na janela        enviados  = foram MESMO ao modelo",
    );
    const totalForcados = somaQ((q) => q.forcados);
    if (totalForcados > 0) {
      console.log(
        `\n  ⓘ ${totalForcados} produto(s) foram enviados por FORÇA do canary — a pré-selecção` +
          "\n    tê-los-ia adiado (designação opaca ou subcategoria de baixa cobertura)." +
          "\n    É deliberado: um canary que respeita as poupanças pode não medir nada." +
          "\n    Numa corrida normal (sem --canary) estes produtos continuam a ser poupados.",
      );
    }

    // Um estrato a zero não é um detalhe do relatório: significa que o
    // canary não testou aquela fatia do residual, e as taxas que sairem
    // daqui não se podem extrapolar para ela.
    const vazios = r.quotasCanary.filter((q) => q.universo === 0);
    if (vazios.length > 0) {
      console.log(
        `\n  ⚠ SEM ELEGÍVEIS: ${vazios.map((q) => q.estrato).join(", ")}.` +
          "\n    O canary não cobriu este(s) estrato(s) — as taxas abaixo não se aplicam lá." +
          "\n    Se era esperado terem produtos, confirmar que a fase determinística" +
          "\n    (classify-backfill → fill-rules) já correu nesta base.",
      );
    }
    const curtos = r.quotasCanary.filter((q) => q.defice > 0 && q.universo > 0);
    if (curtos.length > 0) {
      console.log(
        `\n  ⚠ QUOTA INCOMPLETA: ${curtos
          .map((q) => `${q.estrato} ${q.enviados}/${q.pedido} (universo ${q.universo})`)
          .join(", ")}`,
      );
    }
  }

  console.log("\n── métricas do canary ─────────────────────────────");
  console.log(`  propostas válidas      ${pad(r.propostasValidas)}  ${pct(r.propostasValidas, r.residualAnalisado)} do que entrou`);
  console.log(`  exigiram verificação   ${pad(r.verificacoesAplicaveis)}  ${pct(r.verificacoesAplicaveis, r.propostasValidas)} das propostas`);
  console.log(`  acordo proposta/verif. ${pad(r.verificacoesConcordantes)}  ${pct(r.verificacoesConcordantes, r.verificacoesAplicaveis)} das verificadas`);
  console.log(`  auto-apply             ${pad(r.apply)}  ${pct(r.apply, r.residualAnalisado)} do que entrou`);
  console.log(`  para revisão           ${pad(r.review)}  ${pct(r.review, r.residualAnalisado)}`);
  console.log(`  skip (já resolvido)    ${pad(r.skip)}  ${pct(r.skip, r.residualAnalisado)}`);

  console.log("\n── discordâncias (candidatos a falso positivo) ────");
  const discordantes = r.relatorio.filter((l) => l.discordancia);
  if (discordantes.length === 0) {
    console.log("  nenhuma — as duas passagens concordaram em tudo o que exigiu verificação");
  } else {
    for (const d of discordantes.slice(0, 25)) {
      console.log(`  cnp ${d.cnp}  ${corta(d.designacao, 40)}`);
      console.log(`     ${d.motivo}`);
    }
    if (discordantes.length > 25) console.log(`  … e mais ${discordantes.length - 25}`);
  }

  console.log("\n── escrita ────────────────────────────────────────");
  if (apply) {
    console.log(`  ${pad(r.categoriasEscritas)}  categorias`);
    console.log(`  ${pad(r.productTypesEscritos)}  productType (só onde faltava)`);
    console.log(`  ${pad(r.utilizacoesEscritas)}  utilizações`);
    console.log("");
    console.log("  campos clínicos (ke-2.0, só onde estava NULL):");
    console.log(`  ${pad(r.dciEscritas)}  DCI`);
    console.log(`  ${pad(r.atcEscritos)}  código ATC`);
    console.log(`  ${pad(r.formasEscritas)}  forma farmacêutica`);
    console.log(`  ${pad(r.dosagensEscritas)}  dosagem`);
    console.log(`  ${pad(r.embalagensEscritas)}  embalagem`);
  } else {
    console.log("  dry-run — nada foi escrito.");
  }

  // Vale sempre, com ou sem --apply: mede quanta clínica o modelo
  // devolveu e quanta é que o gate recusou. Em dry-run é a única
  // maneira de saber se o limiar está bem posto antes de gastar.
  console.log("");
  console.log("── gate clínico ───────────────────────────────────");
  console.log(`  ${pad(r.clinicaRecusadaPorConfianca)}  resultados com clínica recusada (confidenceClinica < ${LIMIAR_CLINICO})`);

  console.log("\n── evidência ──────────────────────────────────────");
  for (const [k, v] of Object.entries(r.porEvidencia).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  if (r.anomalias > 0) {
    console.log("\n── anomalias (candidatos a auditoria, NUNCA escritas) ──");
    console.log("  Produtos já classificados que o modelo põe noutra categoria de nível 1.");
    for (const l of r.relatorio.filter((x) => x.anomalia).slice(0, 25)) {
      console.log(`  cnp ${String(l.cnp).padStart(7)}  ${corta(l.designacao, 40)}`);
      console.log(`     ${l.anomalia}`);
    }
    const n = r.relatorio.filter((x) => x.anomalia).length;
    if (n > 25) console.log(`  … e mais ${n - 25}`);
  }

  console.log("\n── a janela ───────────────────────────────────────");
  // `--limite=N` significa N produtos DESTINADOS ao modelo. A leitura
  // pagina por cursor e atravessa os condicionais em vez de lhes dar
  // lugar — sem isto, 11,8% do residual do silveira ocupava a cabeça da
  // janela para sempre e o lote acabava por não fazer trabalho nenhum.
  console.log(`  ${pad(r.janela.alvoProcessaveis)}  processáveis pedidos (--limite)`);
  console.log(`  ${pad(r.residualLido)}  cnp lidos do residual em ${r.janela.paginasLidas} página(s) de ${r.janela.tamanhoPagina}`);
  console.log(`  ${pad(r.residualAnalisado)}  entraram na janela`);
  console.log(`  ${pad(r.foraDaJanela)}  lidos e devolvidos (ainda não chegou a vez)`);
  if (r.janela.esgotado) console.log("  o residual esgotou-se antes de a janela encher.");

  console.log("\n── pré-selecção (o que NÃO foi ao modelo) ─────────");
  // A PRIMEIRA LINHA, e não estava aqui. O `jaConhecidosGlobal` existia
  // no resumo e nunca era impresso: os produtos dispensados pelo catálogo
  // global desapareciam para dentro de "chamadas poupadas", sem causa
  // visível. Num canary em que TODOS foram dispensados, o relatório dizia
  // "0 famílias, 0 exclusões, 25 chamadas poupadas 100%" — cada linha
  // verdadeira, e o conjunto ilegível.
  console.log(`  ${pad(r.jaConhecidosGlobal)}  já conhecidos no catálogo global (resolvem o que faltava)`);
  console.log(`  ${pad(r.globalInsuficiente)}  conhecidos no global mas INSUFICIENTES — vão ao modelo`);
  console.log(`  ${pad(r.excluidosBaixaCobertura)}  CONDICIONAIS: subcategoria sem utilização plausível (<2%, pop>=30)`);
  console.log(`  ${pad(r.excluidosOpacos)}  CONDICIONAIS: designação opaca`);
  console.log(`  ${pad(r.familiasPropagaveis)}  famílias propagáveis (1 representante + N dependentes)`);
  console.log(`  ${pad(r.representantesEnviados)}  representantes enviados`);
  console.log(`  ${pad(r.propagados)}  propagados do representante (decisão aceite OU recusada)`);
  console.log(`  ${pad(r.propagadosSemEscrita)}    …destes, herdaram uma decisão que NÃO escreve`);
  console.log(`  ${pad(r.dependentesOrfaos)}  dependentes sem decisão do representante — voltam ao residual`);
  console.log(`  ${pad(r.semContexto)}  sem linha no contexto do tenant — NÃO tratados`);
  console.log(`  ${pad(r.conflitosFamilia)}  famílias em conflito (não propagam, vão sozinhas)`);
  console.log(`  ${pad(r.enviadosAoModelo)}  ENVIADOS AO MODELO  (de ${r.residualAnalisado} na janela)`);
  if (r.residualLido > 0) {
    const poupadas = r.residualAnalisado - r.enviadosAoModelo;
    console.log(`  ${pad(poupadas)}  chamadas poupadas na janela  ${pct(poupadas, r.residualAnalisado)}`);

    // ── RECONCILIAÇÃO ────────────────────────────────────────────────
    //
    // Tudo o que foi LIDO tem de ter destino NOMEADO — e os destinos são
    // mutuamente exclusivos. Sem esta soma, um caminho de exclusão novo
    // — ou um que passe a apanhar mais do que devia — soma-se em
    // silêncio a "chamadas poupadas" e ninguém repara. Foi o que
    // aconteceu com o filtro do catálogo global (7 692 produtos), com os
    // dependentes de representantes recusados (4 e depois 2), e com os
    // dependentes recusados pelo gate próprio.
    //
    // Fecha sobre `residualLido` e não sobre a janela: a paginação lê
    // mais do que trata, e o excedente ("ainda não chegou a vez") é um
    // destino tão nomeado como os outros.
    const contabilizados =
      r.jaConhecidosGlobal +
      r.excluidosBaixaCobertura +
      r.excluidosOpacos +
      r.enviadosAoModelo +
      r.propagados +
      r.dependentesOrfaos +
      r.semContexto +
      r.foraDaJanela;
    const semDestino = r.residualLido - contabilizados;
    console.log("");
    console.log(
      `  reconciliação: ${r.residualLido} lidos = ${r.jaConhecidosGlobal} global` +
        ` + ${r.excluidosBaixaCobertura} baixa-cobertura + ${r.excluidosOpacos} opacos` +
        ` + ${r.enviadosAoModelo} enviados + ${r.propagados} propagados` +
        ` + ${r.dependentesOrfaos} orfaos + ${r.semContexto} sem-contexto` +
        ` + ${r.foraDaJanela} fora-da-janela`,
    );
    if (semDestino !== 0) {
      console.log(`  !! ${semDestino} produto(s) SEM destino contabilizado — é um defeito, não um arredondamento.`);
      falhaContabilistica = true;
    } else {
      console.log("  ok  fecha: tudo o que foi lido tem destino nomeado.");
    }
  }

  if (r.metricasPorEstrato.length > 0) {
    console.log("  estrato               universo  <2%  opac  repr  envi  prop");
    for (const m of r.metricasPorEstrato) {
      console.log(
        `  ${m.estrato.padEnd(21)}${String(m.universoInicial).padStart(8)}` +
          `${String(m.excluidosBaixaCobertura).padStart(5)}${String(m.excluidosOpacos).padStart(6)}` +
          `${String(m.representantesEnviados).padStart(6)}${String(m.enviadosAoModelo).padStart(6)}` +
          `${String(m.propagados).padStart(6)}`,
      );
    }
    console.log("\n  estrato               alvo            prod  APL  REV  SKP   chamadas    out tok    custo   $/prod");
    for (const m of r.metricasPorEstrato) {
      console.log(
        `  ${m.estrato.padEnd(21)} ${m.alvo.padEnd(14)} ` +
          `${String(m.produtos).padStart(4)} ${String(m.apply).padStart(4)} ` +
          `${String(m.review).padStart(4)} ${String(m.skip).padStart(4)}   ` +
          `${String(`${m.chamadasProposta}+${m.chamadasVerificacao}`).padStart(8)} ` +
          `${String(m.usage.outputTokens).padStart(10)} ` +
          `$${m.custoUsd.toFixed(4).padStart(8)} $${m.custoPorProduto.toFixed(4)}`,
      );
    }

    console.log("\n── projecção por estrato (custo observado × população) ──");
    let totalProj = 0;
    let temTudo = true;
    for (const m of r.metricasPorEstrato) {
      if (m.projecaoUsd === null) {
        temTudo = false;
        console.log(`  ${m.estrato.padEnd(21)} sem projecção (população desconhecida ou estrato não corrido)`);
        continue;
      }
      totalProj += m.projecaoUsd;
      console.log(
        `  ${m.estrato.padEnd(21)} ${String(m.elegiveis).padStart(6)} elegíveis × ` +
          `$${m.custoPorProduto.toFixed(4)} = $${m.projecaoUsd.toFixed(2)}`,
      );
    }
    console.log(`  ${"TOTAL".padEnd(21)} $${totalProj.toFixed(2)}${temTudo ? "" : "   (parcial — ver linhas acima)"}`);
    console.log("  Projecção com o custo POR ESTRATO desta corrida, não com a média global:");
    console.log("  os três estratos não custam o mesmo por produto.");
  }

  // ── AVISOS E FALHA DE INFRAESTRUTURA ───────────────────────
  //
  // O relatório nunca imprimia nem `avisos` nem `falhaInfraestrutura`.
  // Uma corrida que parasse por saldo esgotado, credencial inválida ou
  // 429 persistente saía com código 0 e um relatório curto —
  // indistinguível de "já não havia trabalho". Num encadeamento
  // automático de lotes isso é o pior caso: o lote seguinte arranca,
  // falha da mesma maneira, e a série inteira passa em branco sem
  // ninguém ver.
  if (r.avisos.length > 0) {
    console.log("\n── avisos ─────────────────────────────────────");
    for (const a of r.avisos) console.log(`  • ${a}`);
  }
  if (r.falhaInfraestrutura) {
    console.log("\n── FALHA DE INFRAESTRUTURA ─────────────────────");
    console.log(`  categoria: ${r.falhaInfraestrutura.categoria}`);
    console.log(`  ${r.falhaInfraestrutura.mensagem}`);
    console.log("  A fila NÃO foi tocada: nenhum produto gastou tentativa.");
    falhaInfra = true;
  }

  console.log("\n── custo ──────────────────────────────────────────");
  console.log(`  chamadas: ${r.chamadasProposta} proposta + ${r.chamadasVerificacao} verificação`);
  console.log(`  tokens: in ${r.usage.inputTokens} · out ${r.usage.outputTokens}`);
  console.log(`  cache: read ${r.usage.cacheReadTokens} · write ${r.usage.cacheWriteTokens}`);
  console.log(`  estimado: $${r.custoEstimadoUsd.toFixed(4)}`);
  if (r.cortadoPorTecto) {
    console.log(`  ⚠ corrida CORTADA ao atingir o tecto de $${tectoUsd} — o residual não foi todo visto.`);
  }
  if (r.residualAnalisado > 0) {
    const por100 = (r.custoEstimadoUsd / r.residualAnalisado) * 100;
    console.log(`  por 100 produtos: $${por100.toFixed(2)}  (média sobre os estratos que correram)`);
    console.log("  A extrapolação que vale é a da secção 'projecção por estrato' acima:");
    console.log("  esta média só se aplica a uma população com a mesma mistura de estratos.");
  }

  // ── MÉTRICA DE BACKLOG ─────────────────────────────────
  //
  // "residual = 0" NÃO é o critério de conclusão e nunca poderia ser. As
  // exclusões condicionais — subcategoria sem cobertura, designação
  // opaca — não recebem estado terminal DE PROPÓSITO: dependem dos dados
  // do tenant e têm de poder voltar quando os dados mudarem. Ficam no
  // residual para sempre enquanto a condição se mantiver, e está certo.
  //
  // O que tem de chegar a zero é outra coisa.
  console.log("\n── backlog ─────────────────────────────────────");
  const condicionais = r.excluidosBaixaCobertura + r.excluidosOpacos;
  const terminaisNovos = r.enviadosAoModelo + r.propagados - r.dependentesOrfaos;
  console.log(`  ${pad(r.residualLido)}  residual lido nesta passagem`);
  console.log(`  ${pad(condicionais)}  CONDICIONAIS — não consomem API, voltam enquanto a condição durar`);
  console.log(`  ${pad(r.residualAnalisado - condicionais - r.dependentesOrfaos)}  PROCESSÁVEIS tratados nesta passagem`);
  console.log(`  ${pad(Math.max(0, terminaisNovos))}  decisões TERMINAIS novas (cache desta versão — não voltam)`);
  console.log(`  ${pad(r.enviadosAoModelo)}  enviados ao modelo`);
  console.log(`  ${pad(r.propagados)}  propagados (${r.propagadosSemEscrita} sem escrita)`);
  console.log(`  ${pad(r.dependentesOrfaos)}  ÓRFÃOS TRANSITÓRIOS — sem decisão para herdar, voltam e podem gastar API`);
  console.log("");
  console.log("  BACKLOG PROCESSÁVEL CONCLUÍDO quando, e só quando:");
  console.log("    processáveis restantes = 0");
  console.log("    E sem destino contabilizado = 0");
  console.log("    E nenhuma decisão terminal volta a consumir API");
  console.log("  O residual bruto pode ficar > 0 para sempre: são os condicionais.");
  console.log("  Os órfãos por falha de infraestrutura repetem-se legitimamente —");
  console.log("  não houve decisão para herdar, e repetir não é desperdício.");

  await prisma.$disconnect();

  // A decisão do código de saída vive em `codigoDeSaida`, testada à
  // parte: é este número que o encadeamento de lotes usa para decidir
  // se lança o seguinte, e uma decisão que gasta dinheiro sozinha tem
  // de poder ser exercitada sem base de dados nem chave da API.
  const saida = codigoDeSaida({
    falhaInfraestrutura: falhaInfra,
    semDestino: falhaContabilistica,
  });

  if (saida === SAIDA.INFRAESTRUTURA) {
    console.error(
      "\nCORRIDA INTERROMPIDA POR INFRAESTRUTURA. Nada foi decidido sobre os\n" +
        "produtos que faltavam, e a fila ficou intacta. Resolver a causa e\n" +
        "voltar a correr — nenhuma chamada já paga será repetida.",
    );
  } else if (saida === SAIDA.RECONCILIACAO) {
    console.error(
      "\nRECONCILIAÇÃO NÃO FECHOU. Há produtos lidos do residual sem destino\n" +
        "contabilizado: alguns produtos passaram pela corrida sem estado e sem\n" +
        "nome. NÃO retomar o backlog até a causa estar identificada.",
    );
  }
  if (saida !== SAIDA.OK) process.exit(saida);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
