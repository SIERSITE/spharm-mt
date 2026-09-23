/**
 * scripts/tests/test-importar-grupos-laboratoriais-garantia.ts
 *
 * Testa scripts/importar-grupos-laboratoriais-garantia.ts — trava ao
 * tenant garantia (múltiplas camadas), dry-run por omissão, as DUAS
 * flags exigidas para --apply, bloqueios (fabricante inexistente/
 * ambíguo, conflito de grupo, conflito de CNP, JANSSEN/KENVUE, PFIZER
 * fora de CNP), idempotência, rollback de transação, e — por
 * verificação estática do código-fonte — que nada neste ficheiro
 * escreve Produto nem Fabricante, e que nunca lê nenhuma fonte de
 * propostas/snapshot nem o plano de 557 merges.
 *
 * Corre com: npx tsx scripts/tests/test-importar-grupos-laboratoriais-garantia.ts
 */
import { readFileSync } from "node:fs";
import {
  TENANT_TRAVADO,
  BASE_ESPERADA,
  parseArgs,
  confirmarAlvoGarantia,
  confirmarConfigGarantia,
  validarConfigEstrutural,
  resolverFabricantesIntegrais,
  planearFabricantesIntegrais,
  importarGruposLaboratoriais,
  type ConfigGruposIniciais,
  type RegrasCnpFicheiro,
  type FabricanteReal,
} from "../importar-grupos-laboratoriais-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ── Fixtures mínimas ─────────────────────────────────────────────────

function configBase(): ConfigGruposIniciais {
  return {
    tenant: "garantia",
    grupos: [
      {
        nome: "Viatris",
        nomeNormalizado: "VIATRIS",
        aliases: [{ alias: "Mylan", aliasNormalizado: "MYLAN", origem: "teste" }],
        fabricantesIntegrais: ["MYLAN LDA"],
      },
      {
        nome: "Kenvue",
        nomeNormalizado: "KENVUE",
        aliases: [],
        fabricantesIntegrais: ["KENVUE PT"],
      },
    ],
  };
}

function regrasBase(): RegrasCnpFicheiro {
  return {
    tenant: "garantia",
    regras: [
      { cnp: 1001, grupoLaboratorialNomeNormalizado: "VIATRIS", fabricanteLegalEsperadoNormalizado: "LABORATORIOS PFIZER LDA", estado: "ATIVO", validadoManualmente: true, evidencia: "teste" },
    ],
  };
}

function fabricantesReaisBase(): FabricanteReal[] {
  return [
    { id: "fMylan", nomeNormalizado: "MYLAN LDA" },
    { id: "fKenvue", nomeNormalizado: "KENVUE PT" },
    { id: "fPfizer", nomeNormalizado: "LABORATORIOS PFIZER LDA" },
    { id: "fJanssen", nomeNormalizado: "JANSSEN CILAG FARMACEUT LDA" },
  ];
}

/** Prisma falso com estado mutável — permite provar idempotência entre duas chamadas reais. */
function criarFakePrisma(fabricantesReais: FabricanteReal[]) {
  const estado = {
    grupos: [] as Array<{ id: string; nomeNormalizado: string; nome: string }>,
    aliases: [] as Array<{ grupoLaboratorialId: string; aliasNormalizado: string; alias: string; origem: string | null }>,
    gruposFabricante: [] as Array<{ fabricanteId: string; grupoLaboratorialId: string; evidencia: string | null }>,
    regrasCnp: [] as Array<{ cnp: number; grupoLaboratorialId: string; evidencia: string | null; estado: string; validadoManualmente: boolean; fabricanteLegalEsperadoId: string | null }>,
  };
  let seq = 0;

  const prisma = {
    fabricante: { findMany: async () => fabricantesReais },
    grupoLaboratorial: { findMany: async () => estado.grupos },
    grupoLaboratorialAlias: { findMany: async () => estado.aliases },
    grupoLaboratorialFabricante: { findMany: async () => estado.gruposFabricante },
    regraGrupoLaboratorialPorCnp: { findMany: async () => estado.regrasCnp },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      // Simula atomicidade real: acumula num buffer de trabalho; só
      // "commita" para `estado` se fn() resolver sem lançar. Se lançar,
      // o buffer é descartado inteiro — nada do que já correu dentro
      // da função fica visível.
      const buffer = {
        grupos: [...estado.grupos],
        aliases: [...estado.aliases],
        gruposFabricante: [...estado.gruposFabricante],
        regrasCnp: [...estado.regrasCnp],
      };
      const tx = {
        grupoLaboratorial: {
          upsert: async (args: { where: { nomeNormalizado: string }; create: { nome: string; nomeNormalizado: string }; update: { nome: string } }) => {
            const idx = buffer.grupos.findIndex((g) => g.nomeNormalizado === args.where.nomeNormalizado);
            if (idx >= 0) {
              buffer.grupos[idx] = { ...buffer.grupos[idx]!, nome: args.update.nome };
              return buffer.grupos[idx]!;
            }
            const novo = { id: `g${seq++}`, nomeNormalizado: args.create.nomeNormalizado, nome: args.create.nome };
            buffer.grupos.push(novo);
            return novo;
          },
        },
        grupoLaboratorialAlias: {
          upsert: async (args: { where: { grupoLaboratorialId_aliasNormalizado: { grupoLaboratorialId: string; aliasNormalizado: string } }; create: { grupoLaboratorialId: string; alias: string; aliasNormalizado: string; origem: string | null }; update: { alias: string; origem: string | null } }) => {
            const { grupoLaboratorialId, aliasNormalizado } = args.where.grupoLaboratorialId_aliasNormalizado;
            const idx = buffer.aliases.findIndex((a) => a.grupoLaboratorialId === grupoLaboratorialId && a.aliasNormalizado === aliasNormalizado);
            if (idx >= 0) buffer.aliases[idx] = { ...buffer.aliases[idx]!, alias: args.update.alias, origem: args.update.origem };
            else buffer.aliases.push({ grupoLaboratorialId, aliasNormalizado, alias: args.create.alias, origem: args.create.origem });
          },
        },
        grupoLaboratorialFabricante: {
          upsert: async (args: { where: { fabricanteId: string }; create: { fabricanteId: string; grupoLaboratorialId: string; evidencia: string }; update: { grupoLaboratorialId: string; evidencia: string } }) => {
            const idx = buffer.gruposFabricante.findIndex((g) => g.fabricanteId === args.where.fabricanteId);
            if (idx >= 0) buffer.gruposFabricante[idx] = { ...buffer.gruposFabricante[idx]!, grupoLaboratorialId: args.update.grupoLaboratorialId, evidencia: args.update.evidencia };
            else buffer.gruposFabricante.push({ fabricanteId: args.create.fabricanteId, grupoLaboratorialId: args.create.grupoLaboratorialId, evidencia: args.create.evidencia });
          },
        },
        regraGrupoLaboratorialPorCnp: {
          upsert: async (args: { where: { cnp: number }; create: { cnp: number; grupoLaboratorialId: string; evidencia: string | null; estado: string; validadoManualmente: boolean; fabricanteLegalEsperadoId: string | null }; update: { grupoLaboratorialId: string; evidencia: string | null; estado: string; validadoManualmente: boolean; fabricanteLegalEsperadoId: string | null } }) => {
            const idx = buffer.regrasCnp.findIndex((r) => r.cnp === args.where.cnp);
            if (idx >= 0) buffer.regrasCnp[idx] = { ...buffer.regrasCnp[idx]!, ...args.update };
            else buffer.regrasCnp.push({ ...args.create });
          },
        },
      };
      await fn(tx);
      // Só chega aqui se fn() não lançou — commit.
      estado.grupos = buffer.grupos;
      estado.aliases = buffer.aliases;
      estado.gruposFabricante = buffer.gruposFabricante;
      estado.regrasCnp = buffer.regrasCnp;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { prisma, estado: () => estado };
}

console.log("A · parseArgs — as DUAS flags são exigidas para escrever");
{
  const args = parseArgs(["--tenant=garantia", "--relatorio=/x.json"]);
  eq(args.apply, false, "A1: sem --apply, fica em dry-run");

  let lancou = false;
  try { parseArgs(["--tenant=garantia", "--relatorio=/x.json", "--apply"]); } catch { lancou = true; }
  check(lancou, "A2: --apply SOZINHO (sem --confirmar-tenant=) é recusado");

  let lancou2 = false;
  try { parseArgs(["--tenant=garantia", "--relatorio=/x.json", "--apply", "--confirmar-tenant=sier"]); } catch { lancou2 = true; }
  check(lancou2, "A3: --confirmar-tenant= com valor diferente de garantia é recusado");

  const argsOk = parseArgs(["--tenant=garantia", "--relatorio=/x.json", "--apply", "--confirmar-tenant=garantia"]);
  eq(argsOk.apply, true, "A4: --apply + --confirmar-tenant=garantia juntos são aceites");

  let lancou3 = false;
  try { parseArgs(["--tenant=garantia"]); } catch { lancou3 = true; }
  check(lancou3, "A5: falta --relatorio= é recusado");

  const argsDefaults = parseArgs(["--tenant=garantia", "--relatorio=/x.json"]);
  check(argsDefaults.configPath.includes("grupos-laboratoriais-iniciais-garantia.json"), "A6: --config= tem default apontando para a configuração aprovada");
  check(argsDefaults.regrasPath.includes("regras-cnp-grupos-laboratoriais-garantia.json"), "A7: --regras= tem default apontando para as regras aprovadas");
}

console.log("\nB · confirmarAlvoGarantia / confirmarConfigGarantia — trava ao tenant garantia em várias camadas");
{
  eq(TENANT_TRAVADO, "garantia", "B1: tenant travado é garantia");
  eq(BASE_ESPERADA, "spharmmt_t_garantia", "B2: base esperada correcta");

  let lancou = false;
  try { confirmarAlvoGarantia({ tenant: "sier", base: BASE_ESPERADA }); } catch { lancou = true; }
  check(lancou, "B3: tenant resolvido diferente de garantia é recusado (recusa tenant diferente)");

  let lancou2 = false;
  try { confirmarAlvoGarantia({ tenant: "garantia", base: "spharmmt_t_sier" }); } catch { lancou2 = true; }
  check(lancou2, "B4: base resolvida diferente de spharmmt_t_garantia é recusada (recusa base diferente)");

  let lancou3 = false;
  try { confirmarAlvoGarantia({ tenant: "garantia", base: BASE_ESPERADA }); } catch { lancou3 = true; }
  check(!lancou3, "B5: tenant + base correctos passam");

  let lancou4 = false;
  try { confirmarConfigGarantia({ tenant: "silveira" }, {}); } catch { lancou4 = true; }
  check(lancou4, "B6: configuração declarando outro tenant é recusada — terceira camada");

  let lancou5 = false;
  try { confirmarConfigGarantia({ tenant: "garantia" }, { tenant: "sier" }); } catch { lancou5 = true; }
  check(lancou5, "B7: ficheiro de regras declarando outro tenant é recusado");

  let lancou6 = false;
  try { confirmarConfigGarantia({ tenant: "garantia" }, {}); } catch { lancou6 = true; }
  check(!lancou6, "B8: config garantia + regras sem tenant declarado (opcional) passam");
}

console.log("\nC · validarConfigEstrutural — bloqueios estruturais da configuração");
{
  const { bloqueios } = validarConfigEstrutural(
    { tenant: "garantia", grupos: [
      { nome: "A", nomeNormalizado: "A", aliases: [], fabricantesIntegrais: ["MESMO FABRICANTE"] },
      { nome: "B", nomeNormalizado: "B", aliases: [], fabricantesIntegrais: ["MESMO FABRICANTE"] },
    ] },
    { regras: [] },
  );
  check(bloqueios.some((b) => b.tipo === "fabricante_integral_em_dois_grupos"), "C1: mesmo fabricante integral em dois grupos bloqueia (conflito de grupo)");
}
{
  const { bloqueios } = validarConfigEstrutural(
    { tenant: "garantia", grupos: [{ nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [], fabricantesIntegrais: ["Janssen-Cilag Farmacêutica Lda."] }] },
    { regras: [] },
  );
  check(bloqueios.some((b) => b.tipo === "janssen_em_kenvue"), "C2: JANSSEN como fabricante integral de KENVUE bloqueia");
}
{
  const { bloqueios } = validarConfigEstrutural(
    { tenant: "garantia", grupos: [{ nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [{ alias: "Janssen Consumer", aliasNormalizado: "JANSSEN CONSUMER" }], fabricantesIntegrais: [] }] },
    { regras: [] },
  );
  check(bloqueios.some((b) => b.tipo === "janssen_em_kenvue"), "C3: JANSSEN como alias de KENVUE também bloqueia");
}
{
  const { bloqueios } = validarConfigEstrutural(
    { tenant: "garantia", grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: ["Laboratórios Pfizer Lda."] }] },
    { regras: [] },
  );
  check(bloqueios.some((b) => b.tipo === "pfizer_integral_proibido"), "C4: PFIZER com associação INTEGRAL (em qualquer grupo) bloqueia — só entra por CNP");
}
{
  const { bloqueios, regrasValidas } = validarConfigEstrutural(configBase(), {
    tenant: "garantia",
    regras: [
      { cnp: 5000, grupoLaboratorialNomeNormalizado: "VIATRIS", estado: "ATIVO", validadoManualmente: true },
      { cnp: 5000, grupoLaboratorialNomeNormalizado: "KENVUE", estado: "ATIVO", validadoManualmente: true },
    ],
  });
  check(bloqueios.some((b) => b.tipo === "cnp_duas_regras_grupos_diferentes"), "C5: mesmo CNP com regras para grupos diferentes bloqueia (conflito de CNP)");
  eq(regrasValidas.length, 1, "C6: só a primeira regra do CNP conflituoso entra em regrasValidas — nunca as duas");
}
{
  const { regrasValidas, regrasIgnoradas } = validarConfigEstrutural(configBase(), {
    tenant: "garantia",
    regras: [
      { cnp: 6000, grupoLaboratorialNomeNormalizado: "VIATRIS", estado: "ATIVO", validadoManualmente: true },
      { cnp: 6001, grupoLaboratorialNomeNormalizado: "VIATRIS", estado: "INATIVO", validadoManualmente: true },
      { cnp: 6002, grupoLaboratorialNomeNormalizado: "VIATRIS", estado: "ATIVO", validadoManualmente: false },
    ],
  });
  eq(regrasValidas.length, 1, "C7: só ATIVO+validadoManualmente entra em regrasValidas — nunca os 71 casos pendentes/propostas nem inactivas");
  eq(regrasIgnoradas.length, 2, "C8: as duas outras ficam em regrasIgnoradas, nunca aplicadas");
}
{
  const { bloqueios } = validarConfigEstrutural(configBase(), { tenant: "garantia", regras: [{ cnp: 7000, grupoLaboratorialNomeNormalizado: "GRUPO_INEXISTENTE", estado: "ATIVO", validadoManualmente: true }] });
  check(bloqueios.some((b) => b.tipo === "regra_cnp_sem_grupo_correspondente"), "C9: regra CNP para grupo que não existe na config bloqueia");
}

console.log("\nD · resolverFabricantesIntegrais — resolvido (único e múltiplo), inexistente (informativo), conflito real bloqueia");
{
  const { resolucoes, bloqueios } = resolverFabricantesIntegrais(configBase(), fabricantesReaisBase());
  const viatris = resolucoes.find((r) => r.candidato === "MYLAN LDA");
  eq(viatris?.acao, "resolvido", "D1: fabricante real existente resolve");
  eq(bloqueios.length, 0, "D2: sem bloqueios quando tudo resolve limpo");
}
{
  const config: ConfigGruposIniciais = { tenant: "garantia", grupos: [{ nome: "X", nomeNormalizado: "X", aliases: [], fabricantesIntegrais: ["NÃO EXISTE NA GARANTIA"] }] };
  const { resolucoes, bloqueios } = resolverFabricantesIntegrais(config, fabricantesReaisBase());
  eq(resolucoes[0]?.acao, "inexistente", "D3: fabricante sem correspondência real → inexistente");
  eq(bloqueios.length, 0, "D4: nome inexistente é reportado mas NÃO bloqueia — ausência/no-op, nunca cria Fabricante");
}
{
  // Duas linhas Fabricante REAIS distintas normalizam para o MESMO nome configurado
  // ("ALFASIGMA PORTUGAL LDA") — duplicação de dados de origem, não ambiguidade de
  // negócio: as DUAS entram no grupo Alfasigma, nenhuma escolhida arbitrariamente.
  const config: ConfigGruposIniciais = { tenant: "garantia", grupos: [{ nome: "Alfasigma", nomeNormalizado: "ALFASIGMA", aliases: [], fabricantesIntegrais: ["ALFASIGMA PORTUGAL LDA"] }] };
  const fabricantesEquivalentes: FabricanteReal[] = [
    { id: "fAlfa1", nomeNormalizado: "ALFASIGMA PORTUGAL LDA" },
    { id: "fAlfa2", nomeNormalizado: "Alfasigma Portugal, Lda." },
  ];
  const { resolucoes, bloqueios } = resolverFabricantesIntegrais(config, fabricantesEquivalentes);
  const r0 = resolucoes[0];
  eq(r0?.acao, "resolvido", "D5: candidato com múltiplas linhas equivalentes continua 'resolvido', nunca 'ambiguo'");
  eq(r0 && r0.acao === "resolvido" ? [...r0.fabricanteIds].sort() : [], ["fAlfa1", "fAlfa2"], "D6: 'ALFASIGMA PORTUGAL LDA' com dois ids equivalentes associa AMBOS ao grupo Alfasigma");
  eq(bloqueios.length, 0, "D7: zero bloqueios — duplicação de dados de origem não é conflito empresarial");
}
{
  // Mesmo padrão com "MYLAN LDA" → Viatris (caso real do dry-run de garantia).
  const config: ConfigGruposIniciais = { tenant: "garantia", grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: ["MYLAN LDA"] }] };
  const fabricantesEquivalentes: FabricanteReal[] = [
    { id: "fMylan1", nomeNormalizado: "MYLAN LDA" },
    { id: "fMylan2", nomeNormalizado: "Mylan, Lda." },
  ];
  const { resolucoes, bloqueios } = resolverFabricantesIntegrais(config, fabricantesEquivalentes);
  const r0 = resolucoes[0];
  eq(r0 && r0.acao === "resolvido" ? [...r0.fabricanteIds].sort() : [], ["fMylan1", "fMylan2"], "D8: 'MYLAN LDA' com dois ids equivalentes associa ambos a Viatris");
  eq(bloqueios.length, 0, "D9: zero bloqueios");
}
{
  // Repetir variantes do MESMO nome (mesmo grupo) não duplica associações — o
  // plano dedupe por fabricanteId, mesmo com 3 candidatos crus diferentes.
  const config: ConfigGruposIniciais = {
    tenant: "garantia",
    grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: ["MYLAN LDA", "Mylan, Lda.", "MYLAN LDA."] }],
  };
  const fabricantesEquivalentes: FabricanteReal[] = [
    { id: "fMylan1", nomeNormalizado: "MYLAN LDA" },
    { id: "fMylan2", nomeNormalizado: "Mylan, Lda." },
  ];
  const { resolucoes, bloqueios } = resolverFabricantesIntegrais(config, fabricantesEquivalentes);
  eq(resolucoes.length, 3, "D10: as 3 variantes cruas continuam registadas na resolução (uma entrada por candidato)");
  eq(bloqueios.length, 0, "D11: repetir variantes do mesmo nome não gera conflito");

  const plano = planearFabricantesIntegrais(resolucoes, [], new Map([["VIATRIS", "gViatris"]]));
  eq(plano.filter((i) => i.acao === "criar").length, 2, "D12: repetir variantes do mesmo nome não duplica associações — 2 ids distintos a criar, nunca 3 nem 6");
}
{
  // Conflito RESOLVIDO (único candidato por grupo): dois candidatos crus
  // diferentes, em grupos diferentes, resolvem para o MESMO fabricante real.
  const config: ConfigGruposIniciais = {
    tenant: "garantia",
    grupos: [
      { nome: "A", nomeNormalizado: "A", aliases: [], fabricantesIntegrais: ["Mylan Lda"] },
      { nome: "B", nomeNormalizado: "B", aliases: [], fabricantesIntegrais: ["Mylan, Lda"] }, // mesma entidade real após normalizar
    ],
  };
  const { bloqueios } = resolverFabricantesIntegrais(config, [{ id: "f1", nomeNormalizado: "MYLAN LDA" }]);
  check(bloqueios.some((b) => b.tipo === "fabricante_resolvido_em_dois_grupos"), "D13: o MESMO fabricante real reclamado por dois grupos (via candidatos crus diferentes) bloqueia");
}
{
  // Conflito real também quando o CONJUNTO de ids equivalentes (múltiplas
  // linhas reais) é reclamado por dois grupos diferentes — um id reclamado
  // por dois grupos continua a bloquear, mesmo vindo de um conjunto múltiplo.
  const config: ConfigGruposIniciais = {
    tenant: "garantia",
    grupos: [
      { nome: "A", nomeNormalizado: "A", aliases: [], fabricantesIntegrais: ["DUPLICADO LDA"] },
      { nome: "B", nomeNormalizado: "B", aliases: [], fabricantesIntegrais: ["Duplicado, Lda."] },
    ],
  };
  const fabricantesComDuplicado: FabricanteReal[] = [{ id: "f1", nomeNormalizado: "DUPLICADO LDA" }, { id: "f2", nomeNormalizado: "Duplicado, Lda." }];
  const { bloqueios } = resolverFabricantesIntegrais(config, fabricantesComDuplicado);
  check(bloqueios.some((b) => b.tipo === "fabricante_resolvido_em_dois_grupos"), "D14: um id reclamado por dois grupos diferentes continua a bloquear, mesmo vindo de um conjunto de múltiplas linhas equivalentes");
}
{
  // JANSSEN nunca entra em KENVUE — protecção testada ao nível estrutural
  // (validarConfigEstrutural, bloco C2/C3) continua válida: resolverFabricantesIntegrais
  // nunca é sequer chamado com essa config em produção, porque main() só chama
  // importarGruposLaboratoriais depois de validarConfigEstrutural já ter bloqueado.
  const { bloqueios } = validarConfigEstrutural(
    { tenant: "garantia", grupos: [{ nome: "Kenvue", nomeNormalizado: "KENVUE", aliases: [], fabricantesIntegrais: ["Janssen-Cilag Farmacêutica, Lda."] }] },
    { regras: [] },
  );
  check(bloqueios.some((b) => b.tipo === "janssen_em_kenvue"), "D15: Janssen nunca entra em Kenvue, mesmo com grafia equivalente a uma linha real duplicada");
}
{
  // Pfizer nunca entra integralmente em nenhum grupo — mesma protecção estrutural.
  const { bloqueios } = validarConfigEstrutural(
    { tenant: "garantia", grupos: [{ nome: "Viatris", nomeNormalizado: "VIATRIS", aliases: [], fabricantesIntegrais: ["Laboratórios Pfizer, Lda."] }] },
    { regras: [] },
  );
  check(bloqueios.some((b) => b.tipo === "pfizer_integral_proibido"), "D16: Pfizer nunca entra integralmente em Viatris (nem em nenhum grupo) — só por RegraGrupoLaboratorialPorCnp");
}

async function principal() {
  console.log("\nE · Pfizer entra em VIATRIS SÓ por regra CNP validada — nunca associação integral");
  {
    const config = configBase();
    const regras = regrasBase(); // CNP 1001 → VIATRIS, fabricanteLegalEsperado Pfizer
    const { prisma } = criarFakePrisma(fabricantesReaisBase());
    const r = await importarGruposLaboratoriais(prisma, { config, regras, apply: false });
    eq(r.bloqueios.length, 0, "E1: cenário Pfizer-só-por-CNP não gera bloqueios");
    const regraPfizer = r.regrasCnp.find((i) => i.chave === "1001");
    eq(regraPfizer?.acao, "criar", "E2: a regra CNP 1001 (Pfizer→Viatris) seria criada");
    const integraisPfizer = r.fabricantesIntegrais.resolucoes.filter((res) => res.acao === "resolvido" && res.fabricantesNomeNormalizado.some((n) => n.includes("PFIZER")));
    eq(integraisPfizer.length, 0, "E3: nenhuma associação INTEGRAL envolve Pfizer — só a regra por CNP");
  }

  console.log("\nF · importarGruposLaboratoriais — dry-run faz ZERO escritas");
  {
    const { prisma, estado } = criarFakePrisma(fabricantesReaisBase());
    const r = await importarGruposLaboratoriais(prisma, { config: configBase(), regras: regrasBase(), apply: false });
    eq(r.escritas, 0, "F1: escritas=0 em dry-run, mesmo com tudo pronto a criar");
    eq(estado().grupos.length, 0, "F2: nenhum grupo escrito na base (fake) em dry-run");
    eq(r.totais.grupos.criar, 2, "F3: o PLANO mostra 2 grupos a criar, mesmo sem escrever");
  }

  console.log("\nG · primeira execução com --apply cria tudo; segunda execução é idempotente");
  {
    const { prisma, estado } = criarFakePrisma(fabricantesReaisBase());
    const r1 = await importarGruposLaboratoriais(prisma, { config: configBase(), regras: regrasBase(), apply: true });
    check(r1.bloqueios.length === 0, "G1: primeira corrida sem bloqueios");
    check(r1.escritas > 0, "G2: primeira corrida escreve (grupos + aliases + integrais + regra)");
    eq(estado().grupos.length, 2, "G3: 2 grupos criados na base (fake)");
    eq(estado().gruposFabricante.length, 2, "G4: 2 associações integrais criadas (Mylan→Viatris, Kenvue PT→Kenvue)");
    eq(estado().regrasCnp.length, 1, "G5: 1 regra CNP criada");

    const r2 = await importarGruposLaboratoriais(prisma, { config: configBase(), regras: regrasBase(), apply: true });
    eq(r2.totais.grupos.criar, 0, "G6: segunda corrida — zero grupos a CRIAR");
    eq(r2.totais.grupos.inalterados, 2, "G7: segunda corrida — os 2 grupos ficam INALTERADOS");
    eq(r2.totais.aliases.inalterados, 1, "G8: segunda corrida — o alias fica INALTERADO");
    eq(r2.totais.fabricantesIntegrais.inalterados, 2, "G9: segunda corrida — as 2 associações ficam INALTERADAS");
    eq(r2.totais.regrasCnp.inalterados, 1, "G10: segunda corrida — a regra CNP fica INALTERADA");
    eq(r2.escritas, 0, "G11: segunda corrida — ZERO escritas (nada mudou)");
    eq(estado().grupos.length, 2, "G12: continuam a ser exactamente 2 grupos — zero duplicados");
    eq(estado().gruposFabricante.length, 2, "G13: continuam a ser exactamente 2 associações — zero duplicados");
  }

  console.log("\nH · falha a meio da transação provoca rollback TOTAL (nada fica escrito)");
  {
    const fabricantesReais = fabricantesReaisBase();
    const estadoBuffer = { grupos: [] as Array<{ id: string; nomeNormalizado: string; nome: string }> };
    let chamouUpsertAlias = false;
    const prisma = {
      fabricante: { findMany: async () => fabricantesReais },
      grupoLaboratorial: { findMany: async () => estadoBuffer.grupos },
      grupoLaboratorialAlias: { findMany: async () => [] },
      grupoLaboratorialFabricante: { findMany: async () => [] },
      regraGrupoLaboratorialPorCnp: { findMany: async () => [] },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const bufferLocal: typeof estadoBuffer.grupos = [];
        const tx = {
          grupoLaboratorial: {
            upsert: async (args: { create: { nome: string; nomeNormalizado: string } }) => {
              const novo = { id: `g${bufferLocal.length}`, nomeNormalizado: args.create.nomeNormalizado, nome: args.create.nome };
              bufferLocal.push(novo);
              return novo;
            },
          },
          grupoLaboratorialAlias: {
            upsert: async () => {
              chamouUpsertAlias = true;
              throw new Error("falha simulada a meio da transação (ex.: violação de unicidade inesperada)");
            },
          },
        };
        await fn(tx); // lança — $transaction NUNCA copia bufferLocal para estadoBuffer
        estadoBuffer.grupos = bufferLocal; // nunca alcançado neste teste
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    let lancou = false;
    try {
      await importarGruposLaboratoriais(prisma, { config: configBase(), regras: { tenant: "garantia", regras: [] }, apply: true });
    } catch {
      lancou = true;
    }
    check(lancou, "H1: o erro a meio da transação propaga-se (nunca é engolido)");
    check(chamouUpsertAlias, "H2: chegou mesmo a tentar o alias (a falha só ocorre depois de os grupos já terem corrido dentro da transacção)");
    eq(estadoBuffer.grupos.length, 0, "H3: ROLLBACK total — nenhum grupo fica escrito, apesar do 1º upsert ter corrido dentro da transação");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

console.log("I · verificação estática — nunca escreve Produto/Fabricante, nunca lê fontes de propostas, nunca o plano de 557 merges");
{
  const src = readFileSync(new URL("../importar-grupos-laboratoriais-garantia.ts", import.meta.url), "utf8");
  const codigo = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");

  check(!/\.produto\./.test(codigo), "I1: nenhuma referência a um delegate .produto. em código executável");
  check(!/\.fabricante\.(update|create|upsert|delete|updateMany|createMany|deleteMany)\(/.test(codigo), "I2: nenhuma escrita em Fabricante — só leitura");
  check(!/produto:\s*(Pick|PrismaClient)/.test(codigo), "I3: o tipo Prisma aceite não inclui 'produto' — nem para leitura");
  check(/fabricante:\s*Pick<PrismaClient\["fabricante"\],\s*"findMany">/.test(codigo), "I4: 'fabricante' está tipado como só-leitura (findMany)");
  check(!/classificacao-pares-propostas|decomposicao-propostas|ensaio-volume-real-docker/.test(codigo), "I5: nunca lê ficheiros de propostas/snapshot nem reutiliza o ensaio Docker");
  check(!/557|merge-fabricantes/.test(codigo), "I6: nenhuma referência ao plano dos 557 merges nem a merge-fabricantes.ts");
  check(/regrasValidas.*=.*validadoManualmente|estado\s*!==\s*"ATIVO"/.test(src), "I7: filtra explicitamente por validadoManualmente/ATIVO antes de considerar qualquer regra");
  check(/\$transaction\(async \(tx\)/.test(codigo), "I8: escreve dentro de uma única transacção interactive");
  check((codigo.match(/\$transaction\(/g) ?? []).length === 1, "I9: exactamente UMA chamada a $transaction (conjunto curado pequeno, nunca em lotes)");
  check(/default_transaction_read_only = \$\{\s*dryRun \? "on" : "off"\s*\}/.test(codigo), "I10: sessão read-only condicional ao modo (mesma defesa dos outros scripts)");
}

principal();
