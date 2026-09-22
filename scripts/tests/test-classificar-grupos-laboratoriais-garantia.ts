/**
 * scripts/tests/test-classificar-grupos-laboratoriais-garantia.ts
 *
 * Testa scripts/classificar-grupos-laboratoriais-garantia.ts — trava ao
 * tenant garantia (dupla camada), TIPOS_APLICAVEIS_AUTOMATICAMENTE (só
 * os 3 níveis seguros, nunca proposta_snapshot_cnp), escrita atómica, e
 * — por verificação estática do código-fonte — que nada neste ficheiro
 * escreve `Produto.fabricanteId` nem `Fabricante`, mesmo em `--apply`.
 *
 * Corre com: npx tsx scripts/tests/test-classificar-grupos-laboratoriais-garantia.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TENANT_TRAVADO,
  BASE_ESPERADA,
  parseArgs,
  confirmarAlvoGarantia,
  TIPOS_APLICAVEIS_AUTOMATICAMENTE,
  escreverAtomico,
} from "../classificar-grupos-laboratoriais-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

console.log("A · parseArgs");
{
  let lancou = false;
  try { parseArgs(["--tenant=garantia"]); } catch { lancou = true; }
  check(lancou, "A1: falta --relatorio= é recusado");
}
{
  const args = parseArgs(["--tenant=garantia", "--relatorio=/x.json"]);
  eq(args.relatorioPath, "/x.json", "A2: --relatorio= correcto");
  eq(args.apply, false, "A3: --apply default false (dry-run)");
}
{
  const args = parseArgs(["--tenant=garantia", "--relatorio=/x.json", "--apply"]);
  eq(args.apply, true, "A4: --apply reconhecido");
}

console.log("\nB · confirmarAlvoGarantia — segunda trava, depois de resolverAlvo");
{
  eq(TENANT_TRAVADO, "garantia", "B1: tenant travado é garantia");
  eq(BASE_ESPERADA, "spharmmt_t_garantia", "B2: base esperada correcta");
  let lancou = false;
  try { confirmarAlvoGarantia({ tenant: "silveira", base: BASE_ESPERADA }); } catch { lancou = true; }
  check(lancou, "B3: tenant resolvido diferente de garantia é recusado");
}
{
  let lancou = false;
  try { confirmarAlvoGarantia({ tenant: "garantia", base: "spharmmt_t_outra" }); } catch { lancou = true; }
  check(lancou, "B4: base resolvida diferente da esperada é recusada");
}
{
  let lancou = false;
  try { confirmarAlvoGarantia({ tenant: "garantia", base: BASE_ESPERADA }); } catch { lancou = true; }
  check(!lancou, "B5: tenant + base correctos passam");
}

console.log("\nC · TIPOS_APLICAVEIS_AUTOMATICAMENTE — só os 3 níveis seguros, NUNCA proposta_snapshot_cnp");
{
  check(TIPOS_APLICAVEIS_AUTOMATICAMENTE.has("regra_cnp"), "C1: regra_cnp é aplicável");
  check(TIPOS_APLICAVEIS_AUTOMATICAMENTE.has("fabricante_inequivoco"), "C2: fabricante_inequivoco é aplicável");
  check(TIPOS_APLICAVEIS_AUTOMATICAMENTE.has("alias_inequivoco"), "C3: alias_inequivoco é aplicável");
  check(!TIPOS_APLICAVEIS_AUTOMATICAMENTE.has("proposta_snapshot_cnp"), "C4: proposta_snapshot_cnp NUNCA é aplicável automaticamente (nível 4 é só proposta)");
  check(!TIPOS_APLICAVEIS_AUTOMATICAMENTE.has("sem_grupo"), "C5: sem_grupo nunca é 'aplicável'");
  check(!TIPOS_APLICAVEIS_AUTOMATICAMENTE.has("mantido_manual"), "C6: mantido_manual não precisa de reaplicação (já está correcto)");
  eq(TIPOS_APLICAVEIS_AUTOMATICAMENTE.size, 3, "C7: exactamente 3 tipos aplicáveis");
}

console.log("\nD · escreverAtomico — mesmo contrato do exportador: sucesso limpo, falha nunca substitui um relatório anterior");
{
  const dir = mkdtempSync(join(tmpdir(), "classificar-grupos-teste-"));
  try {
    const destino = join(dir, "relatorio.json");
    escreverAtomico(destino, JSON.stringify({ ok: true }));
    check(existsSync(destino), "D1: ficheiro final existe após sucesso");
    eq(JSON.parse(readFileSync(destino, "utf8")), { ok: true }, "D2: conteúdo correcto");
    eq(readdirSync(dir).filter((f) => f.includes(".tmp-")), [], "D3: nenhum .tmp- sobra após sucesso");

    const destinoOcupado = join(dir, "anterior.json");
    mkdirSync(destinoOcupado);
    let lancou = false;
    try { escreverAtomico(destinoOcupado, JSON.stringify({ novo: "incompleto" })); } catch { lancou = true; }
    check(lancou, "D4: falha no rename propaga-se");
    check(existsSync(destinoOcupado) && readdirSync(destinoOcupado).length === 0, "D5: o 'relatório anterior' nunca é substituído por um incompleto");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nE · verificação estática — este ficheiro NUNCA escreve Produto.fabricanteId nem Fabricante, mesmo em --apply");
{
  const src = readFileSync(new URL("../classificar-grupos-laboratoriais-garantia.ts", import.meta.url), "utf8");
  const codigo = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");

  check(!/\.fabricante\.update\(|\.fabricante\.create\(|\.fabricante\.upsert\(/.test(codigo), "E1: nenhuma escrita em Fabricante");
  check(!/\.produto\.update\(|\.produto\.updateMany\(/.test(codigo), "E2: nenhuma escrita em Produto (nem fabricanteId nem qualquer outro campo)");
  check(!/fabricanteId\s*:\s*[^,}]+,?\s*(\/\/.*)?$/m.test(codigo.split("produtoGrupoLaboratorial")[0] ?? ""), "E3 (heurística): sem atribuição a fabricanteId antes de qualquer uso de produtoGrupoLaboratorial");
  check(/produtoGrupoLaboratorial\.upsert\(/.test(codigo), "E4: a única escrita real é produtoGrupoLaboratorial.upsert");
  check(
    /default_transaction_read_only = \$\{\s*dryRun \? "on" : "off"\s*\}/.test(codigo) || (/default_transaction_read_only = on/.test(codigo) && !/default_transaction_read_only = off/.test(codigo)),
    "E5: sessão read-only condicional ao modo (mesmo padrão dos outros scripts desta iniciativa)",
  );
  check(/TIPOS_APLICAVEIS_AUTOMATICAMENTE\.has/.test(codigo), "E6: o apply filtra explicitamente pelos tipos seguros antes de escrever");
}

async function principal() {
  console.log("\nF · classificarGruposLaboratoriais com VOLUME (450 produtos, > 2 lotes de 200) — múltiplas transacções curtas, nunca uma única gigante");
  {
    // Regressão do bug real encontrado no ensaio de volume Docker
    // (2026-09-23): uma única transacção interactive envolvendo todos os
    // upserts excedia o timeout DEFAULT do Prisma (5000ms) com ~3400
    // produtos reais — corrigido para lotes de 200, cada um na sua
    // transacção. Este teste prova, com um Prisma falso, que
    // $transaction é chamado MAIS DE UMA VEZ para um volume que excede
    // um lote, e que TODOS os produtos aplicáveis são escritos (nenhum
    // perdido entre lotes).
    const { classificarGruposLaboratoriais } = await import("../classificar-grupos-laboratoriais-garantia");

    const N = 450;
    const produtos = Array.from({ length: N }, (_, i) => ({ id: `p${i}`, cnp: i + 1, fabricanteId: `f${i % 5}`, camposManuais: [] }));
    const fabricantes = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, nomeNormalizado: `FABRICANTE ${i}` }));
    const gruposFabricante = fabricantes.map((f) => ({ fabricanteId: f.id, grupoLaboratorialId: "gTeste" })); // TODOS os fabricantes integrais → todos os 450 produtos são "fabricante_inequivoco"

    let chamadasTransaction = 0;
    const escritosNoFake = new Map<string, unknown>();
    const fakePrisma = {
      produto: { findMany: async () => produtos },
      fabricante: { findMany: async () => fabricantes },
      regraGrupoLaboratorialPorCnp: { findMany: async () => [] },
      grupoLaboratorialFabricante: { findMany: async () => gruposFabricante },
      grupoLaboratorialAlias: { findMany: async () => [] },
      produtoGrupoLaboratorial: { findMany: async () => [] },
      regulatoryRecord: { findMany: async () => [] },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => {
        chamadasTransaction++;
        const tx = {
          produtoGrupoLaboratorial: {
            upsert: async (args: { where: { produtoId: string }; create: unknown }) => {
              escritosNoFake.set(args.where.produtoId, args.create);
              return args.create;
            },
          },
        };
        return fn(tx);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const resultado = await classificarGruposLaboratoriais(fakePrisma, { apply: true });

    eq(resultado.grupos.fabricanteInequivoco, N, "F1: todos os 450 produtos classificam fabricante_inequivoco");
    eq(resultado.escritos, N, "F2: todos os 450 foram escritos");
    eq(escritosNoFake.size, N, "F3: 450 upserts realmente aconteceram no Prisma falso, nenhum perdido");
    check(chamadasTransaction >= 3, `F4: $transaction chamado ${chamadasTransaction} vezes — VÁRIAS transacções curtas (ceil(450/200)=3), nunca uma única`, `chamadasTransaction=${chamadasTransaction}`);
    check(chamadasTransaction === Math.ceil(N / 200), "F5: número exacto de lotes esperado (ceil(450/200)=3)", `chamadasTransaction=${chamadasTransaction}`);
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
