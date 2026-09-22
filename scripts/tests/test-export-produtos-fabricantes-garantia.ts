/**
 * scripts/tests/test-export-produtos-fabricantes-garantia.ts
 *
 * Lógica pura de scripts/export-produtos-fabricantes-garantia.ts — sem
 * BD viva. Prova: tenant/base travados a garantia, só operações de
 * leitura no Prisma (nenhuma escrita em dry-run/export — não há sequer
 * modo de escrita), serialização determinística, deteção de CNP em
 * falta/repetido/repetido-com-fabricantes-diferentes, fabricante nulo
 * contabilizado, aliases sem duplicação, escrita atómica (um ficheiro
 * incompleto nunca substitui um relatório válido anterior), e ausência
 * de campos comerciais/sensíveis no que é exportado.
 *
 * Corre com: npx tsx scripts/tests/test-export-produtos-fabricantes-garantia.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_ESPERADA,
  CAMPOS_UTILIZADOS,
  PRODUTOS_ASSOCIADOS_RELATORIO_ANTERIOR,
  TENANT_TRAVADO,
  buscarDados,
  confirmarAlvoGarantia,
  construirExport,
  escreverAtomico,
  parseArgs,
  type FabricanteBruto,
  type PrismaSoLeitura,
  type ProdutoBruto,
} from "../export-produtos-fabricantes-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

function produto(over: Partial<ProdutoBruto> & Pick<ProdutoBruto, "id" | "cnp">): ProdutoBruto {
  return {
    designacao: `PRODUTO ${over.id}`,
    estado: "VALIDADO",
    validadoManualmente: false,
    fabricanteId: null,
    ...over,
  };
}
function fabricante(over: Partial<FabricanteBruto> & Pick<FabricanteBruto, "id" | "nomeNormalizado">): FabricanteBruto {
  return { estado: "ATIVO", aliases: [], ...over };
}

console.log("A · parseArgs — tenant travado a garantia");
{
  let lancou = false;
  let msg = "";
  try {
    parseArgs(["--tenant=silveira", "--output=/tmp/x.json"]);
  } catch (err) {
    lancou = true;
    msg = err instanceof Error ? err.message : String(err);
  }
  check(lancou, "A1: --tenant=silveira é recusado");
  check(msg.includes(TENANT_TRAVADO), "A2: a mensagem menciona o tenant travado", msg);
}
{
  let lancou = false;
  try {
    parseArgs(["--tenant=garantia"]);
  } catch {
    lancou = true;
  }
  check(lancou, "A3: falta --output= é recusado");
}
{
  let lancou = false;
  try {
    parseArgs(["--tenant=garantia", "--output="]);
  } catch {
    lancou = true;
  }
  check(lancou, "A4: --output= vazio é recusado");
}
{
  const args = parseArgs(["--tenant=garantia", "--output=/relatorios/x.json"]);
  eq(args, { tenant: "garantia", output: "/relatorios/x.json" }, "A5: --tenant=garantia com --output= válido é aceite");
}
{
  let lancou = false;
  try {
    parseArgs(["--tenant=garantia", "--output=/x.json", "--apply"]);
  } catch {
    lancou = true;
  }
  check(lancou, "A6: argumento desconhecido (ex.: --apply, que nem existe aqui) é recusado");
}

console.log("\nB · confirmarAlvoGarantia — segunda trava, DEPOIS de resolverAlvo");
{
  let lancou = false;
  try {
    confirmarAlvoGarantia({ tenant: "silveira", base: BASE_ESPERADA });
  } catch {
    lancou = true;
  }
  check(lancou, "B1: tenant resolvido diferente de garantia é recusado, mesmo com a base certa");
}
{
  let lancou = false;
  let msg = "";
  try {
    confirmarAlvoGarantia({ tenant: "garantia", base: "spharmmt_t_outra" });
  } catch (err) {
    lancou = true;
    msg = err instanceof Error ? err.message : String(err);
  }
  check(lancou, "B2: base resolvida diferente de spharmmt_t_garantia é recusada, mesmo com o tenant certo");
  check(msg.includes(BASE_ESPERADA), "B3: a mensagem menciona a base esperada", msg);
}
{
  let lancou = false;
  try {
    confirmarAlvoGarantia({ tenant: "garantia", base: BASE_ESPERADA });
  } catch {
    lancou = true;
  }
  check(!lancou, "B4: tenant garantia + base spharmmt_t_garantia passa");
}

console.log("\nE · o próprio ficheiro nunca escreve — verificação estática do código-fonte");
{
  const src = readFileSync(new URL("../export-produtos-fabricantes-garantia.ts", import.meta.url), "utf8");
  const codigo = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");

  check(/resolverAlvo\s*\(/.test(codigo), "E1: usa resolverAlvo (lib/catalog/target-db.ts)");
  check(!/process\.env\.DATABASE_URL/.test(codigo), "E2: NÃO lê DATABASE_URL genérico");
  check(/connectionString:\s*alvo\.url/.test(codigo), "E3: liga-se com a URL resolvida (alvo.url)");
  check(/descreverAlvo\(alvo\)/.test(codigo), "E4: imprime o destino antes de trabalhar");
  check(
    /default_transaction_read_only = on/.test(codigo) && !/default_transaction_read_only = off/.test(codigo),
    "E5: a sessão é posta em read-only, sempre — nenhum caminho a desliga",
  );
  for (const escrita of [".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(", ".delete(", ".deleteMany("]) {
    check(!codigo.includes(escrita), `E6: nenhuma chamada de escrita Prisma (${escrita}) no ficheiro`);
  }
  const chamadasExecuteRaw = codigo.match(/\$execute(Raw|RawUnsafe)\s*\(/g) ?? [];
  eq(chamadasExecuteRaw.length, 1, "E7: exactamente UMA chamada $executeRaw* no ficheiro inteiro");
  check(
    /\$executeRawUnsafe\("set session default_transaction_read_only = on"\)/.test(codigo),
    "E8: essa única chamada é a que põe a sessão em read-only — nada mais",
  );
  check(!/--apply/.test(codigo), "E9: não existe sequer a string --apply — não há modo de escrita nenhum");
  // Os únicos campos pedidos ao Prisma são os whitelisted — nada de stocks/vendas/preços/clientes/farmácias.
  const blocosSelect = codigo.match(/select:\s*\{[^}]*\}/g) ?? [];
  check(blocosSelect.length >= 2, "E10 (pré-condição): há pelo menos 2 blocos select no ficheiro");
  const proibidos = /stock|venda|preco|price|cliente|farmacia|senha|password|credential/i;
  check(blocosSelect.every((b) => !proibidos.test(b)), "E11: nenhum bloco select pede stocks/vendas/preços/clientes/farmácias/credenciais");
}

console.log("\nF · construirExport — CNP em falta, repetido, e repetido com fabricantes diferentes");
{
  const fabA = fabricante({ id: "fA", nomeNormalizado: "FABRICANTE A" });
  const fabB = fabricante({ id: "fB", nomeNormalizado: "FABRICANTE B" });
  const produtos: ProdutoBruto[] = [
    produto({ id: "p1", cnp: 100, fabricanteId: "fA" }),
    produto({ id: "p2", cnp: null }), // sem CNP
    produto({ id: "p3", cnp: 200, fabricanteId: "fA" }),
    produto({ id: "p4", cnp: 200, fabricanteId: "fB" }), // mesmo CNP 200, fabricante diferente de p3
    produto({ id: "p5", cnp: 300, fabricanteId: "fA" }),
    produto({ id: "p6", cnp: 300, fabricanteId: "fA" }), // CNP 300 repetido, MESMO fabricante
  ];
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos, fabricantes: [fabA, fabB], geradoEm: "2026-01-01T00:00:00.000Z" });

  eq(rel.resumo.totalProdutos, 6, "F1: total de produtos");
  eq(rel.resumo.produtosSemCnp, 1, "F2: 1 produto sem CNP detectado");
  check(rel.resumo.inconsistencias.some((i) => i.includes("sem CNP válido")), "F3: inconsistência de CNP em falta reportada");
  eq(rel.resumo.cnpDistintos, 3, "F4: 3 CNP distintos (100, 200, 300) — o produto sem CNP não conta");
  eq(rel.resumo.cnpRepetidos, 2, "F5: 2 CNP repetidos (200 e 300)");
  check(rel.resumo.inconsistencias.some((i) => i.includes("CNP repetido")), "F6: inconsistência de CNP repetido reportada");
  eq(rel.resumo.cnpComFabricantesDiferentes, 1, "F7: só o CNP 200 tem fabricantes diferentes — o 300 tem o mesmo fabricante nas duas linhas");
  check(rel.resumo.inconsistencias.some((i) => i.includes("mais de um fabricante")), "F8: inconsistência de CNP com fabricantes diferentes reportada");
}

console.log("\nG · construirExport — fabricante nulo é contabilizado, produto referencia por ID");
{
  const produtos: ProdutoBruto[] = [
    produto({ id: "p1", cnp: 1, fabricanteId: null }),
    produto({ id: "p2", cnp: 2, fabricanteId: "fA" }),
  ];
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos, fabricantes: [fabricante({ id: "fA", nomeNormalizado: "FABRICANTE A" })] });
  eq(rel.resumo.produtosSemFabricante, 1, "G1: 1 produto sem fabricante contabilizado");
  eq(rel.resumo.produtosComFabricante, 1, "G2: 1 produto com fabricante contabilizado");
  const p1 = rel.produtos.find((p) => p.id === "p1")!;
  eq(p1.fabricanteId, null, "G3: produto sem fabricante tem fabricanteId null");
  eq(p1.fabricanteNomeNormalizado, null, "G4: produto sem fabricante tem fabricanteNomeNormalizado null");
  const p2 = rel.produtos.find((p) => p.id === "p2")!;
  eq(p2.fabricanteId, "fA", "G5: produto referencia o fabricante por ID");
  eq(p2.fabricanteNomeNormalizado, "FABRICANTE A", "G6: denominação atual do fabricante vem incluída no produto");
}

console.log("\nH · construirExport — fabricanteId órfão (sem Fabricante correspondente exportado)");
{
  const produtos: ProdutoBruto[] = [produto({ id: "p1", cnp: 1, fabricanteId: "nao-existe" })];
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos, fabricantes: [] });
  check(rel.resumo.inconsistencias.some((i) => i.includes("não corresponde a nenhum fabricante")), "H1: fabricanteId órfão é reportado como inconsistência");
  const p1 = rel.produtos[0]!;
  eq(p1.fabricanteId, "nao-existe", "H2: o ID é preservado tal-qual, mesmo órfão (transparência)");
  eq(p1.fabricanteNomeNormalizado, null, "H3: mas a denominação fica null — não existe fabricante para a dar");
}

console.log("\nI · construirExport — aliases sem duplicação, ordenados alfabeticamente");
{
  const fab = fabricante({ id: "fA", nomeNormalizado: "FABRICANTE A", aliases: ["ZETA", "ALPHA", "ALPHA", "BETA"] });
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos: [], fabricantes: [fab] });
  eq(rel.fabricantes[0]!.aliases, ["ALPHA", "BETA", "ZETA"], "I1: aliases deduplicados e ordenados alfabeticamente");
}

console.log("\nJ · construirExport — ordenação determinística (produtos por cnp/id, fabricantes por nome/id)");
{
  const produtos: ProdutoBruto[] = [
    produto({ id: "pz", cnp: 50 }),
    produto({ id: "pa", cnp: 10 }),
    produto({ id: "pb", cnp: 10 }), // mesmo cnp de pa, desempate por id
  ];
  const fabricantes: FabricanteBruto[] = [
    fabricante({ id: "f2", nomeNormalizado: "ZETA FARMA" }),
    fabricante({ id: "f1", nomeNormalizado: "ALPHA FARMA" }),
  ];
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos, fabricantes });
  eq(rel.produtos.map((p) => p.id), ["pa", "pb", "pz"], "J1: produtos ordenados por cnp e depois id");
  eq(rel.fabricantes.map((f) => f.id), ["f1", "f2"], "J2: fabricantes ordenados por nomeNormalizado");
}

console.log("\nK · construirExport — serialização determinística (mesma entrada, ordens diferentes → mesmo JSON)");
{
  const produtosA: ProdutoBruto[] = [produto({ id: "p2", cnp: 20, fabricanteId: "f1" }), produto({ id: "p1", cnp: 10, fabricanteId: "f2" })];
  const produtosB: ProdutoBruto[] = [...produtosA].reverse();
  const fabricantesA: FabricanteBruto[] = [
    fabricante({ id: "f2", nomeNormalizado: "B FARMA", aliases: ["Y", "X"] }),
    fabricante({ id: "f1", nomeNormalizado: "A FARMA", aliases: ["X", "Y"] }),
  ];
  const fabricantesB: FabricanteBruto[] = [...fabricantesA].reverse();

  const relA = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos: produtosA, fabricantes: fabricantesA, geradoEm: "2026-01-01T00:00:00.000Z" });
  const relB = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos: produtosB, fabricantes: fabricantesB, geradoEm: "2026-01-01T00:00:00.000Z" });

  eq(JSON.stringify(relA), JSON.stringify(relB), "K1: input em ordens diferentes produz exactamente o mesmo JSON");
}

console.log("\nL · camposUtilizados — documenta os nomes reais do schema");
{
  eq(CAMPOS_UTILIZADOS.codigoProduto, "Produto.cnp", "L1: codigoProduto aponta para Produto.cnp");
  eq(CAMPOS_UTILIZADOS.nomeProduto, "Produto.designacao", "L2: nomeProduto aponta para Produto.designacao");
  check(CAMPOS_UTILIZADOS.fabricante.includes("Fabricante"), "L3: fabricante documenta a relação real");
}

console.log("\nM · comparação com o relatório de fabricantes anterior — informativa, nunca aborta");
{
  eq(PRODUTOS_ASSOCIADOS_RELATORIO_ANTERIOR, 33_553, "M1: constante do relatório anterior é 33 553");
  const produtos: ProdutoBruto[] = [produto({ id: "p1", cnp: 1, fabricanteId: "fA" })];
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos, fabricantes: [fabricante({ id: "fA", nomeNormalizado: "FABRICANTE A" })] });
  eq(rel.resumo.comparacaoRelatorioAnterior.diferenca, 1 - 33_553, "M2: diferença calculada correctamente (não é usada para abortar)");
  check(rel.resumo.comparacaoRelatorioAnterior.nota.length > 0, "M3: a nota explica a diferença em texto");
}

console.log("\nN · não são exportados campos comerciais ou dados sensíveis — nas CHAVES dos objectos exportados");
{
  const produtos: ProdutoBruto[] = [produto({ id: "p1", cnp: 1, fabricanteId: "fA" })];
  const rel = construirExport({ tenant: "garantia", base: BASE_ESPERADA, produtos, fabricantes: [fabricante({ id: "fA", nomeNormalizado: "FABRICANTE A" })] });
  const chavesProduto = Object.keys(rel.produtos[0]!);
  const chavesFabricante = Object.keys(rel.fabricantes[0]!);
  const chavesResumo = Object.keys(rel.resumo);
  const proibidos = /stock|venda|preco|price|cliente|farmacia|senha|password|url|credential/i;
  check([...chavesProduto, ...chavesFabricante, ...chavesResumo].every((k) => !proibidos.test(k)), "N1: nenhuma chave exportada sugere dado comercial/sensível", JSON.stringify([...chavesProduto, ...chavesFabricante, ...chavesResumo]));
}

console.log("\nO · escreverAtomico — escreve com sucesso, e um ficheiro incompleto NUNCA substitui um relatório válido anterior");
{
  const dir = mkdtempSync(join(tmpdir(), "export-garantia-test-"));
  try {
    const destino = join(dir, "relatorio.json");
    escreverAtomico(destino, JSON.stringify({ ok: true }));
    check(existsSync(destino), "O1: o ficheiro final existe depois de um escreverAtomico bem sucedido");
    eq(JSON.parse(readFileSync(destino, "utf8")), { ok: true }, "O2: o conteúdo é exactamente o escrito");
    const sobrasTmp = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    eq(sobrasTmp, [], "O3: nenhum ficheiro .tmp-* fica para trás depois de um sucesso");

    // Simula uma escrita que falha DEPOIS do conteúdo estar completo em
    // memória, mas ANTES do rename atómico substituir o destino: o alvo é
    // um DIRECTÓRIO existente (representa "já havia um relatório válido
    // aqui"), o que faz o rename falhar — a função tem de propagar o erro
    // e nunca deixar o `.tmp` para trás nem tocar no directório.
    const destinoOcupado = join(dir, "relatorio-anterior.json");
    mkdirSync(destinoOcupado); // um "relatório anterior" que não pode ser substituído por um rename de ficheiro
    let lancou = false;
    try {
      escreverAtomico(destinoOcupado, JSON.stringify({ novo: "incompleto" }));
    } catch {
      lancou = true;
    }
    check(lancou, "O4: uma falha no rename propaga-se (não é engolida)");
    check(existsSync(destinoOcupado) && readdirSync(destinoOcupado).length === 0, "O5: o 'relatório anterior' continua intacto — nunca foi substituído");
    const sobrasTmp2 = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    eq(sobrasTmp2, [], "O6: o .tmp da tentativa falhada foi limpo, não ficou para trás");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════
// Secções C/D — as únicas que chamam buscarDados (async) — correm por
// último, dentro de uma função, para não depender de top-level await
// (o resto do ficheiro é síncrono de propósito, mesma convenção de
// test-fabricante-normalizacao-batch.ts).
// ══════════════════════════════════════════════════════════════════════
async function principal(): Promise<void> {
  console.log("\nC · buscarDados — só findMany é chamado, e a paginação por cursor funciona");
  {
    const chamadas: string[] = [];
    const produtosNaBase: ProdutoBruto[] = Array.from({ length: 5 }, (_, i) => produto({ id: `p${i}`, cnp: 1000 + i }));
    const fakePrisma: PrismaSoLeitura = {
      produto: {
        findMany: async (args) => {
          chamadas.push("produto.findMany");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = args as any;
          const cursorId: string | undefined = a.cursor?.id;
          const startIdx = cursorId ? produtosNaBase.findIndex((p) => p.id === cursorId) + 1 : 0;
          return produtosNaBase.slice(startIdx, startIdx + a.take);
        },
      },
      fabricante: {
        findMany: async () => {
          chamadas.push("fabricante.findMany");
          return [];
        },
      },
    };
    const { produtos, fabricantes } = await buscarDados(fakePrisma);
    eq(produtos.length, 5, "C1: buscarDados devolve todos os produtos, paginados");
    eq(fabricantes.length, 0, "C2: buscarDados devolve os fabricantes");
    check(chamadas.every((c) => c === "produto.findMany" || c === "fabricante.findMany"), "C3: só produto.findMany/fabricante.findMany foram chamados");
    check(chamadas.includes("produto.findMany") && chamadas.includes("fabricante.findMany"), "C4: ambos foram mesmo chamados");
  }

  console.log("\nD · buscarDados — sem chamadas nenhuma se as queries estiverem vazias, e nenhuma escrita é sequer definida no fake");
  {
    // O fake nem tem create/update/delete definidos — se o código de produção
    // alguma vez os chamasse, isto rebentaria com "not a function", não passaria em silêncio.
    const fakePrisma: PrismaSoLeitura = {
      produto: { findMany: async () => [] },
      fabricante: { findMany: async () => [] },
    };
    const { produtos, fabricantes } = await buscarDados(fakePrisma);
    eq(produtos, [], "D1: zero produtos na base → array vazio, sem excepção");
    eq(fabricantes, [], "D2: zero fabricantes na base → array vazio, sem excepção");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
