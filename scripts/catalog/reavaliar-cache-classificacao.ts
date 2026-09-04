/**
 * scripts/catalog/reavaliar-cache-classificacao.ts
 *
 * Reaproveitar respostas do modelo que JÁ foram pagas e foram recusadas.
 *
 * ── O que isto é ─────────────────────────────────────────────────────
 *
 * `KnowledgeEnrichmentCache` guarda a resposta integral do modelo, tenha
 * ela sido escrita ou não — é o que torna a corrida idempotente. Na
 * Silveira há 2 774 linhas nessas condições: o modelo respondeu com um par
 * válido da taxonomia, e o gate recusou-o porque o `evidenceType` era
 * `CATEGORIA_PRODUTO`.
 *
 * Este comando volta a passar essas respostas pelo gate — que agora tem um
 * ramo provisório — e escreve as que passarem, marcadas `PROVISORIA`.
 *
 * ZERO chamadas ao modelo. Nem uma. Não há aqui cliente da API nem
 * importação de `classificarLote`; o que se lê já está na base.
 *
 * ── O que NÃO faz ────────────────────────────────────────────────────
 *
 *   · não chama IA;
 *   · não toca em produtos entretanto classificados ou validados à mão —
 *     lê o estado ACTUAL, não o de quando a resposta foi dada;
 *   · não escreve productType, ATC, DCI, forma, dosagem nem utilizações;
 *   · não escreve nada sem `--apply`.
 *
 * ── A restrição clínica ──────────────────────────────────────────────
 *
 * `precisaVerificacao()` exige segunda passagem para MEDICAMENTOS e para
 * utilizações clínicas. A cache NÃO guarda se o verificador concordou —
 * não há campo para isso — portanto para essas respostas o critério
 * `verificado` não é reconstruível.
 *
 * Não se inventa um `true`. Essas linhas não são escritas: vão para a
 * `FilaRevisao`, onde uma pessoa decide. É a diferença entre reaproveitar
 * o que se sabe e fingir que se sabe mais.
 *
 * É também por isto que o número de recuperáveis do dry-run é MENOR do que
 * o da simulação read-only que motivou este trabalho: aquela contou os
 * 2 195 sem descontar os que precisam de verificação clínica. O dry-run
 * imprime as duas contagens lado a lado.
 *
 * ── Idempotência e retoma ────────────────────────────────────────────
 *
 * Cada linha tratada fica com `reavaliadoEm`/`reavaliadoVersao`. Uma
 * segunda corrida com o mesmo limiar não faz nada; uma corrida
 * interrompida a meio de 2 774 continua onde ficou. Sem isto, uma
 * interrupção obrigava a recomeçar sem saber o que já tinha sido escrito.
 *
 * Uso:
 *   npm run catalog:reavaliar-cache -- --tenant=<slug>
 *   npm run catalog:reavaliar-cache -- --tenant=<slug> --limit=200 --apply --journal=/tmp/j.jsonl
 *   npm run catalog:reavaliar-cache -- --tenant=<slug> --apply --journal=/tmp/j.jsonl
 */
import "dotenv/config";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import {
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_PERSISTENCIA,
  VERSAO_PROVISORIA,
  avaliarGate,
  precisaVerificacao,
  type EvidenceType,
  type KnowledgeResult,
} from "../../lib/catalog/knowledge-enrichment";
import { escreverClassificacao, type LinhaJournal } from "../../lib/catalog/escrita-classificacao";
import {
  enfileirarRevisaoClassificacao,
  propostaAccionavel,
} from "../../lib/catalog/fila-revisao-classificacao";

/** A versão que carimba `reavaliadoVersao`. Muda quando a política mudar. */
const VERSAO_REAVALIACAO = VERSAO_PROVISORIA;

const pad = (n: number | string, w = 6) => String(n).padStart(w);
const nf = (n: number) => n.toLocaleString("pt-PT");

type LinhaCache = {
  chave: string;
  cnp: number;
  designacao: string;
  categoria: string | null;
  subcategoria: string | null;
  cacheProductType: string | null;
  confidence: number;
  evidenceType: string;
  rationale: string | null;
  motivo: string | null;
  // Estado ACTUAL do produto — lido agora, não o de quando se perguntou.
  produtoId: string | null;
  productType: string | null;
  nivel1: string | null;
  nivel2: string | null;
  validadoManualmente: boolean | null;
  classificacaoEstado: string | null;
};

/**
 * As linhas de cache com uma proposta por aproveitar.
 *
 * O filtro é o mínimo indispensável — tudo o resto é decidido pelo gate,
 * que é a mesma função que decide em produção. Filtrar mais aqui seria
 * reimplementar o gate em SQL, e as duas implementações divergiriam.
 */
async function lerCandidatos(
  prisma: PrismaClient,
  limite: number | null,
  reprocessar: boolean,
): Promise<LinhaCache[]> {
  return prisma.$queryRawUnsafe<LinhaCache[]>(
    `select k.chave,
            k.cnp,
            k.designacao,
            k.categoria,
            k.subcategoria,
            k."productType"          as "cacheProductType",
            coalesce(k.confidence, 0) as confidence,
            k."evidenceType"         as "evidenceType",
            k.rationale,
            k.motivo,
            p.id                     as "produtoId",
            p."productType"          as "productType",
            c1.nome                  as nivel1,
            c2.nome                  as nivel2,
            p."validadoManualmente"  as "validadoManualmente",
            p."classificacaoEstado"::text as "classificacaoEstado"
       from "KnowledgeEnrichmentCache" k
       left join "Produto" p on p.cnp = k.cnp
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
      where k.persistido = false
        and k.categoria is not null
        and k.subcategoria is not null
        and k.cnp > $1
        ${reprocessar ? "" : `and k."reavaliadoVersao" is distinct from '${VERSAO_REAVALIACAO}'`}
      order by k.confidence desc, k.cnp
      ${limite === null ? "" : `limit ${Math.floor(limite)}`}`,
    MIN_CNP_CATALOGAVEL,
  );
}

/**
 * Reconstrói o resultado do modelo a partir da linha de cache.
 *
 * Os campos clínicos ficam a `null` e as utilizações vazias de propósito:
 * este comando escreve CLASSIFICAÇÃO e mais nada. Deixá-los preenchidos
 * abriria a porta a `escrever()` gravar um ATC por um caminho que nunca
 * foi pensado para isso.
 */
function reconstruir(l: LinhaCache): KnowledgeResult {
  return {
    cnp: l.cnp,
    productType: (l.cacheProductType as KnowledgeResult["productType"]) ?? null,
    categoria: l.categoria,
    subcategoria: l.subcategoria,
    forma: null,
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    utilizacoes: [],
    confidence: Number(l.confidence),
    confidenceClinica: 0,
    evidenceType: l.evidenceType as EvidenceType,
    rationale: l.rationale ?? "",
    categoriaBruta: l.categoria,
    subcategoriaBruta: l.subcategoria,
    motivoPar: null,
    alvo: "CLASSIFICACAO",
  };
}

type Destino =
  | "escrita"
  | "clinica-para-revisao"
  | "recusada-para-revisao"
  | "recusada-sem-proposta"
  | "sem-produto"
  | "ja-resolvido";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const reprocessar = argv.includes("--reprocessar");
  const arg = (nome: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=");

  const limite = arg("limit") ? Number(arg("limit")) : null;
  if (limite !== null && (!Number.isFinite(limite) || limite < 1)) {
    console.error("\n--limit tem de ser um inteiro positivo.\n");
    process.exit(4);
  }

  const confianca = arg("confianca") ? Number(arg("confianca")) : LIMIAR_PERSISTENCIA;
  if (!Number.isFinite(confianca) || confianca < 0 || confianca > 1) {
    console.error("\n--confianca tem de estar entre 0 e 1.\n");
    process.exit(4);
  }
  if (confianca < LIMIAR_PERSISTENCIA) {
    // Recusar em vez de aceitar em silêncio: abaixo do limiar do gate a
    // escrita nunca aconteceria, e um operador que pedisse 0,70 ficaria a
    // olhar para zero escritas sem perceber porquê.
    console.error(
      `\n--confianca=${confianca} está abaixo do limiar do gate (${LIMIAR_PERSISTENCIA}).\n` +
        `O gate recusaria tudo. Baixar o limiar é outra decisão, e não se toma por linha de comando.\n`,
    );
    process.exit(4);
  }

  const journal = arg("journal");
  if (apply && !journal) {
    // O journal é a ÚNICA forma de desfazer isto sem perder os "Outros X"
    // que forem substituídos. Escrever sem ele seria escrever sem volta.
    console.error(
      "\n--apply exige --journal=<ficheiro>.\n" +
        "É o que permite reverter linha a linha, incluindo as classificações\n" +
        '"Outros X" que forem substituídas — que um rollback por SQL apagaria.\n',
    );
    process.exit(4);
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (!alvo.tenant) {
    console.error("\nEste comando precisa de --tenant=<slug>.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  if (!apply) {
    // READ-ONLY na própria sessão. Não é decorativo: garante que um bug
    // neste ficheiro não consegue escrever mesmo que tente.
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
  }

  console.log("═".repeat(74));
  console.log(`${descreverAlvo(alvo)}   (reavaliação da cache — ${apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`versão de regras: ${KNOWLEDGE_VERSION}   modelo em cache: ${KNOWLEDGE_MODEL}`);
  console.log(`limiar: ${confianca}   carimbo: ${VERSAO_REAVALIACAO}   ZERO chamadas ao modelo`);
  if (journal) console.log(`journal: ${journal}`);
  console.log("═".repeat(74));

  if (journal) {
    mkdirSync(dirname(journal), { recursive: true });
  }

  // Os IDs da taxonomia, uma vez. Resolver por nome dentro do ciclo daria
  // uma query por produto para responder sempre o mesmo.
  const classificacoes = await prisma.classificacao.findMany({
    select: { id: true, nome: true, tipo: true, classificacaoPaiId: true },
  });
  const n1PorNome = new Map<string, string>();
  const n2PorChave = new Map<string, string>();
  for (const c of classificacoes) {
    if (c.tipo === "NIVEL_1") n1PorNome.set(c.nome.toUpperCase(), c.id);
  }
  for (const c of classificacoes) {
    if (c.tipo === "NIVEL_2" && c.classificacaoPaiId) {
      n2PorChave.set(`${c.classificacaoPaiId}::${c.nome.toUpperCase()}`, c.id);
    }
  }

  const candidatos = await lerCandidatos(prisma, limite, reprocessar);
  console.log(`\n── candidatos ─────────────────────────────────────────`);
  console.log(`  ${pad(candidatos.length)}  linhas de cache com par válido e não persistidas`);

  if (candidatos.length === 0) {
    console.log("\nNada a fazer.");
    await prisma.$disconnect();
    return;
  }

  const conta: Record<Destino, number> = {
    escrita: 0,
    "clinica-para-revisao": 0,
    "recusada-para-revisao": 0,
    "recusada-sem-proposta": 0,
    "sem-produto": 0,
    "ja-resolvido": 0,
  };
  const motivos = new Map<string, number>();
  const exemplos: string[] = [];
  let revisoesCriadas = 0;
  let semIdTaxonomia = 0;

  for (const l of candidatos) {
    if (!l.produtoId) {
      conta["sem-produto"]++;
      continue;
    }
    if (l.validadoManualmente) {
      conta["ja-resolvido"]++;
      continue;
    }

    const r = reconstruir(l);

    // A verificação clínica não é reconstruível a partir da cache. Passar
    // `concorda: false` não é pessimismo — é a leitura honesta de "não sei",
    // e o gate transforma isso num REVIEW em vez de numa escrita.
    const exigeVerificacao = precisaVerificacao(r);
    const gate = avaliarGate(
      r,
      {
        categoria: l.nivel1,
        subcategoria: l.nivel2,
        productType: l.productType,
      },
      exigeVerificacao
        ? { concorda: false, aplicavel: true }
        : { concorda: true, aplicavel: false },
    );

    const passaLimiar = Number(l.confidence) >= confianca;

    if (gate.decisao === "APPLY" && gate.gravarCategoria && passaLimiar) {
      const n1Id = r.categoria ? n1PorNome.get(r.categoria.toUpperCase()) : undefined;
      const n2Id = n1Id && r.subcategoria
        ? n2PorChave.get(`${n1Id}::${r.subcategoria.toUpperCase()}`)
        : undefined;
      if (!n1Id || !n2Id) {
        // O par é válido na taxonomia CANÓNICA mas não existe como linha
        // nesta base. Acontece quando o `seed-taxonomy` está atrasado, e é
        // um problema de bootstrap — não de classificação.
        semIdTaxonomia++;
        continue;
      }

      if (exemplos.length < 12) {
        exemplos.push(
          `  ${String(l.cnp).padEnd(9)} ${l.designacao.slice(0, 38).padEnd(38)} ` +
            `${(l.nivel2 ?? "—").slice(0, 16).padEnd(16)} → ${r.categoria} > ${r.subcategoria} ` +
            `(${Number(l.confidence).toFixed(2)})`,
        );
      }

      if (!apply) {
        conta.escrita++;
        continue;
      }

      const linha = await escreverClassificacao(prisma, {
        cnp: l.cnp,
        n1Id,
        n2Id,
        n1Nome: r.categoria as string,
        n2Nome: r.subcategoria as string,
        estado: gate.provisorio ? "PROVISORIA" : "CANONICA",
        origem: gate.provisorio ? "MODELO_PROVISORIO" : "MODELO",
        confianca: Number(l.confidence),
        versao: VERSAO_REAVALIACAO,
      });

      if (linha) {
        conta.escrita++;
        if (journal) appendFileSync(journal, `${JSON.stringify(linha satisfies LinhaJournal)}\n`, "utf8");
      } else {
        // O guarda recusou: entre a leitura e a escrita o produto ganhou
        // classificação, ou foi validado. Não é erro.
        conta["ja-resolvido"]++;
      }
      await marcarReavaliada(prisma, l.chave);
      continue;
    }

    // ── Não escreve. Vai para a fila humana, se houver o que decidir ──
    const destino: Destino = exigeVerificacao
      ? "clinica-para-revisao"
      : propostaAccionavel({
          categoria: l.categoria,
          subcategoria: l.subcategoria,
          evidenceType: l.evidenceType,
        })
      ? "recusada-para-revisao"
      : "recusada-sem-proposta";
    conta[destino]++;

    const chaveMotivo = !passaLimiar
      ? `confiança ${Number(l.confidence).toFixed(2)} < ${confianca}`
      : exigeVerificacao
      ? "verificação clínica não reconstruível da cache"
      : gate.motivo;
    motivos.set(chaveMotivo, (motivos.get(chaveMotivo) ?? 0) + 1);

    if (apply && destino !== "recusada-sem-proposta") {
      const res = await enfileirarRevisaoClassificacao(prisma, {
        cnp: l.cnp,
        categoria: l.categoria as string,
        subcategoria: l.subcategoria as string,
        productType: l.productType,
        confidence: Number(l.confidence),
        evidenceType: l.evidenceType,
        rationale: l.rationale,
        motivo: chaveMotivo,
        chaveCache: l.chave,
        fonte: "reavaliacao-cache",
      });
      if (res === "criada") revisoesCriadas++;
      await marcarReavaliada(prisma, l.chave);
    }
  }

  // ── Relatório ──────────────────────────────────────────────────────
  console.log(`\n── destino ────────────────────────────────────────────`);
  console.log(`  ${pad(conta.escrita)}  ${apply ? "ESCRITAS" : "seriam escritas"} como PROVISORIA`);
  console.log(`  ${pad(conta["clinica-para-revisao"])}  travadas pela verificação clínica → revisão humana`);
  console.log(`  ${pad(conta["recusada-para-revisao"])}  recusadas pelo gate → revisão humana`);
  console.log(`  ${pad(conta["recusada-sem-proposta"])}  recusadas sem nada que uma pessoa possa decidir`);
  console.log(`  ${pad(conta["ja-resolvido"])}  produto já classificado ou validado — intocado`);
  console.log(`  ${pad(conta["sem-produto"])}  linha de cache sem produto nesta base`);
  if (semIdTaxonomia > 0) {
    console.log(`  ${pad(semIdTaxonomia)}  par canónico SEM linha de Classificacao nesta base`);
    console.log(`         (bootstrap da taxonomia em atraso — correr catalog:seed-taxonomy)`);
  }
  if (apply) {
    console.log(`  ${pad(revisoesCriadas)}  entradas novas em FilaRevisao`);
  }

  const soma = Object.values(conta).reduce((a, b) => a + b, 0) + semIdTaxonomia;
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  ${pad(soma)}  total (bate com os ${nf(candidatos.length)} candidatos: ${soma === candidatos.length ? "sim" : "NÃO — investigar"})`);

  console.log(`\n── porque é que as outras não passam ──────────────────`);
  for (const [m, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${pad(n)}  ${m}`);
  }

  if (exemplos.length > 0) {
    console.log(`\n── amostra do que ${apply ? "foi" : "seria"} escrito ────────────────`);
    console.log(`  ${"cnp".padEnd(9)} ${"designação".padEnd(38)} ${"actual".padEnd(16)}   proposta`);
    for (const e of exemplos) console.log(e);
  }

  if (!apply) {
    console.log(`\nDRY-RUN: nada foi escrito. Para aplicar:`);
    console.log(`  npm run catalog:reavaliar-cache -- --tenant=${alvo.tenant} --limit=200 --apply --journal=/tmp/canario.jsonl`);
  }

  await prisma.$disconnect();
}

/**
 * Marca a linha como tratada por esta versão da política.
 *
 * Chamado DEPOIS da escrita, nunca antes: se o processo morrer entre as
 * duas coisas, a linha volta a ser candidata e a escrita é idempotente
 * pelos guardas do UPDATE. A ordem inversa perdia a linha em silêncio.
 */
async function marcarReavaliada(prisma: PrismaClient, chave: string): Promise<void> {
  await prisma.knowledgeEnrichmentCache.update({
    where: { chave },
    data: { reavaliadoEm: new Date(), reavaliadoVersao: VERSAO_REAVALIACAO },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
