/**
 * scripts/tests/test-resolver-fabricante-por-cnp.ts
 *
 * Testa lib/catalog/resolver-fabricante-por-cnp.ts — o motor de
 * precedência PURO da reconciliação de fabricantes por CNP (garantia).
 * Inclui, como bloco dedicado, o caso concreto que motivou toda esta
 * iniciativa: CNP 5701651 / Tadalafil Pharmakern 20 Mg 4 Comp. /
 * titularAim "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade
 * Unipessoal Lda." — usando a normalização REAL
 * (`normalizarTitularAimGarantia`), nunca um valor pré-calculado à mão.
 *
 * Corre com: npx tsx scripts/tests/test-resolver-fabricante-por-cnp.ts
 */
import {
  resolverFabricantePorCnp,
  type MapasResolverFabricante,
  type FabricanteParaResolverFabricante,
  type ProdutoParaResolverFabricante,
} from "../../lib/catalog/resolver-fabricante-por-cnp";
import { normalizarTitularAimGarantia } from "../../lib/catalog/fabricante-normalizacao-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

function produto(overrides: Partial<ProdutoParaResolverFabricante> = {}): ProdutoParaResolverFabricante {
  return { id: "p1", cnp: 5701651, fabricanteIdExistente: null, fabricanteExistenteNomeNormalizado: null, camposManuais: [], ...overrides };
}

function mapas(overrides: Partial<MapasResolverFabricante> = {}): MapasResolverFabricante {
  return { fabricantesPorNomeNormalizado: new Map(), fabricantesPorAlias: new Map(), ...overrides };
}

function principal() {
  console.log("A · caso real: CNP 5701651 — Tadalafil Pharmakern 20 Mg 4 Comp. (#validação obrigatória)");
  {
    const titularReal = "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.";
    const normReal = normalizarTitularAimGarantia(titularReal);
    check(normReal !== null, "A0: o titular real normaliza (não é null) — a função aceita nomes >60 chars", String(normReal));
    check((normReal?.length ?? 0) > 60, "A0b: o normalizado excede mesmo os 60 chars do limite partilhado (confirma a necessidade do normalizador próprio)", String(normReal?.length));

    // Cenário: DOIS Fabricante duplicados de Pharmakern já existem na
    // base (o problema descrito na tarefa) — nenhum bate EXACTAMENTE
    // com o nome normalizado do titular oficial. O resolver NUNCA deve
    // inventar um terceiro nem escolher um dos dois arbitrariamente por
    // semelhança — só por igualdade exacta, alias, ou plano curado.
    const pharmakernA: FabricanteParaResolverFabricante = { id: "fPharmakernA", nomeNormalizado: "PHARMAKERN PORTUGAL LDA" };
    const pharmakernB: FabricanteParaResolverFabricante = { id: "fPharmakernB", nomeNormalizado: "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIEDADE UNIPESSOAL LDA" };
    // fPharmakernB tem o MESMO nome normalizado que o titular — é o caso
    // onde já existe uma linha exactamente igual.
    const mapasComExacto = mapas({
      fabricantesPorNomeNormalizado: new Map([
        [pharmakernA.nomeNormalizado, pharmakernA],
        [pharmakernB.nomeNormalizado, pharmakernB],
      ]),
    });

    const r1 = resolverFabricantePorCnp(
      produto({ cnp: 5701651 }),
      { titularAim: titularReal, estadoAim: "Autorizado" },
      null,
      true,
      mapasComExacto,
    );
    eq(r1, { tipo: "resolvido_existente", fabricanteId: "fPharmakernB", via: "nome_normalizado", criarAliasNormalizado: null, estadoAim: "Autorizado" }, "A1: resolve para o Pharmakern EXACTAMENTE igual ao titular (fPharmakernB), nunca escolhe fPharmakernA nem cria um terceiro");

    // Cenário SEM nenhuma correspondência exacta ainda na base — cria um
    // Fabricante novo com o nome canónico do titular (nunca junta
    // arbitrariamente a pharmakernA/B por semelhança de prefixo).
    const mapasSoParcial = mapas({
      fabricantesPorNomeNormalizado: new Map([[pharmakernA.nomeNormalizado, pharmakernA]]),
    });
    const r2 = resolverFabricantePorCnp(produto({ cnp: 5701651 }), { titularAim: titularReal, estadoAim: "Autorizado" }, null, true, mapasSoParcial);
    eq(r2, { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: normReal!, criarAliasNormalizado: null, estadoAim: "Autorizado" }, "A2: sem correspondência exacta, cria um Fabricante novo com o nome canónico do titular — nunca reaproveita fPharmakernA por semelhança");

    // Todos os produtos Pharmakern do relatório usam o MESMO canónico —
    // simulado aqui reaplicando o resultado A2 como se já tivesse sido
    // persistido, e verificando que um segundo CNP Pharmakern reutiliza-o.
    const fabricanteNovo: FabricanteParaResolverFabricante = { id: "fPharmakernNovo", nomeNormalizado: normReal! };
    const mapasDepoisDeCriar = mapas({ fabricantesPorNomeNormalizado: new Map([[fabricanteNovo.nomeNormalizado, fabricanteNovo]]) });
    const r3 = resolverFabricantePorCnp(produto({ id: "p2", cnp: 9999999 }), { titularAim: titularReal, estadoAim: "Ativo" }, null, true, mapasDepoisDeCriar);
    eq(r3, { tipo: "resolvido_existente", fabricanteId: "fPharmakernNovo", via: "nome_normalizado", criarAliasNormalizado: null, estadoAim: "Ativo" }, "A3: um SEGUNDO CNP Pharmakern reutiliza o mesmo canónico recém-criado — nunca cria um terceiro");
  }

  console.log("\nB · nível 1 — fabricanteId já preenchido nunca é tocado, só reporta divergência");
  {
    const fabricanteAtual: FabricanteParaResolverFabricante = { id: "fAtual", nomeNormalizado: normalizarTitularAimGarantia("Merck Sharp & Dohme, Lda.")! };
    const m = mapas({ fabricantesPorNomeNormalizado: new Map([[fabricanteAtual.nomeNormalizado, fabricanteAtual]]) });

    const semRegisto = resolverFabricantePorCnp(
      produto({ fabricanteIdExistente: "fAtual", fabricanteExistenteNomeNormalizado: fabricanteAtual.nomeNormalizado }),
      null, null, true, m,
    );
    eq(semRegisto, { tipo: "ja_tem_fabricante", divergente: false }, "B1: já tem fabricante, sem registo — nunca divergente");

    const bate = resolverFabricantePorCnp(
      produto({ fabricanteIdExistente: "fAtual", fabricanteExistenteNomeNormalizado: fabricanteAtual.nomeNormalizado }),
      { titularAim: "Merck Sharp & Dohme, Lda.", estadoAim: "Autorizado" }, null, true, m,
    );
    eq(bate, { tipo: "ja_tem_fabricante", divergente: false }, "B2: titular normaliza para o MESMO nome do fabricante já associado — não é divergência");

    const diverge = resolverFabricantePorCnp(
      produto({ fabricanteIdExistente: "fAtual", fabricanteExistenteNomeNormalizado: fabricanteAtual.nomeNormalizado }),
      { titularAim: "Bayer Portugal, Lda.", estadoAim: "Autorizado" }, null, true, m,
    );
    eq(diverge, { tipo: "ja_tem_fabricante", divergente: true }, "B3: titular normaliza para um nome DIFERENTE do fabricante associado — divergência reportada, nunca escrita");
  }

  console.log("\nC · nível 2 — camposManuais protege, mesmo com titularAim perfeitamente resolúvel");
  {
    const fab: FabricanteParaResolverFabricante = { id: "f1", nomeNormalizado: "BAYER PORTUGAL LDA" };
    const m = mapas({ fabricantesPorNomeNormalizado: new Map([[fab.nomeNormalizado, fab]]) });
    const r = resolverFabricantePorCnp(
      produto({ camposManuais: ["fabricanteId"] }),
      { titularAim: "Bayer Portugal, Lda.", estadoAim: "Autorizado" }, null, true, m,
    );
    eq(r, { tipo: "protegido_manual" }, "C1: camposManuais inclui fabricanteId — nunca resolve, mesmo com match perfeito disponível");
  }

  console.log("\nD · níveis 3/4 — fora do universo INFARMED / sem RegulatoryRecord: só ERP, nunca inventa");
  {
    const m = mapas();
    const semRegistoSemErp = resolverFabricantePorCnp(produto({ cnp: 1500000 }), null, null, false, m);
    eq(semRegistoSemErp, { tipo: "sem_fonte", motivo: "FORA_UNIVERSO_INFARMED" }, "D1: CNP < 2M sem fabricante de origem — motivo explícito, nunca inventado");

    const cnpRealSemRegisto = resolverFabricantePorCnp(produto({ cnp: 8000000 }), null, null, true, m);
    eq(cnpRealSemRegisto, { tipo: "sem_fonte", motivo: "SEM_REGISTO_CATALOGO" }, "D2: CNP catalogável mas sem RegulatoryRecord — motivo explícito");

    const fabErp: FabricanteParaResolverFabricante = { id: "fOrigem", nomeNormalizado: "GENERICOS PORTUGUESES LDA" };
    const mComOrigem = mapas({ fabricantesPorNomeNormalizado: new Map([[fabErp.nomeNormalizado, fabErp]]) });
    const comOrigem = resolverFabricantePorCnp(produto({ cnp: 1500000 }), null, "Genéricos Portugueses, Lda.", false, mComOrigem);
    eq(comOrigem, { tipo: "resolvido_existente", fabricanteId: "fOrigem", via: "nome_normalizado", criarAliasNormalizado: null, estadoAim: null }, "D3: CNP < 2M MAS com fabricante de origem/ERP — resolve por ele, nunca fica sem fonte à toa");
  }

  console.log("\nE · nível 5c — mais de um Fabricante reclama o MESMO alias: ambíguo, nunca escolhido");
  {
    const fA: FabricanteParaResolverFabricante = { id: "fA", nomeNormalizado: "LABORATORIOS A LDA" };
    const fB: FabricanteParaResolverFabricante = { id: "fB", nomeNormalizado: "LABORATORIOS B LDA" };
    const m = mapas({ fabricantesPorAlias: new Map([["MARCA PARTILHADA", [fA, fB]]]) });
    const r = resolverFabricantePorCnp(produto(), { titularAim: "Marca Partilhada", estadoAim: "Autorizado" }, null, true, m);
    eq(r, { tipo: "ambiguo", motivo: "alias_multiplo", nomeNormalizado: "MARCA PARTILHADA", candidatos: [{ fabricanteId: "fA", nomeNormalizado: "LABORATORIOS A LDA" }, { fabricanteId: "fB", nomeNormalizado: "LABORATORIOS B LDA" }] }, "E1: alias reclamado por 2 fabricantes — ambíguo, nunca escolhe arbitrariamente, e o relatório sabe QUAIS os candidatos");
  }

  console.log("\nF · nível 5d — plano curado: reutiliza canónico existente e cria alias; ou cria o canónico do plano se ainda não existir");
  {
    const tituloOrigem = "Alfa Wassermann Produtos Farmaceuticos, Lda.";
    const normOrigem = normalizarTitularAimGarantia(tituloOrigem)!;
    const fCanonico: FabricanteParaResolverFabricante = { id: "fCan", nomeNormalizado: "ALFASIGMA PORTUGAL LDA" };
    const m1 = mapas({
      fabricantesPorNomeNormalizado: new Map([[fCanonico.nomeNormalizado, fCanonico]]),
      mapeamentoCurado: new Map([[normOrigem, fCanonico.nomeNormalizado]]),
    });
    const r1 = resolverFabricantePorCnp(produto(), { titularAim: tituloOrigem, estadoAim: "Anulado" }, null, true, m1);
    eq(r1, { tipo: "resolvido_existente", fabricanteId: "fCan", via: "plano_curado", criarAliasNormalizado: normOrigem, estadoAim: "Anulado" }, "F1: plano curado aponta para um canónico que já existe — reutiliza-o e marca o alias para criar (idempotência)");

    const tituloAntigo = "Nome Antigo, Lda.";
    const normAntigo = normalizarTitularAimGarantia(tituloAntigo)!;
    const m2 = mapas({ mapeamentoCurado: new Map([[normAntigo, "NOME NOVO CANONICO LDA"]]) });
    const r2 = resolverFabricantePorCnp(produto(), { titularAim: tituloAntigo, estadoAim: "Revogado" }, null, true, m2);
    eq(r2, { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: "NOME NOVO CANONICO LDA", criarAliasNormalizado: normAntigo, estadoAim: "Revogado" }, "F2: plano curado aponta para um canónico que AINDA não existe — cria pelo nome canónico do plano, nunca pelo nome bruto do titular, e arrasta o nome antigo para criar como alias assim que o canónico existir");
  }

  console.log("\nG · estado histórico (Anulado/Revogado) resolve na mesma — nunca é tratado como 'sem fonte'");
  {
    const fab: FabricanteParaResolverFabricante = { id: "f1", nomeNormalizado: "LABORATORIO DESCONTINUADO LDA" };
    const m = mapas({ fabricantesPorNomeNormalizado: new Map([[fab.nomeNormalizado, fab]]) });
    const r = resolverFabricantePorCnp(produto(), { titularAim: "Laboratório Descontinuado, Lda.", estadoAim: "Revogado" }, null, true, m);
    eq(r, { tipo: "resolvido_existente", fabricanteId: "f1", via: "nome_normalizado", criarAliasNormalizado: null, estadoAim: "Revogado" }, "G1: estadoAim Revogado — resolve pela mesma via, o resolver nunca despreza um titular histórico");
  }

  console.log("\nH · nível 6 — titular inválido/vazio, sem origem: sem fonte com motivo TITULAR_INVALIDO/FABRICANTE_NAO_INFORMADO_PELA_ORIGEM");
  {
    const m = mapas();
    const titularVazio = resolverFabricantePorCnp(produto(), { titularAim: "", estadoAim: "Autorizado" }, null, true, m);
    eq(titularVazio, { tipo: "sem_fonte", motivo: "FABRICANTE_NAO_INFORMADO_PELA_ORIGEM" }, "H1: titularAim vazio (string) e sem origem — motivo explícito");

    const titularSoSimbolos = resolverFabricantePorCnp(produto(), { titularAim: "###", estadoAim: "Autorizado" }, null, true, m);
    eq(titularSoSimbolos, { tipo: "sem_fonte", motivo: "TITULAR_INVALIDO" }, "H2: titularAim presente mas normaliza para nada válido (só símbolos) — TITULAR_INVALIDO, distinto de vazio");

    const titularNull = resolverFabricantePorCnp(produto(), { titularAim: null, estadoAim: "Autorizado" }, null, true, m);
    eq(titularNull, { tipo: "sem_fonte", motivo: "FABRICANTE_NAO_INFORMADO_PELA_ORIGEM" }, "H3: titularAim null e sem origem — motivo explícito");
  }

  console.log("\nI · regra geral 4 (prefixo truncado) — caso REAL Pharmakern: dois Fabricante reais, nenhum exacto, um é PREFIXO inequívoco");
  {
    // Valores REAIS observados em produção (.local-data/fabricantes-garantia/
    // produtos-fabricantes-garantia.json, export read-only de 2026-09-22):
    //   cmtjw4ibi1sjn01th3tkd19wk → "PHARMAKERN PORTUGAL LDA" (9 produtos)
    //   cmtjw5pwg1wo701theb361fbl → "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIE" (23 produtos, truncado a 48 chars)
    // Nenhuma decisão curada existe no repositório para estes dois IDs — a
    // resolução aqui vem exclusivamente da regra geral (prefixo), nunca de
    // uma excepção codificada para "Pharmakern".
    const titularReal = "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.";
    const normReal = normalizarTitularAimGarantia(titularReal)!;
    const curto: FabricanteParaResolverFabricante = { id: "cmtjw4ibi1sjn01th3tkd19wk", nomeNormalizado: "PHARMAKERN PORTUGAL LDA" };
    const truncado: FabricanteParaResolverFabricante = { id: "cmtjw5pwg1wo701theb361fbl", nomeNormalizado: "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIE" };
    check(normReal.startsWith(truncado.nomeNormalizado), "I0: o valor truncado REAL é mesmo um prefixo por caracteres do titular normalizado completo (confirma a premissa do teste)", normReal);
    check(!normReal.startsWith(curto.nomeNormalizado), "I0b: o nome curto REAL não é prefixo do titular completo (não deve entrar como candidato)", normReal);

    const m = mapas({ fabricantesTodos: [curto, truncado] });
    const r = resolverFabricantePorCnp(produto({ cnp: 5701651 }), { titularAim: titularReal, estadoAim: "Autorizado" }, null, true, m);
    eq(
      r,
      { tipo: "resolvido_existente", fabricanteId: "cmtjw5pwg1wo701theb361fbl", via: "prefixo_truncado", criarAliasNormalizado: normReal, estadoAim: "Autorizado" },
      "I1: CNP 5701651 RESOLVE (não ambíguo) para o Fabricante truncado real, pela regra geral de prefixo — nunca um terceiro, nunca escolha por heurística de nome curto/produtos",
    );
  }

  console.log("\nI2 · regra geral 4 (prefixo) — dois candidatos truncados de comprimentos DIFERENTES: vence o mais longo; do MESMO comprimento: ambíguo, com candidatos no relatório");
  {
    const alvo = "EMPRESA FARMACEUTICA EXEMPLO SOCIEDADE UNIPESSOAL LDA";
    const curto: FabricanteParaResolverFabricante = { id: "fCurto", nomeNormalizado: "EMPRESA FARMACEUTICA EXEMPLO" };
    const longo: FabricanteParaResolverFabricante = { id: "fLongo", nomeNormalizado: "EMPRESA FARMACEUTICA EXEMPLO SOCIEDADE" };
    const mVenceLongo = mapas({ fabricantesTodos: [curto, longo] });
    const rVenceLongo = resolverFabricantePorCnp(produto(), { titularAim: alvo, estadoAim: "Autorizado" }, null, true, mVenceLongo);
    eq(rVenceLongo, { tipo: "resolvido_existente", fabricanteId: "fLongo", via: "prefixo_truncado", criarAliasNormalizado: alvo, estadoAim: "Autorizado" }, "I2a: dois prefixos válidos, comprimentos diferentes — vence sempre o MAIS LONGO");

    // Um empate REAL de comprimento exigiria dois candidatos com o
    // MESMO texto (dois prefixos válidos e distintos do MESMO alvo, do
    // MESMO comprimento, são necessariamente o MESMO texto) — o que
    // `Fabricante.nomeNormalizado @unique` torna impossível na base
    // real. Testado aqui como defesa em profundidade (duas linhas
    // hipotéticas, ids diferentes, MESMO nome) — nunca deve ocorrer em
    // produção, mas o código tem de recusar escolher mesmo assim.
    const empateA: FabricanteParaResolverFabricante = { id: "fEmpateA", nomeNormalizado: "EMPRESA FARMACEUTICA EXEMPLO SOCIEDADE" };
    const empateB: FabricanteParaResolverFabricante = { id: "fEmpateB", nomeNormalizado: "EMPRESA FARMACEUTICA EXEMPLO SOCIEDADE" };
    const mEmpatado = mapas({ fabricantesTodos: [empateA, empateB] });
    const rEmpatado = resolverFabricantePorCnp(produto(), { titularAim: alvo, estadoAim: "Autorizado" }, null, true, mEmpatado);
    check(rEmpatado.tipo === "ambiguo" && rEmpatado.motivo === "prefixo_empatado" && rEmpatado.candidatos.length === 2, "I2c: empate no comprimento máximo — ambíguo, nunca escolhe arbitrariamente, candidatos incluídos no resultado", JSON.stringify(rEmpatado));
  }

  console.log("\nI3 · regra geral 4 (prefixo) — candidato demasiado curto (abaixo do limiar) nunca entra como candidato");
  {
    const curtoDemais: FabricanteParaResolverFabricante = { id: "fCurtissimo", nomeNormalizado: "LDA" };
    const m = mapas({ fabricantesTodos: [curtoDemais] });
    const r = resolverFabricantePorCnp(produto(), { titularAim: "Laboratorios Da Alguma Coisa Lda", estadoAim: "Autorizado" }, null, true, m);
    check(r.tipo === "resolvido_criar_novo", "I3: candidato curtíssimo ('LDA') nunca conta como prefixo válido — cria novo em vez de associar por coincidência genérica", JSON.stringify(r));
  }

  console.log("\nJ · regra geral 5 (evidência de portefólio) — vencedor inequívoco resolve; empate é ambíguo");
  {
    const alvo = normalizarTitularAimGarantia("Titular Sem Match Direto Nem Prefixo Lda")!;
    const fA: FabricanteParaResolverFabricante = { id: "fA", nomeNormalizado: "OUTRO NOME QUALQUER A LDA" };
    const fB: FabricanteParaResolverFabricante = { id: "fB", nomeNormalizado: "OUTRO NOME QUALQUER B LDA" };

    const mVencedor = mapas({
      evidenciaPortfolioPorNomeNormalizado: new Map([[alvo, [{ fabricanteId: "fA", nomeNormalizado: fA.nomeNormalizado, contagem: 5 }, { fabricanteId: "fB", nomeNormalizado: fB.nomeNormalizado, contagem: 2 }]]]),
    });
    const rVencedor = resolverFabricantePorCnp(produto(), { titularAim: "Titular Sem Match Direto Nem Prefixo Lda", estadoAim: "Autorizado" }, null, true, mVencedor);
    eq(rVencedor, { tipo: "resolvido_existente", fabricanteId: "fA", via: "evidencia_portfolio", criarAliasNormalizado: null, estadoAim: "Autorizado" }, "J1: 5 produtos vs 2 — vencedor inequívoco, nunca cria um novo Fabricante quando já há evidência real forte");

    const mEmpatado = mapas({
      evidenciaPortfolioPorNomeNormalizado: new Map([[alvo, [{ fabricanteId: "fA", nomeNormalizado: fA.nomeNormalizado, contagem: 3 }, { fabricanteId: "fB", nomeNormalizado: fB.nomeNormalizado, contagem: 3 }]]]),
    });
    const rEmpatado = resolverFabricantePorCnp(produto(), { titularAim: "Titular Sem Match Direto Nem Prefixo Lda", estadoAim: "Autorizado" }, null, true, mEmpatado);
    check(rEmpatado.tipo === "ambiguo" && rEmpatado.motivo === "evidencia_portfolio_empatada", "J2: 3 vs 3 — empate real, ambíguo, nunca escolhe arbitrariamente nem cria um terceiro", JSON.stringify(rEmpatado));
  }

  console.log("\nK · regras gerais 4/5 nunca disparam sem sinal — produto genuinamente novo continua a criar (regra 6), como antes");
  {
    const m = mapas({ fabricantesTodos: [{ id: "fOutro", nomeNormalizado: "COMPLETAMENTE DIFERENTE LDA" }] });
    const r = resolverFabricantePorCnp(produto(), { titularAim: "Novo Titular Nunca Visto Lda", estadoAim: "Autorizado" }, null, true, m);
    check(r.tipo === "resolvido_criar_novo", "K1: sem prefixo válido, sem evidência — continua a criar normalmente, comportamento inalterado");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
