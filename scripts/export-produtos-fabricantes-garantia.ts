/**
 * scripts/export-produtos-fabricantes-garantia.ts
 *
 * Exportador ESTRITAMENTE de leitura dos produtos e fabricantes do
 * tenant garantia, para cruzamento posterior por CNP com um catálogo
 * nacional externo.
 *
 * ── O que este script NÃO faz ────────────────────────────────────────
 * Não agrupa fabricantes, não decide relações comerciais, não altera o
 * plano de normalização (scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json,
 * intacto), não esconde nada na UI, não normaliza nomes. Só lê e
 * escreve um ficheiro. Não há `--apply` — não existe modo de escrita
 * nenhum.
 *
 * ── Segurança: travado ao tenant garantia ────────────────────────────
 * Igual a scripts/normalizar-fabricantes-garantia.ts: `--tenant=garantia`
 * é o único valor aceite, verificado ANTES de resolverAlvo. Depois de
 * resolverAlvo (lib/catalog/target-db.ts + lib/control-plane.ts, nunca
 * um DATABASE_URL genérico), confirmarAlvoGarantia confere OUTRA VEZ que
 * o slug do tenant resolvido E o nome da base batem com garantia /
 * spharmmt_t_garantia — a segunda trava existe porque a primeira só prova
 * que foi PEDIDO garantia, não que o control plane devolveu garantia.
 *
 * ── Segurança: leitura, sempre ───────────────────────────────────────
 * A sessão Postgres é posta em `default_transaction_read_only = on` logo
 * a seguir a ligar — sem excepção e sem opção que a desligue (ver
 * test-target-db.ts). `buscarDados` só chama `produto.findMany` e
 * `fabricante.findMany`: nenhum create/update/upsert/delete/$executeRaw
 * de escrita existe neste ficheiro.
 *
 * ── Campos exportados (ver camposUtilizados no próprio ficheiro) ─────
 * Só o necessário para identificar produto e fabricante: CNP, nome,
 * estado, validadoManualmente, fabricante (id + denominação + estado) e
 * aliases do fabricante. Nada de stocks, vendas, preços, clientes,
 * farmácias, movimentos, credenciais, URLs de ligação ou passwords —
 * nem sequer são pedidos ao Prisma (select explícito, nunca um include
 * genérico).
 *
 * ── Determinismo e atomicidade ───────────────────────────────────────
 * `construirExport` é pura: dados brutos → ficheiro final, sem tocar em
 * nada. Produtos ordenados por cnp e depois id; fabricantes por
 * nomeNormalizado e depois id; aliases alfabeticamente. O JSON só é
 * considerado concluído depois de as duas queries terminarem com
 * sucesso — escreve-se primeiro para um `.tmp`, e só um `renameSync`
 * atómico o torna `--output`. Um output vazio (zero produtos) é
 * recusado.
 *
 * Uso:
 *   npx tsx scripts/export-produtos-fabricantes-garantia.ts \
 *     --tenant=garantia \
 *     --output=/relatorios/produtos-fabricantes-garantia.json
 */
import "dotenv/config";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";

export const TENANT_TRAVADO = "garantia";
export const BASE_ESPERADA = "spharmmt_t_garantia";
/** scripts/data/relatorio-normalizacao-garantia.json (fase anterior, fabricantes) — só contexto, nunca verdade absoluta. */
export const PRODUTOS_ASSOCIADOS_RELATORIO_ANTERIOR = 33_553;
const TAMANHO_PAGINA = 2000;

// ── Campos reais do Prisma usados neste export — nada é adivinhado ───
export const CAMPOS_UTILIZADOS = {
  codigoProduto: "Produto.cnp",
  nomeProduto: "Produto.designacao",
  estadoProduto: "Produto.estado",
  validadoManualmente: "Produto.validadoManualmente",
  fabricante: "Produto.fabricanteId -> Fabricante.id (relação Produto.fabricante)",
  fabricanteNomeNormalizado: "Fabricante.nomeNormalizado",
  fabricanteEstado: "Fabricante.estado",
  fabricanteAliases: "FabricanteAlias.aliasNome (relação Fabricante.aliases)",
} as const;

export type Args = { tenant: string; output: string };

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = {};
  for (const a of argv) {
    if (a.startsWith("--tenant=")) out.tenant = a.slice("--tenant=".length);
    else if (a.startsWith("--output=")) out.output = a.slice("--output=".length);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!out.tenant) throw new Error("--tenant=<slug> é obrigatório");
  if (out.tenant !== TENANT_TRAVADO) {
    throw new Error(
      `Este exportador está travado ao tenant "${TENANT_TRAVADO}" — recebeu --tenant=${out.tenant}.\n` +
        `Os produtos e fabricantes doutro tenant não fazem sentido neste ficheiro.`,
    );
  }
  if (!out.output || out.output.trim() === "") {
    throw new Error("--output=<caminho> é obrigatório e não pode ser vazio.");
  }
  return out as Args;
}

/**
 * Segunda trava, DEPOIS de resolverAlvo: a primeira (parseArgs) só prova
 * que foi PEDIDO "garantia" na linha de comandos — esta prova que o
 * control plane resolveu mesmo o tenant e a base certos. Um slug
 * coincidente por acidente noutro ambiente (ex.: staging com um tenant
 * mal nomeado) não passa daqui.
 */
export function confirmarAlvoGarantia(alvo: Pick<AlvoDb, "tenant" | "base">): void {
  if (alvo.tenant !== TENANT_TRAVADO) {
    throw new Error(
      `Alvo resolvido para tenant "${alvo.tenant}", não "${TENANT_TRAVADO}" — recusado antes de ler fosse o que fosse.`,
    );
  }
  if (alvo.base !== BASE_ESPERADA) {
    throw new Error(
      `Alvo resolvido para a base "${alvo.base}", não "${BASE_ESPERADA}" — recusado antes de ler fosse o que fosse.`,
    );
  }
}

// ── Forma bruta dos dados, tal como saem do Prisma (fronteira impura) ──

export type ProdutoBruto = {
  id: string;
  cnp: number | null;
  designacao: string;
  estado: string;
  validadoManualmente: boolean;
  fabricanteId: string | null;
};

export type FabricanteBruto = {
  id: string;
  nomeNormalizado: string;
  estado: string;
  aliases: string[];
};

/** Subconjunto de PrismaClient realmente usado — só leitura, para poder testar com um Prisma falso. */
export type PrismaSoLeitura = {
  produto: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; cnp: number | null; designacao: string; estado: string; validadoManualmente: boolean; fabricanteId: string | null }>
    >;
  };
  fabricante: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; nomeNormalizado: string; estado: string; aliases: Array<{ aliasNome: string }> }>
    >;
  };
};

/**
 * ÚNICA função deste ficheiro que fala com o Prisma — e só com
 * `findMany`. Paginada por cursor em `id` (nunca `skip` grande — não
 * escala em Postgres) para não segurar dezenas de milhares de linhas
 * de uma vez nem imprimir nada por linha.
 */
export async function buscarDados(prisma: PrismaSoLeitura): Promise<{ produtos: ProdutoBruto[]; fabricantes: FabricanteBruto[] }> {
  const produtos: ProdutoBruto[] = [];
  let cursor: string | undefined;
  for (;;) {
    const pagina = await prisma.produto.findMany({
      select: { id: true, cnp: true, designacao: true, estado: true, validadoManualmente: true, fabricanteId: true },
      orderBy: { id: "asc" },
      take: TAMANHO_PAGINA,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const p of pagina) produtos.push(p);
    if (pagina.length < TAMANHO_PAGINA) break;
    cursor = pagina[pagina.length - 1]!.id;
  }

  const fabricantesBrutos = await prisma.fabricante.findMany({
    select: { id: true, nomeNormalizado: true, estado: true, aliases: { select: { aliasNome: true } } },
  });
  const fabricantes: FabricanteBruto[] = fabricantesBrutos.map((f) => ({
    id: f.id,
    nomeNormalizado: f.nomeNormalizado,
    estado: f.estado,
    aliases: f.aliases.map((a) => a.aliasNome),
  }));

  return { produtos, fabricantes };
}

// ── Forma exportada (o que vai para o JSON) ───────────────────────────

export type ProdutoExport = {
  id: string;
  cnp: number | null;
  designacao: string;
  estado: string;
  validadoManualmente: boolean;
  fabricanteId: string | null;
  fabricanteNomeNormalizado: string | null;
  fabricanteEstado: string | null;
};

export type FabricanteExport = {
  id: string;
  nomeNormalizado: string;
  estado: string;
  aliases: string[];
  produtosAssociados: number;
};

export type ResumoExport = {
  totalProdutos: number;
  produtosComCnp: number;
  produtosSemCnp: number;
  cnpDistintos: number;
  cnpRepetidos: number;
  cnpComFabricantesDiferentes: number;
  produtosComFabricante: number;
  produtosSemFabricante: number;
  fabricantesExportados: number;
  fabricantesReferenciados: number;
  fabricantesAtivos: number;
  fabricantesInativos: number;
  produtosValidadosManualmente: number;
  comparacaoRelatorioAnterior: {
    produtosAssociadosRelatorioAnterior: number;
    produtosComFabricanteExportados: number;
    diferenca: number;
    nota: string;
  };
  /** Uma entrada por TIPO de inconsistência encontrado, já com a contagem no texto. */
  inconsistencias: string[];
  totalInconsistencias: number;
};

export type ExportProdutosFabricantesGarantia = {
  schemaVersion: 1;
  geradoEm: string;
  tenant: "garantia";
  base: string;
  readOnly: true;
  camposUtilizados: typeof CAMPOS_UTILIZADOS;
  resumo: ResumoExport;
  produtos: ProdutoExport[];
  fabricantes: FabricanteExport[];
};

/**
 * PURA: dados brutos → ficheiro final. Nenhuma ligação, nenhum
 * side-effect — o que permite testar toda a lógica de ordenação,
 * contagens e deteção de inconsistências sem base nenhuma.
 */
export function construirExport(input: {
  tenant: string;
  base: string;
  produtos: readonly ProdutoBruto[];
  fabricantes: readonly FabricanteBruto[];
  geradoEm?: string;
}): ExportProdutosFabricantesGarantia {
  const fabricantesPorId = new Map(input.fabricantes.map((f) => [f.id, f]));

  const inconsistencias: string[] = [];

  // ── CNP: em falta, repetido, ou repetido com fabricantes diferentes ──
  const produtosSemCnpLista = input.produtos.filter((p) => p.cnp === null || !Number.isFinite(p.cnp));
  if (produtosSemCnpLista.length > 0) {
    inconsistencias.push(`${produtosSemCnpLista.length} produto(s) sem CNP válido (Produto.cnp é NOT NULL no schema — não deveria acontecer)`);
  }

  const porCnp = new Map<number, ProdutoBruto[]>();
  for (const p of input.produtos) {
    if (p.cnp === null || !Number.isFinite(p.cnp)) continue;
    const lista = porCnp.get(p.cnp) ?? [];
    lista.push(p);
    porCnp.set(p.cnp, lista);
  }
  let cnpRepetidos = 0;
  let cnpComFabricantesDiferentes = 0;
  for (const [, lista] of porCnp) {
    if (lista.length > 1) {
      cnpRepetidos++;
      const fabricantesDistintos = new Set(lista.map((p) => p.fabricanteId ?? "(sem fabricante)"));
      if (fabricantesDistintos.size > 1) cnpComFabricantesDiferentes++;
    }
  }
  if (cnpRepetidos > 0) inconsistencias.push(`${cnpRepetidos} CNP repetido(s) entre os produtos exportados`);
  if (cnpComFabricantesDiferentes > 0) {
    inconsistencias.push(`${cnpComFabricantesDiferentes} CNP associado(s) a mais de um fabricante em simultâneo`);
  }

  // ── fabricanteId que não corresponde a nenhum Fabricante exportado ──
  const orfaos = input.produtos.filter((p) => p.fabricanteId !== null && !fabricantesPorId.has(p.fabricanteId));
  if (orfaos.length > 0) {
    inconsistencias.push(`${orfaos.length} produto(s) com fabricanteId que não corresponde a nenhum fabricante exportado`);
  }

  // ── Produtos (ordenados por cnp, depois id) ───────────────────────
  const produtos: ProdutoExport[] = input.produtos
    .map((p) => {
      const fab = p.fabricanteId ? fabricantesPorId.get(p.fabricanteId) : undefined;
      return {
        id: p.id,
        cnp: p.cnp,
        designacao: p.designacao,
        estado: p.estado,
        validadoManualmente: p.validadoManualmente,
        fabricanteId: p.fabricanteId,
        fabricanteNomeNormalizado: fab?.nomeNormalizado ?? null,
        fabricanteEstado: fab?.estado ?? null,
      };
    })
    .sort((a, b) => {
      const cnpA = a.cnp ?? Number.POSITIVE_INFINITY;
      const cnpB = b.cnp ?? Number.POSITIVE_INFINITY;
      if (cnpA !== cnpB) return cnpA - cnpB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  // ── Fabricantes (ordenados por nomeNormalizado, depois id) ────────
  const produtosPorFabricanteId = new Map<string, number>();
  for (const p of input.produtos) {
    if (!p.fabricanteId) continue;
    produtosPorFabricanteId.set(p.fabricanteId, (produtosPorFabricanteId.get(p.fabricanteId) ?? 0) + 1);
  }

  const fabricantes: FabricanteExport[] = input.fabricantes
    .map((f) => ({
      id: f.id,
      nomeNormalizado: f.nomeNormalizado,
      estado: f.estado,
      aliases: Array.from(new Set(f.aliases)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      produtosAssociados: produtosPorFabricanteId.get(f.id) ?? 0,
    }))
    .sort((a, b) => {
      if (a.nomeNormalizado !== b.nomeNormalizado) return a.nomeNormalizado < b.nomeNormalizado ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const fabricantesReferenciados = new Set(input.produtos.map((p) => p.fabricanteId).filter((id): id is string => id !== null)).size;
  const produtosComFabricanteExportados = input.produtos.filter((p) => p.fabricanteId !== null).length;
  const diferenca = produtosComFabricanteExportados - PRODUTOS_ASSOCIADOS_RELATORIO_ANTERIOR;

  const resumo: ResumoExport = {
    totalProdutos: input.produtos.length,
    produtosComCnp: input.produtos.length - produtosSemCnpLista.length,
    produtosSemCnp: produtosSemCnpLista.length,
    cnpDistintos: porCnp.size,
    cnpRepetidos,
    cnpComFabricantesDiferentes,
    produtosComFabricante: produtosComFabricanteExportados,
    produtosSemFabricante: input.produtos.length - produtosComFabricanteExportados,
    fabricantesExportados: input.fabricantes.length,
    fabricantesReferenciados,
    fabricantesAtivos: input.fabricantes.filter((f) => f.estado === "ATIVO").length,
    fabricantesInativos: input.fabricantes.filter((f) => f.estado === "INATIVO").length,
    produtosValidadosManualmente: input.produtos.filter((p) => p.validadoManualmente).length,
    comparacaoRelatorioAnterior: {
      produtosAssociadosRelatorioAnterior: PRODUTOS_ASSOCIADOS_RELATORIO_ANTERIOR,
      produtosComFabricanteExportados,
      diferenca,
      nota:
        diferenca === 0
          ? "Sem diferença face ao relatório de fabricantes anterior."
          : `${diferenca > 0 ? "+" : ""}${diferenca} produto(s) associados a fabricante face ao relatório anterior (${PRODUTOS_ASSOCIADOS_RELATORIO_ANTERIOR}) — ` +
            `a fotografia é diferente (produtos criados/removidos ou fabricanteId alterado entretanto); não é usado como motivo para abortar este export.`,
    },
    inconsistencias,
    totalInconsistencias: inconsistencias.length,
  };

  return {
    schemaVersion: 1,
    geradoEm: input.geradoEm ?? new Date().toISOString(),
    tenant: "garantia",
    base: input.base,
    readOnly: true,
    camposUtilizados: CAMPOS_UTILIZADOS,
    resumo,
    produtos,
    fabricantes,
  };
}

/** Escreve para um `.tmp` no mesmo diretório e só depois faz rename atómico — nunca deixa um output parcial no caminho final. */
export function escreverAtomico(caminhoFinal: string, conteudo: string): void {
  mkdirSync(dirname(caminhoFinal), { recursive: true });
  const tmp = `${caminhoFinal}.tmp-${process.pid}`;
  writeFileSync(tmp, conteudo, "utf8");
  try {
    renameSync(tmp, caminhoFinal);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  let alvo: AlvoDb;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n[fatal] ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  confirmarAlvoGarantia(alvo);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    // Sem excepção e sem opção que o desligue: este script só lê.
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

    console.log("═".repeat(78));
    console.log("Exportador de produtos e fabricantes — tenant garantia");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}   (READ ONLY — não escreve nada)`);
    console.log(`  Output: ${args.output}`);

    // Cast estrutural: PrismaClient real tem `findMany` com overloads genéricos
    // (SelectSubset<T, ...>) que o TypeScript não unifica com a interface
    // estreita PrismaSoLeitura — a interface existe só para poder passar um
    // Prisma FALSO nos testes; o Prisma real continua só a chamar findMany.
    const { produtos, fabricantes } = await buscarDados(prisma as unknown as PrismaSoLeitura);

    const relatorio = construirExport({ tenant: args.tenant, base: alvo.base, produtos, fabricantes });

    if (relatorio.produtos.length === 0) {
      console.error("\n[fatal] Zero produtos exportados — output vazio recusado. Confirma o tenant e a base antes de repetir.");
      process.exitCode = 1;
      return;
    }

    escreverAtomico(args.output, JSON.stringify(relatorio, null, 2));

    console.log(`\n${"─".repeat(78)}`);
    console.log("Resumo:");
    console.log(`  Produtos:                        ${relatorio.resumo.totalProdutos}`);
    console.log(`  Produtos com CNP:                 ${relatorio.resumo.produtosComCnp}`);
    console.log(`  Produtos sem CNP:                 ${relatorio.resumo.produtosSemCnp}`);
    console.log(`  CNP distintos:                    ${relatorio.resumo.cnpDistintos}`);
    console.log(`  CNP repetidos:                     ${relatorio.resumo.cnpRepetidos}`);
    console.log(`  CNP com fabricantes diferentes:   ${relatorio.resumo.cnpComFabricantesDiferentes}`);
    console.log(`  Produtos com fabricante:           ${relatorio.resumo.produtosComFabricante}`);
    console.log(`  Produtos sem fabricante:           ${relatorio.resumo.produtosSemFabricante}`);
    console.log(`  Fabricantes exportados:            ${relatorio.resumo.fabricantesExportados}`);
    console.log(`  Fabricantes referenciados:         ${relatorio.resumo.fabricantesReferenciados}`);
    console.log(`  Fabricantes ativos:                ${relatorio.resumo.fabricantesAtivos}`);
    console.log(`  Fabricantes inativos:              ${relatorio.resumo.fabricantesInativos}`);
    console.log(`  Produtos validados manualmente:    ${relatorio.resumo.produtosValidadosManualmente}`);
    console.log(`  ${relatorio.resumo.comparacaoRelatorioAnterior.nota}`);
    if (relatorio.resumo.inconsistencias.length > 0) {
      console.log(`\n  Inconsistências (${relatorio.resumo.totalInconsistencias}):`);
      for (const i of relatorio.resumo.inconsistencias) console.log(`    - ${i}`);
    } else {
      console.log(`\n  Nenhuma inconsistência detetada.`);
    }
    console.log(`\n✔  Exportado para ${args.output}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]export-produtos-fabricantes-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
