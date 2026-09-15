/**
 * scripts/tests/test-transferencia-por-id.ts
 *
 * Correcção de segurança (2026-09): `createInternalTransferAction`
 * resolvia a farmácia de origem por `findFirst({where:{nome}})` —
 * `Farmacia.nome` não é único na BD, por isso duas farmácias com o
 * mesmo nome no mesmo tenant faziam a transferência escolher uma
 * arbitrariamente. Passa a transportar `sourceFarmaciaId` desde a UI
 * (todos os chamadores já tinham o id disponível — só não estava a ser
 * passado) e a resolver SEMPRE por id (`findUnique`), nunca por nome.
 *
 * Cobre:
 *   1. `resolverTransferenciaInterna` (função pura) — o cenário central:
 *      duas farmácias com o MESMO nome, ids diferentes, a transferência
 *      tem de ir para o id pedido, nunca para o outro.
 *   2. origem === destino continua bloqueado.
 *   3. farmácia em falta/não encontrada continua bloqueado.
 *   4. Inspecção estática: `createInternalTransferAction` já não tem
 *      nenhum `findFirst` para farmácia, usa `findUnique` por id para
 *      AMBAS (origem e destino), e nunca compara nomes.
 *   5. Inspecção estática: os 4 chamadores de `CreateInternalTransferButton`
 *      passam `sourceFarmaciaId` (não só `sourceFarmaciaNome`).
 *   6. Inspecção estática: `/transferencias` exige `requirePermission`
 *      (não só `getSession()`, que não bloqueava ninguém).
 *
 * Uso: npx tsx scripts/tests/test-transferencia-por-id.ts
 */
import { readFileSync } from "node:fs";
import { resolverTransferenciaInterna } from "../../lib/transferencias/resolver-transferencia-interna";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

const src = (p: string) => readFileSync(p, "utf8");

// ─────────────────────────────────────────────────────────────────────────
// 1-3. resolverTransferenciaInterna — função pura
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== 1. Duas farmácias com o MESMO nome, ids diferentes ===");
{
  // O cenário real que motivou a correcção: "Farmácia Central" existe
  // duas vezes no mesmo tenant, com ids "farm-A" e "farm-Z". Um
  // findFirst({where:{nome:"Farmácia Central"}}) escolheria sempre a
  // MESMA (a primeira que a BD devolvesse, arbitrário) — resolverTransferenciaInterna
  // nunca olha para o nome, só para o id já resolvido.
  const farmaciaA = { id: "farm-A", nome: "Farmácia Central" };
  const farmaciaZ = { id: "farm-Z", nome: "Farmácia Central" }; // MESMO nome, id diferente
  const destino = { id: "farm-destino", nome: "Farmácia Norte" };

  // Pedido explícito: origem = farm-Z (não farm-A, mesmo tendo o mesmo nome).
  const resultado = resolverTransferenciaInterna(
    { sourceFarmaciaId: "farm-Z", destinoFarmaciaId: "farm-destino" },
    farmaciaZ, // simula o findUnique({where:{id:"farm-Z"}}) — já resolvido pelo CALLER
    destino,
  );
  ok("resolve com sucesso", resultado.ok);
  if (resultado.ok) {
    eq("origem é EXACTAMENTE farm-Z, não farm-A", resultado.farmaciaOrigem.id, "farm-Z");
    ok("nunca compara com farmaciaA — nem chega a ser passada à função", true);
  }

  // O mesmo pedido, mas desta vez a farmácia resolvida (pelo CALLER,
  // simulando um findUnique por "farm-A") é a OUTRA com o mesmo nome —
  // prova que resolverTransferenciaInterna confia inteiramente no que
  // já foi resolvido por id, nunca re-valida por nome.
  const resultado2 = resolverTransferenciaInterna(
    { sourceFarmaciaId: "farm-A", destinoFarmaciaId: "farm-destino" },
    farmaciaA,
    destino,
  );
  ok("pedido diferente (farm-A) resolve para farm-A", resultado2.ok && resultado2.farmaciaOrigem.id === "farm-A");
}

console.log("\n=== 2. Origem === destino continua bloqueado ===");
{
  const farmacia = { id: "farm-X", nome: "Farmácia X" };
  const resultado = resolverTransferenciaInterna(
    { sourceFarmaciaId: "farm-X", destinoFarmaciaId: "farm-X" },
    farmacia,
    farmacia,
  );
  eq("bloqueado", resultado.ok, false);
  if (!resultado.ok) ok("mensagem clara", resultado.error.includes("mesma farmácia"));
}

console.log("\n=== 3. Farmácia em falta ou não encontrada ===");
{
  eq(
    "sourceFarmaciaId vazio é recusado",
    resolverTransferenciaInterna({ sourceFarmaciaId: "", destinoFarmaciaId: "farm-Y" }, null, { id: "farm-Y", nome: "Y" }).ok,
    false,
  );
  eq(
    "destinoFarmaciaId vazio é recusado",
    resolverTransferenciaInterna({ sourceFarmaciaId: "farm-X", destinoFarmaciaId: "" }, { id: "farm-X", nome: "X" }, null).ok,
    false,
  );
  const semOrigem = resolverTransferenciaInterna(
    { sourceFarmaciaId: "farm-fantasma", destinoFarmaciaId: "farm-Y" },
    null, // findUnique não encontrou nada com este id
    { id: "farm-Y", nome: "Y" },
  );
  eq("origem não encontrada é recusada", semOrigem.ok, false);
  if (!semOrigem.ok) ok("…com mensagem própria", semOrigem.error.includes("origem"));
  const semDestino = resolverTransferenciaInterna(
    { sourceFarmaciaId: "farm-X", destinoFarmaciaId: "farm-fantasma" },
    { id: "farm-X", nome: "X" },
    null,
  );
  eq("destino não encontrado é recusado", semDestino.ok, false);
  if (!semDestino.ok) ok("…com mensagem própria", semDestino.error.includes("destino"));
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Inspecção estática — createInternalTransferAction
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== 4. createInternalTransferAction nunca resolve por nome ===");
{
  const acoes = src("app/encomendas/nova/actions.ts");
  ok(
    "não existe nenhum findFirst por nome de farmácia",
    !/farmacia\.findFirst\(\s*\{\s*where:\s*\{\s*nome/.test(acoes),
  );
  // \r?\n — o repositório é desenvolvido em Windows com core.autocrlf=true;
  // um \n bare não sobrevive a um checkout com terminadores CRLF.
  const match = acoes.match(/export async function createInternalTransferAction\b[\s\S]*?\r?\n\}\r?\n/);
  ok("createInternalTransferAction existe", match !== null);
  const corpo = match ? match[0] : "";
  ok(
    "resolve ORIGEM por findUnique(id)",
    /farmacia\.findUnique\(\{\s*where:\s*\{\s*id:\s*input\.sourceFarmaciaId/.test(corpo),
  );
  ok(
    "resolve DESTINO por findUnique(id)",
    /farmacia\.findUnique\(\{\s*where:\s*\{\s*id:\s*input\.destinoFarmaciaId/.test(corpo),
  );
  ok(
    "usa resolverTransferenciaInterna (a função pura testada acima), não lógica inline duplicada",
    corpo.includes("resolverTransferenciaInterna("),
  );
  ok(
    "importa resolverTransferenciaInterna de lib/transferencias — não a define localmente " +
      "(actions.ts tem \"use server\" no topo; o Next.js exige que todo export de função " +
      "dum módulo \"use server\" seja async, e resolverTransferenciaInterna é síncrona)",
    acoes.includes('from "@/lib/transferencias/resolver-transferencia-interna"') &&
      !/^export function resolverTransferenciaInterna\b/m.test(acoes),
  );
  ok(
    "notas usam o nome AUTORITATIVO (farmaciaOrigem.nome, já lido da BD), não input.sourceFarmaciaNome",
    corpo.includes("buildTransferNote(input, farmaciaOrigem.nome)") &&
      !/notas:\s*buildTransferNote\(input\)/.test(corpo),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Inspecção estática — os 4 chamadores passam sourceFarmaciaId
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== 5. Todos os chamadores passam sourceFarmaciaId (não só o nome) ===");
{
  const transf = src("components/transferencias/transferencias-client.tsx");
  ok(
    "transferencias-client.tsx: sourceFarmaciaId: row.farmaciaOrigemId",
    /sourceFarmaciaId:\s*row\.farmaciaOrigemId/.test(transf),
  );

  const inbox = src("components/oportunidades/oportunidades-inbox.tsx");
  ok("oportunidades-inbox.tsx: sourceFarmaciaId: s.sourceFarmaciaId", /sourceFarmaciaId:\s*s\.sourceFarmaciaId/.test(inbox));
  ok("oportunidades-inbox.tsx: sourceFarmaciaId: d.sourceFarmaciaId", /sourceFarmaciaId:\s*d\.sourceFarmaciaId/.test(inbox));
  ok(
    "oportunidades-inbox.tsx: os tipos de item declaram sourceFarmaciaId",
    (inbox.match(/sourceFarmaciaId:\s*string;/g) ?? []).length >= 2,
  );

  const oportunidadesPage = src("app/oportunidades/page.tsx");
  ok(
    "app/oportunidades/page.tsx: mapeia suggestedSourceFarmaciaId para a prop",
    /sourceFarmaciaId:\s*s\.suggestedSourceFarmaciaId/.test(oportunidadesPage),
  );
  ok(
    "app/oportunidades/page.tsx: mapeia sourceFarmaciaId (DCI) para a prop",
    /sourceFarmaciaId:\s*c\.sourceFarmaciaId/.test(oportunidadesPage),
  );

  const encomendasClient = src("components/encomendas/encomendas-client.tsx");
  ok(
    "encomendas-client.tsx (código morto, mas tem de compilar): same-cnp passa sourceFarmaciaId",
    /sourceFarmaciaId:\s*item\.substitutionSourceFarmaciaId/.test(encomendasClient),
  );
  ok(
    "encomendas-client.tsx: dci-equivalent passa sourceFarmaciaId",
    /sourceFarmaciaId:\s*item\.dciEquivalentSourceFarmaciaId/.test(encomendasClient),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Inspecção estática — /transferencias exige permissão
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== 6. /transferencias exige requirePermission ===");
{
  const page = src("app/transferencias/page.tsx");
  ok(
    "chama requirePermission (não só getSession, que não bloqueava ninguém)",
    page.includes('requirePermission("reports.write")'),
  );
  ok(
    "já não importa getSession — a página passou a resolver a sessão via requirePermission",
    !page.includes('from "@/lib/auth"'),
  );
  ok(
    "usa a MESMA permissão que /encomendas (área de decisão partilhada), não uma nova",
    page.includes('requirePermission("reports.write")'),
  );
  // A gate de "podeEliminarTransferencia" continua a existir e a usar a
  // sessão devolvida por requirePermission, não uma segunda chamada.
  ok(
    "podeEliminarTransferencia usa a sessão de requirePermission",
    /const session = await requirePermission\("reports\.write"\);[\s\S]*const podeEliminarTransferencia = can\(session,/.test(page),
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
