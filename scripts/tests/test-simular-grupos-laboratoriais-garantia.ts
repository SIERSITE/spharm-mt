/**
 * scripts/tests/test-simular-grupos-laboratoriais-garantia.ts
 *
 * Testa scripts/simular-grupos-laboratoriais-garantia.ts com amostras
 * SINTÉTICAS mínimas — nunca toca em .local-data. Prova: sem Prisma,
 * validação de config (contradições, exclusão Janssen/Kenvue),
 * streaming do catálogo, determinismo, e que os totais batem com as
 * entradas.
 *
 * Corre com: npx tsx scripts/tests/test-simular-grupos-laboratoriais-garantia.ts
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  validarConfig,
  construirMapasResolver,
  carregarCatalogoStreaming,
  escreverAtomico,
  TENANT_TRAVADO,
  type ConfigGruposIniciais,
  type FabricanteExportado,
} from "../simular-grupos-laboratoriais-garantia";
import { MARCADOR_FIM_REGISTO } from "../../lib/catalog/catalogo-nacional-parser";
import { resolverGruposEmLote, type ProdutoParaResolver } from "../../lib/catalog/resolver-grupo-laboratorial";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

console.log("A · parseArgs — travado ao tenant garantia, exige os 4 caminhos");
{
  eq(TENANT_TRAVADO, "garantia", "A1: tenant travado é garantia");
  let lancou = false;
  try { parseArgs(["--tenant=silveira", "--produtos=p", "--catalogo=c", "--config=cf", "--relatorio=r"]); } catch { lancou = true; }
  check(lancou, "A2: --tenant=silveira é recusado");
}
{
  let lancou = false;
  try { parseArgs(["--tenant=garantia", "--catalogo=c", "--config=cf", "--relatorio=r"]); } catch { lancou = true; }
  check(lancou, "A3: falta --produtos= é recusado");
}
{
  const args = parseArgs(["--tenant=garantia", "--produtos=p.json", "--catalogo=c.csv", "--config=cfg.json", "--relatorio=r.json"]);
  eq(args, { produtosPath: "p.json", catalogoPath: "c.csv", configPath: "cfg.json", relatorioPath: "r.json" }, "A4: parsing completo correcto");
}

console.log("\nB · validarConfig — detecta contradições estruturais");
{
  const configLimpa: ConfigGruposIniciais = {
    grupos: [
      { nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [{ alias: "Mylan", aliasNormalizado: "MYLAN" }], fabricantesIntegrais: ["Mylan Lda"] },
      { nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [{ alias: "JNTL", aliasNormalizado: "JNTL" }], fabricantesIntegrais: ["JNTL Consumer Health"] },
    ],
  };
  eq(validarConfig(configLimpa), [], "B1: config limpa → zero problemas");
}
{
  const configContraditoria: ConfigGruposIniciais = {
    grupos: [
      { nome: "GrupoA", nomeNormalizado: "GRUPOA", aliases: [], fabricantesIntegrais: ["Mesma Empresa Lda"] },
      { nome: "GrupoB", nomeNormalizado: "GRUPOB", aliases: [], fabricantesIntegrais: ["Mesma Empresa Lda"] },
      { nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [], fabricantesIntegrais: [] },
    ],
  };
  const problemas = validarConfig(configContraditoria);
  check(problemas.some((p) => p.tipo === "fabricante_integral_em_dois_grupos"), "B2: mesmo fabricante integral em dois grupos é detectado");
}
{
  const configComJanssenEmKenvue: ConfigGruposIniciais = {
    grupos: [{ nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [], fabricantesIntegrais: ["Janssen-Cilag Farmacêutica Lda"] }],
  };
  const problemas = validarConfig(configComJanssenEmKenvue);
  check(problemas.some((p) => p.tipo === "janssen_em_kenvue"), "B3: Janssen em fabricantesIntegrais do Kenvue é detectado — NUNCA passa despercebido");
}
{
  const configComJanssenComoAliasKenvue: ConfigGruposIniciais = {
    grupos: [{ nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [{ alias: "Janssen Consumer", aliasNormalizado: "JANSSEN CONSUMER" }], fabricantesIntegrais: [] }],
  };
  const problemas = validarConfig(configComJanssenComoAliasKenvue);
  check(problemas.some((p) => p.tipo === "janssen_em_kenvue"), "B4: Janssen como ALIAS do Kenvue também é detectado");
}
{
  const semKenvue: ConfigGruposIniciais = { grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: [] }] };
  const problemas = validarConfig(semKenvue);
  check(problemas.some((p) => p.tipo === "grupo_kenvue_em_falta"), "B5: sem grupo Kenvue nenhum, a verificação assinala em vez de assumir silenciosamente que está tudo bem");
}

console.log("\nC · construirMapasResolver — resolve fabricantesIntegrais contra fabricantes reais (re-normalizando os dois lados)");
{
  const config: ConfigGruposIniciais = {
    grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [{ alias: "Mylan", aliasNormalizado: "MYLAN" }], fabricantesIntegrais: ["Mylan, Lda."] }],
  };
  const fabricantes: FabricanteExportado[] = [
    { id: "f1", nomeNormalizado: "MYLAN LDA.", estado: "ATIVO", aliases: [], produtosAssociados: 5 }, // ponto final por limpar — tem de re-normalizar
    { id: "f2", nomeNormalizado: "OUTRA EMPRESA", estado: "ATIVO", aliases: [], produtosAssociados: 1 },
  ];
  const { mapas, fabricantesIntegraisResolvidos, fabricantesIntegraisNaoEncontrados } = construirMapasResolver(config, fabricantes);
  eq(fabricantesIntegraisResolvidos.get("g0")?.length, 1, "C1: 1 fabricante integral resolvido, apesar do ponto final não limpo em garantia");
  eq(fabricantesIntegraisNaoEncontrados.get("g0"), [], "C2: nenhum fabricante integral por encontrar");
  eq(mapas.gruposFabricantePorFabricanteId.get("f1")?.grupoLaboratorialId, "g0", "C3: f1 mapeado ao grupo");
  check(!mapas.gruposFabricantePorFabricanteId.has("f2"), "C4: f2 (empresa não relacionada) NÃO mapeado");
}

async function principal() {
  console.log("\nD · carregarCatalogoStreaming — nunca lê o ficheiro inteiro para uma string só (streaming real)");
  {
    const dir = mkdtempSync(join(tmpdir(), "simular-grupos-teste-"));
    try {
      const path = join(dir, "catalogo.csv");
      function linha200(c: string) { return c.padEnd(200, " "); }
      function registo(cnp: string, estado: string, titular: string) {
        return linha200([cnp, "9999.99", "6", "1", "1", "1", "01-JAN-99", "01-JAN-20", "1", estado, "N", "Produto", titular, MARCADOR_FIM_REGISTO].join("(;)"));
      }
      const linhas = [registo("2000001", "Ativo", "Mylan, Lda."), registo("2000002", "Anulado", "Outra Empresa")];
      writeFileSync(path, linhas.join("\r\n") + "\r\n", "latin1");

      const { snapshotsPorCnp, totalRegistos, erros } = await carregarCatalogoStreaming(path);
      eq(totalRegistos, 2, "D1: 2 registos lidos");
      eq(erros, 0, "D2: sem erros");
      eq(snapshotsPorCnp.get(2000001)?.titularAim, "Mylan, Lda.", "D3: titular correcto");
      eq(snapshotsPorCnp.get(2000002)?.estadoAim, "Anulado", "D4: estado correcto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nE · determinismo — a mesma entrada produz sempre o mesmo resultado de classificação");
  {
    const fabricantes: FabricanteExportado[] = [{ id: "f1", nomeNormalizado: "MYLAN LDA", estado: "ATIVO", aliases: [], produtosAssociados: 1 }];
    const config: ConfigGruposIniciais = { grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: ["Mylan Lda"] }] };
    const produtos: ProdutoParaResolver[] = [
      { id: "p1", cnp: 1, fabricanteId: "f1" },
      { id: "p2", cnp: 2, fabricanteId: null },
    ];
    const { mapas: mapas1 } = construirMapasResolver(config, fabricantes);
    const r1 = resolverGruposEmLote(produtos, { ...mapas1, snapshotsPorCnp: new Map() });
    const { mapas: mapas2 } = construirMapasResolver(config, fabricantes);
    const r2 = resolverGruposEmLote([...produtos].reverse(), { ...mapas2, snapshotsPorCnp: new Map() });
    eq(JSON.stringify(r1.totais), JSON.stringify(r2.totais), "E1: totais idênticos independentemente da ordem de entrada");
  }

  console.log("\nF · totais batem com as entradas — nenhum produto perdido nem duplicado");
  {
    const fabricantes: FabricanteExportado[] = [{ id: "f1", nomeNormalizado: "MYLAN LDA", estado: "ATIVO", aliases: [], produtosAssociados: 1 }];
    const config: ConfigGruposIniciais = { grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: ["Mylan Lda"] }] };
    const produtos: ProdutoParaResolver[] = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, cnp: i, fabricanteId: i % 5 === 0 ? "f1" : null }));
    const { mapas } = construirMapasResolver(config, fabricantes);
    const relatorio = resolverGruposEmLote(produtos, { ...mapas, snapshotsPorCnp: new Map() });
    const somaOrigens = Object.values(relatorio.totais).reduce((a, b) => (typeof b === "number" && b !== relatorio.totais.produtos ? a + b : a), 0);
    eq(relatorio.totais.produtos, 50, "F1: total de produtos correcto");
    eq(relatorio.resultados.length, 50, "F2: nenhum produto perdido — 50 resultados para 50 produtos");
    eq(somaOrigens, 50, "F3: a soma de todas as origens bate exactamente com o total (nenhum produto contado 0 ou 2 vezes)");
  }

  console.log("\nG · escreverAtomico — mesmo contrato dos outros scripts desta iniciativa");
  {
    const dir = mkdtempSync(join(tmpdir(), "simular-grupos-teste-"));
    try {
      const destino = join(dir, "relatorio.json");
      escreverAtomico(destino, JSON.stringify({ ok: true }));
      eq(JSON.parse(readFileSync(destino, "utf8")), { ok: true }, "G1: conteúdo gravado correctamente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nH · verificação estática — o simulador NUNCA importa Prisma nem abre ligações");
  {
    const src = readFileSync(new URL("../simular-grupos-laboratoriais-garantia.ts", import.meta.url), "utf8");
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    check(!/PrismaClient|@prisma\/adapter-pg|resolverAlvo|getTenantBySlug|buildTenantConnectionString/.test(codigo), "H1: nenhuma referência a Prisma/control-plane/resolverAlvo no ficheiro inteiro");
    check(!/\$executeRaw|\$queryRaw|\.create\(|\.update\(|\.upsert\(/.test(codigo), "H2: nenhuma escrita/SQL — só readFileSync e o parser streaming");
    check(/createReadStream/.test(codigo), "H3: usa streaming (createReadStream) para o catálogo, não readFileSync");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
