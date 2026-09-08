/**
 * scripts/catalog/alinhar-classificacao-tenant.ts
 *
 * Alinha a classificação de um produto do tenant ao catálogo global,
 * quando a decisão foi tomada e o caminho normal recusa.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO PRECISOU DE EXISTIR
 *
 * Nenhum caminho suportado escreve uma classificação específica POR CIMA
 * de outra específica, e isso é deliberado:
 *
 *   · `catalog:project-global` — `avaliarProjeccao` devolve REVISAO
 *     quando o tenant tem uma classificação específica diferente. É
 *     precisamente por isso que estes produtos estão na fila.
 *   · `escreverClassificacao` — o WHERE só aceita nível 2 vazio, "Outros
 *     X", ou uma PROVISORIA a ser corrigida por uma CANONICA.
 *   · a UI de revisão do tenant — escreve N1/N2 mas deixa
 *     `classificacaoEstado`, `Origem`, `Confianca` e `Versao` para trás.
 *     É um dos seis escritores que fazem o enum derivar.
 *
 * A recusa está certa como regra geral: um erro global não pode degradar
 * uma classificação local. O que faltava era a excepção EXPLÍCITA — uma
 * pessoa que olhou para a divergência, decidiu que o global tem razão, e
 * assina por isso.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE IMPEDE QUE ISTO SEJA UMA PORTA DAS TRASEIRAS
 *
 * Não recebe filtro nem faz varreduras. Só actua sobre CNPs escritos à
 * mão, e para cada um exige TRÊS condições que não pode inventar:
 *
 *   1. existe uma `CatalogoGlobalRevisao` ABERTA para (cnp, tenant) —
 *      não se alinha o que ninguém registou como divergente;
 *   2. o `valorGlobal` gravado nessa revisão é IGUAL ao que o
 *      `CatalogoGlobal` diz hoje — se o global mudou desde a detecção, a
 *      decisão foi tomada sobre outra coisa e o produto é recusado;
 *   3. o par existe no vocabulário do tenant.
 *
 * Ou seja: só consegue escrever aquilo que o catálogo nacional já diz,
 * onde uma divergência está registada. Não escreve pares arbitrários.
 *
 * `validadoManualmente` continua soberano: um produto validado à mão é
 * recusado, como em todo o resto do pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PROVENIÊNCIA E VOLTA ATRÁS
 *
 * O carimbo é o MESMO de uma projecção — `carimboProjeccao` — porque é
 * exactamente isso que isto é: a projecção que a guarda normal recusa.
 * Origem `GLOBAL`, estado derivado da evidência do global, confiança
 * reduzida por `FATOR_PROJECCAO`, versão a do global.
 *
 * O journal é `LinhaJournal`, o mesmo formato que
 * `catalog:rollback-classificacao` lê. Não há rollback novo: há o que já
 * existe.
 *
 * NÃO resolve a revisão. Marcar a `CatalogoGlobalRevisao` como resolvida
 * é o passo seguinte e tem comando próprio — `catalog:resolver-revisao`.
 * Juntar as duas coisas faria uma escrita de dados fechar sozinha o
 * registo de que ela era precisa.
 *
 * Uso:
 *   npm run catalog:alinhar-classificacao -- --tenant=garantia \
 *     --cnp=6123422,6123612 --aprovador="Bruno Reis" \
 *     --motivo="o global tem razão; o mapper concorda"
 *
 *   ... --apply --journal=/tmp/alinhar-garantia.jsonl
 */
import "dotenv/config";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, controlPrisma, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { carimboProjeccao } from "../../lib/catalog/projeccao-classificacao";
import type { LinhaJournal } from "../../lib/catalog/escrita-classificacao";

const linha = (s = "") => console.log(s);
const pad = (n: number, w = 5) => String(n).padStart(w);

const valor = (argv: string[], nome: string): string | null => {
  const p = argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3).trim() : null;
};

function recusar(mensagem: string): never {
  console.error(`\n${mensagem}\n`);
  process.exit(2);
}

type Alvo = {
  cnp: number;
  revisaoId: string;
  valorGlobalSnapshot: string | null;
  gCategoria: string | null;
  gSubcategoria: string | null;
  gConfidence: number | null;
  gEvidence: string | null;
  gVersao: string | null;
};

type EstadoLocal = {
  id: string;
  cnp: number;
  designacao: string;
  manual: boolean;
  n1Id: string | null;
  n2Id: string | null;
  n1: string | null;
  n2: string | null;
  estado: string;
  origem: string | null;
  confianca: number | null;
  versao: string | null;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");

  const aprovador = valor(argv, "aprovador") ?? "";
  const motivo = valor(argv, "motivo") ?? "";
  const journal = valor(argv, "journal");
  const listaCnp = valor(argv, "cnp");

  linha("SPharm.MT · alinhar classificação do tenant ao global · " + (apply ? "APPLY" : "DRY-RUN"));

  if (!aprovador || !motivo) {
    recusar(
      "Isto sobrepõe uma classificação específica. Exige quem e porquê:\n" +
        '  --aprovador="Nome de quem responde por isto"\n' +
        '  --motivo="o que justifica alinhar ao global"',
    );
  }
  if (!listaCnp) {
    recusar(
      "Falta --cnp=<lista>.\n" +
        "  Não há varredura nem filtro: só actua sobre códigos escritos à mão.",
    );
  }
  const cnps = listaCnp
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (cnps.length === 0) recusar(`--cnp=${listaCnp} não tem nenhum código válido.`);

  // O journal é a única forma de desfazer isto. Sem ele, `--apply` seria
  // uma escrita sem volta — e é a mesma exigência que o
  // `catalog:reavaliar-cache` já faz.
  if (apply && !journal) {
    recusar("--apply exige --journal=<ficheiro.jsonl>: sem journal não há rollback.");
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) recusar(err.message);
    throw err;
  }
  if (!alvo.tenant) recusar("Este comando precisa de --tenant=<slug>.");

  const tenantSlug = alvo.tenant;
  await controlPrisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  // ── O que o control plane autoriza ────────────────────────────────
  const alvos = await controlPrisma.$queryRawUnsafe<Alvo[]>(
    `select r.id as "revisaoId", r.cnp, r."valorGlobal" as "valorGlobalSnapshot",
            g.categoria     as "gCategoria",
            g.subcategoria  as "gSubcategoria",
            g.confidence    as "gConfidence",
            g."evidenceType" as "gEvidence",
            g."versaoRegras" as "gVersao"
       from "CatalogoGlobalRevisao" r
       left join "CatalogoGlobal" g on g.cnp = r.cnp
      where r."resolvidoEm" is null
        and r."tenantSlug" = $1
        and r.cnp = any('{${cnps.join(",")}}'::int[])`,
    tenantSlug,
  );

  const porCnp = new Map(alvos.map((a) => [Number(a.cnp), a]));

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  if (!apply) {
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
  }

  linha("═".repeat(84));
  linha(`  ${descreverAlvo(alvo)}`);
  linha(`  aprovador: ${aprovador}`);
  linha(`  motivo ..: ${motivo}`);
  linha("═".repeat(84));

  const locais = await prisma.$queryRawUnsafe<EstadoLocal[]>(
    `select p.id, p.cnp, p.designacao,
            p."validadoManualmente" as manual,
            p."classificacaoNivel1Id" as "n1Id",
            p."classificacaoNivel2Id" as "n2Id",
            c1.nome as n1, c2.nome as n2,
            p."classificacaoEstado"::text as estado,
            p."classificacaoOrigem"    as origem,
            p."classificacaoConfianca" as confianca,
            p."classificacaoVersao"    as versao
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
      where p.cnp = any('{${cnps.join(",")}}'::int[])`,
  );
  const localPorCnp = new Map(locais.map((l) => [Number(l.cnp), l]));

  // Vocabulário do tenant. Fechado: nada é criado.
  const tax = await prisma.$queryRawUnsafe<Array<{ id: string; nome: string; pai: string | null }>>(
    `select id, nome, "classificacaoPaiId" as pai from "Classificacao" where estado = 'ATIVO'`,
  );
  const n1PorNome = new Map<string, string>();
  const n2PorChave = new Map<string, string>();
  for (const t of tax) if (!t.pai) n1PorNome.set(t.nome.toUpperCase(), t.id);
  for (const t of tax) if (t.pai) n2PorChave.set(`${t.pai}::${t.nome.toUpperCase()}`, t.id);

  let escritos = 0;
  let recusados = 0;
  const linhasJournal: LinhaJournal[] = [];

  for (const cnp of cnps) {
    const a = porCnp.get(cnp);
    const l = localPorCnp.get(cnp);
    linha("");
    linha(`  ${cnp}  ${l?.designacao ?? "(produto não encontrado no tenant)"}`);

    const recusa = (porque: string) => {
      recusados++;
      linha(`     RECUSADO: ${porque}`);
    };

    if (!a) {
      recusa("não há revisão global ABERTA para este cnp neste tenant");
      continue;
    }
    if (!l) {
      recusa("o produto não existe na base do tenant");
      continue;
    }
    if (l.manual) {
      recusa("validadoManualmente — uma decisão humana local não é sobreposta");
      continue;
    }
    if (!a.gCategoria || !a.gSubcategoria) {
      recusa("o catálogo global não tem classificação para este cnp");
      continue;
    }

    // O global de HOJE tem de ser o mesmo sobre que a decisão foi tomada.
    const parHoje = `${a.gCategoria} > ${a.gSubcategoria}`;
    if (a.valorGlobalSnapshot && a.valorGlobalSnapshot.trim() !== parHoje) {
      recusa(
        `o global mudou desde a detecção — revisão diz "${a.valorGlobalSnapshot}", ` +
          `hoje diz "${parHoje}". Rever antes de alinhar.`,
      );
      continue;
    }

    const n1Id = n1PorNome.get(a.gCategoria.toUpperCase());
    const n2Id = n1Id ? n2PorChave.get(`${n1Id}::${a.gSubcategoria.toUpperCase()}`) : undefined;
    if (!n1Id || !n2Id) {
      recusa(`"${parHoje}" não existe no vocabulário deste tenant — falta correr o seed`);
      continue;
    }
    if (l.n1Id === n1Id && l.n2Id === n2Id) {
      recusa("já está alinhado — nada a fazer");
      continue;
    }

    const carimbo = carimboProjeccao({
      evidenceType: a.gEvidence,
      confidence: a.gConfidence ?? 0,
      versaoRegras: a.gVersao ?? "",
    });

    linha(`     local .... ${l.n1 ?? "—"} > ${l.n2 ?? "—"}   (${l.estado}, ${l.origem ?? "sem origem"})`);
    linha(`     global ... ${parHoje}`);
    linha(
      `     escreve .. ${parHoje}   [${carimbo.estado}, ${carimbo.origem}, ` +
        `${carimbo.confianca.toFixed(2)}, ${carimbo.versao}]`,
    );

    const registo: LinhaJournal = {
      cnp,
      n1AntesId: l.n1Id,
      n2AntesId: l.n2Id,
      n1Antes: l.n1,
      n2Antes: l.n2,
      estadoAntes: l.estado as LinhaJournal["estadoAntes"],
      origemAntes: l.origem,
      confiancaAntes: l.confianca,
      versaoAntes: l.versao,
      n1DepoisId: n1Id,
      n2DepoisId: n2Id,
      n1Depois: a.gCategoria,
      n2Depois: a.gSubcategoria,
      estadoDepois: carimbo.estado,
      origemDepois: carimbo.origem,
      confiancaDepois: carimbo.confianca,
      versaoDepois: carimbo.versao,
    };

    if (!apply) {
      escritos++;
      continue;
    }

    // A ÚNICA guarda que sobrevive aqui é `validadoManualmente`. A da
    // não-degradação é exactamente a que esta ferramenta existe para
    // ultrapassar — e por isso o preço é o journal, o aprovador e a lista
    // explícita de CNPs. Repetida no WHERE porque o estado pode ter
    // mudado entre o SELECT e este UPDATE.
    const n = await prisma.$executeRawUnsafe(
      `update "Produto" p
          set "classificacaoNivel1Id"  = $2,
              "classificacaoNivel2Id"  = $3,
              "classificacaoEstado"    = $4::"ClassificacaoEstado",
              "classificacaoOrigem"    = $5,
              "classificacaoConfianca" = $6,
              "classificacaoVersao"    = $7,
              "dataAtualizacao"        = now()
        where p.cnp = $1
          and p."validadoManualmente" = false
          and p."classificacaoNivel2Id" is not distinct from $8`,
      cnp, n1Id, n2Id, carimbo.estado, carimbo.origem, carimbo.confianca, carimbo.versao, l.n2Id,
    );

    if (Number(n) === 0) {
      recusa("o estado mudou entre a leitura e a escrita — nada foi escrito");
      continue;
    }
    escritos++;
    linhasJournal.push(registo);
  }

  if (apply && journal && linhasJournal.length > 0) {
    mkdirSync(dirname(journal), { recursive: true });
    appendFileSync(journal, linhasJournal.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }

  linha("");
  linha("═".repeat(84));
  linha(`  ${pad(escritos)}  ${apply ? "escritos" : "seriam escritos"}`);
  linha(`  ${pad(recusados)}  recusados`);
  if (apply && journal) {
    linha("");
    linha(`  journal: ${journal}`);
    linha(`  desfazer: npm run catalog:rollback-classificacao -- --tenant=${tenantSlug} \\`);
    linha(`              --journal=${journal} --apply`);
  }
  if (!apply) {
    linha("");
    linha("  DRY-RUN: nada foi escrito. Para aplicar:");
    linha("    --apply --journal=<ficheiro.jsonl>");
  }
  linha("");
  linha("  A revisão NÃO foi resolvida. Isso é catalog:resolver-revisao,");
  linha("  e é deliberado: uma escrita de dados não deve fechar sozinha o");
  linha("  registo de que ela era precisa.");

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
