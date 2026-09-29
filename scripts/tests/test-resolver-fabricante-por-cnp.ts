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
import { calcularSimilaridadeNomes } from "../../lib/catalog/similaridade-nomes-fabricante";

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
    eq(r2, { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: normReal!, criarAliasNormalizado: null, estadoAim: "Autorizado", avisoEvidenciaEmpatada: null }, "A2: sem correspondência exacta, cria um Fabricante novo com o nome canónico do titular — nunca reaproveita fPharmakernA por semelhança");

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
    const comOrigem = resolverFabricantePorCnp(produto({ cnp: 1500000 }), null, { valor: "Genéricos Portugueses, Lda." }, false, mComOrigem);
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
    eq(r2, { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: "NOME NOVO CANONICO LDA", criarAliasNormalizado: normAntigo, estadoAim: "Revogado", avisoEvidenciaEmpatada: null }, "F2: plano curado aponta para um canónico que AINDA não existe — cria pelo nome canónico do plano, nunca pelo nome bruto do titular, e arrasta o nome antigo para criar como alias assim que o canónico existir");
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

  console.log("\nJ · regra geral 5 (evidência de portefólio) — vencedor inequívoco resolve; empate NUNCA bloqueia a criação do fabricante legal explícito (correcção Labialfarma, bloqueador 3)");
  {
    const alvo = normalizarTitularAimGarantia("Titular Sem Match Direto Nem Prefixo Lda")!;
    const fA: FabricanteParaResolverFabricante = { id: "fA", nomeNormalizado: "OUTRO NOME QUALQUER A LDA" };
    const fB: FabricanteParaResolverFabricante = { id: "fB", nomeNormalizado: "OUTRO NOME QUALQUER B LDA" };

    const mVencedor = mapas({
      evidenciaPortfolioPorNomeNormalizado: new Map([[alvo, [{ fabricanteId: "fA", nomeNormalizado: fA.nomeNormalizado, contagem: 5 }, { fabricanteId: "fB", nomeNormalizado: fB.nomeNormalizado, contagem: 2 }]]]),
    });
    const rVencedor = resolverFabricantePorCnp(produto(), { titularAim: "Titular Sem Match Direto Nem Prefixo Lda", estadoAim: "Autorizado" }, null, true, mVencedor);
    eq(rVencedor, { tipo: "resolvido_existente", fabricanteId: "fA", via: "evidencia_portfolio", criarAliasNormalizado: null, estadoAim: "Autorizado" }, "J1: 5 produtos vs 2 — vencedor inequívoco, nunca cria um novo Fabricante quando já há evidência real forte");

    // Empate real (3 vs 3): um sinal INDIRECTO e inconclusivo — ao
    // contrário de alias_multiplo/prefixo_empatado (sinais DIRECTOS,
    // onde o nome do titular aponta para os próprios candidatos), aqui
    // os candidatos ("OUTRO NOME QUALQUER A/B LDA") não têm nenhuma
    // relação textual com o titular ("Titular Sem Match..."). Bloquear
    // seria recusar criar o fabricante legal EXPLÍCITO do titular só
    // por causa de uma inconsistência histórica de OUTROS produtos —
    // por isso resolve por criação, e os candidatos empatados vão para
    // `avisoEvidenciaEmpatada` (transparência, nunca bloqueio).
    const mEmpatado = mapas({
      evidenciaPortfolioPorNomeNormalizado: new Map([[alvo, [{ fabricanteId: "fA", nomeNormalizado: fA.nomeNormalizado, contagem: 3 }, { fabricanteId: "fB", nomeNormalizado: fB.nomeNormalizado, contagem: 3 }]]]),
    });
    const rEmpatado = resolverFabricantePorCnp(produto(), { titularAim: "Titular Sem Match Direto Nem Prefixo Lda", estadoAim: "Autorizado" }, null, true, mEmpatado);
    eq(
      rEmpatado,
      { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: alvo, criarAliasNormalizado: null, estadoAim: "Autorizado", avisoEvidenciaEmpatada: [{ fabricanteId: "fA", nomeNormalizado: fA.nomeNormalizado, contagem: 3 }, { fabricanteId: "fB", nomeNormalizado: fB.nomeNormalizado, contagem: 3 }] },
      "J2: 3 vs 3 — empate real de evidência NUNCA bloqueia sozinho; cria o fabricante legal do titular e regista o empate como aviso (nunca escolhe arbitrariamente entre fA/fB, nunca finge que não houve empate)",
    );

    // Se, ALÉM do empate de evidência, houver TAMBÉM um alias múltiplo
    // ou prefixo empatado (sinal DIRECTO), esse continua a bloquear —
    // só o empate de EVIDÊNCIA, sozinho, deixou de bloquear.
    const mEmpatadoComAliasMultiplo = mapas({
      fabricantesPorAlias: new Map([[alvo, [fA, fB]]]),
      evidenciaPortfolioPorNomeNormalizado: new Map([[alvo, [{ fabricanteId: "fA", nomeNormalizado: fA.nomeNormalizado, contagem: 3 }, { fabricanteId: "fB", nomeNormalizado: fB.nomeNormalizado, contagem: 3 }]]]),
    });
    const rAindaBloqueado = resolverFabricantePorCnp(produto(), { titularAim: "Titular Sem Match Direto Nem Prefixo Lda", estadoAim: "Autorizado" }, null, true, mEmpatadoComAliasMultiplo);
    check(rAindaBloqueado.tipo === "ambiguo" && rAindaBloqueado.motivo === "alias_multiplo", "J3: alias_multiplo (sinal DIRECTO) continua a bloquear mesmo com o empate de evidência também presente — só o empate de evidência sozinho deixou de bloquear", JSON.stringify(rAindaBloqueado));
  }

  console.log("\nK · regras gerais 4/5 nunca disparam sem sinal — produto genuinamente novo continua a criar (regra 6), como antes");
  {
    const m = mapas({ fabricantesTodos: [{ id: "fOutro", nomeNormalizado: "COMPLETAMENTE DIFERENTE LDA" }] });
    const r = resolverFabricantePorCnp(produto(), { titularAim: "Novo Titular Nunca Visto Lda", estadoAim: "Autorizado" }, null, true, m);
    check(r.tipo === "resolvido_criar_novo", "K1: sem prefixo válido, sem evidência — continua a criar normalmente, comportamento inalterado");
  }

  console.log("\nL · regra 4-bis (correspondência textual aproximada) — casos SINTÉTICOS, a regra é geral, não específica de nenhuma entidade");
  {
    // L1: candidato forte ÚNICO e comprovado — associa e cria alias.
    const fAbreviado: FabricanteParaResolverFabricante = { id: "fAbrev", nomeNormalizado: "XPTO PORTUG PROD FARM SOC UN", produtosAssociados: 4 };
    const mForte = mapas({ fabricantesTodos: [fAbreviado] });
    const rForte = resolverFabricantePorCnp(produto(), { titularAim: "Xpto Portuguesa-Prod Farm, Soc.Unipessoal Lda", estadoAim: "Autorizado" }, null, true, mForte);
    check(rForte.tipo === "resolvido_existente" && rForte.via === "correspondencia_textual" && rForte.fabricanteId === "fAbrev", "L1: candidato forte único (abreviaturas/iniciais genéricas) — associa, nunca cria um duplicado", JSON.stringify(rForte));
    check(rForte.tipo === "resolvido_existente" && rForte.criarAliasNormalizado === normalizarTitularAimGarantia("Xpto Portuguesa-Prod Farm, Soc.Unipessoal Lda"), "L1b: regista o titular actual como alias do candidato encontrado");

    // L2: nenhum candidato plausível — cria normalmente (comportamento inalterado).
    const mNenhum = mapas({ fabricantesTodos: [{ id: "fSemRelacao", nomeNormalizado: "COMPLETAMENTE SEM RELACAO LDA" }] });
    const rNenhum = resolverFabricantePorCnp(produto(), { titularAim: "Xpto Portuguesa-Prod Farm, Soc.Unipessoal Lda", estadoAim: "Autorizado" }, null, true, mNenhum);
    check(rNenhum.tipo === "resolvido_criar_novo", "L2: sem nenhum candidato textual plausível — cria normalmente");

    // L3: MÚLTIPLOS candidatos fortes, mas de ENTIDADES distintas entre si.
    // Titular "MARCA ALFA BETA GAMA LDA" partilha o suficiente com CADA
    // candidato para os dois passarem o limiar forte (>=0.6), mas os dois
    // candidatos NÃO são, entre si, a mesma entidade (score mútuo 0.5,
    // abaixo do limiar) — ambíguo, nunca escolhe o de mais produtos.
    const fGrupoX: FabricanteParaResolverFabricante = { id: "fGrupoX", nomeNormalizado: "MARCA ALFA BETA LDA", produtosAssociados: 2 };
    const fGrupoY: FabricanteParaResolverFabricante = { id: "fGrupoY", nomeNormalizado: "MARCA GAMA LDA DELTA", produtosAssociados: 9 };
    check(calcularSimilaridadeNomes(fGrupoX.nomeNormalizado, fGrupoY.nomeNormalizado) < 0.6, "L3 (premissa): os dois candidatos NÃO clusterizam entre si (score < 0.6)", String(calcularSimilaridadeNomes(fGrupoX.nomeNormalizado, fGrupoY.nomeNormalizado)));
    const mMultiplo = mapas({ fabricantesTodos: [fGrupoX, fGrupoY] });
    const rMultiplo = resolverFabricantePorCnp(produto(), { titularAim: "Marca Alfa Beta Gama Lda", estadoAim: "Autorizado" }, null, true, mMultiplo);
    check(rMultiplo.tipo === "ambiguo" && rMultiplo.motivo === "candidatos_textuais_multiplos", "L3: dois candidatos FORTES mas de clusters distintos entre si — ambíguo, NUNCA escolhe o de mais produtos (fGrupoY, 9) arbitrariamente", JSON.stringify(rMultiplo));

    // L4: candidato único FRACO (0.4-0.6) — bloqueia para revisão, nunca associa sozinho.
    const fFraco: FabricanteParaResolverFabricante = { id: "fFraco", nomeNormalizado: "QUALQUER-PROD FARM NUT LDA", produtosAssociados: 3 };
    const scoreFraco = calcularSimilaridadeNomes(normalizarTitularAimGarantia("Qualquer - Laboratorio De Produtos Farmaceuticos E Nutraceuticos SA")!, fFraco.nomeNormalizado);
    check(scoreFraco >= 0.4 && scoreFraco < 0.6, "L4 (premissa): o candidato cai mesmo na banda fraca (0.4-0.6)", String(scoreFraco));
    const mFraco = mapas({ fabricantesTodos: [fFraco] });
    const rFraco = resolverFabricantePorCnp(produto(), { titularAim: "Qualquer - Laboratorio De Produtos Farmaceuticos E Nutraceuticos SA", estadoAim: "Autorizado" }, null, true, mFraco);
    check(rFraco.tipo === "ambiguo" && rFraco.motivo === "candidatos_textuais_fracos", "L4: candidato único mas FRACO — bloqueia para revisão, nunca associa sozinho (mesmo padrão real do Labialfarma Lda→SA)", JSON.stringify(rFraco));

    // L5: candidato forte, mas MARCA diferente — nunca é sequer considerado (porta do primeiro token).
    const fMarcaDiferente: FabricanteParaResolverFabricante = { id: "fMarcaDif", nomeNormalizado: "OUTRAMARCA PORTUG PROD FARM SOC UN", produtosAssociados: 50 };
    const mMarcaDif = mapas({ fabricantesTodos: [fMarcaDiferente] });
    const rMarcaDif = resolverFabricantePorCnp(produto(), { titularAim: "Xpto Portuguesa-Prod Farm, Soc.Unipessoal Lda", estadoAim: "Autorizado" }, null, true, mMarcaDif);
    check(rMarcaDif.tipo === "resolvido_criar_novo", "L5: marca diferente (mesmo com 50 produtos) nunca é candidato — cria normalmente, nunca funde entidades de marcas distintas");

    // L6: dois candidatos FORTES que são, entre si, a MESMA entidade (variantes de grafia) — cluster único, vence o de mais evidência.
    const fVariante1: FabricanteParaResolverFabricante = { id: "fVar1", nomeNormalizado: "XPTO PORTUG P F SOC UN", produtosAssociados: 0 };
    const fVariante2: FabricanteParaResolverFabricante = { id: "fVar2", nomeNormalizado: "XPTO PORTUGUESA PRODUTOS FARMACEUTICOS SOCIE", produtosAssociados: 7 };
    const mCluster = mapas({ fabricantesTodos: [fVariante1, fVariante2] });
    const rCluster = resolverFabricantePorCnp(produto(), { titularAim: "Xpto Portuguesa-Prod Farm, Soc.Unipessoal Lda", estadoAim: "Autorizado" }, null, true, mCluster);
    check(rCluster.tipo === "resolvido_existente" && rCluster.fabricanteId === "fVar2", "L6: dois candidatos fortes que são a MESMA entidade (cluster único) — associa ao de MAIS evidência (7 produtos), nunca cria um terceiro fabricante", JSON.stringify(rCluster));
  }

  console.log("\nM · REGRESSÃO — nomes REAIS exactos da consulta à Garantia que expôs o bloqueador (Ferring 6 linhas, Labialfarma 2 linhas)");
  {
    const titularFerring = "Ferring Portuguesa-Prod Farm, Soc.Unipessoal L.da";
    const fPharmA: FabricanteParaResolverFabricante = { id: "cmtjw6ebr1zcd01thd2bftg2j", nomeNormalizado: normalizarTitularAimGarantia("FERRING PHARMACEUTICALS A S")!, produtosAssociados: 1 };
    const fPortug1: FabricanteParaResolverFabricante = { id: "cmu6b9xfs09as01qmz3ud4ez1", nomeNormalizado: normalizarTitularAimGarantia("FERRING PORTUG - P F SOC UN")!, produtosAssociados: 0 };
    const fPortug2: FabricanteParaResolverFabricante = { id: "cmtjw2ece1nbx01th7axdvqio", nomeNormalizado: normalizarTitularAimGarantia("FERRING PORTUG. - P.F. SOC. UN")!, produtosAssociados: 5 };
    const fPortugCompleto: FabricanteParaResolverFabricante = { id: "cmtl91qmldco201ny86owz0t2", nomeNormalizado: normalizarTitularAimGarantia("FERRING PORTUGUESA - PRODUTOS FARMACEUTICOS SOCIE")!, produtosAssociados: 1 };
    const fSAU1: FabricanteParaResolverFabricante = { id: "cmu6bg6l10toj01qmpei3t6yd", nomeNormalizado: normalizarTitularAimGarantia("FERRING S A U")!, produtosAssociados: 0 };
    const fSAU2: FabricanteParaResolverFabricante = { id: "cmtjw5tl61x5701thc40am3fx", nomeNormalizado: normalizarTitularAimGarantia("FERRING S.A.U.")!, produtosAssociados: 6 };

    const mFerring = mapas({ fabricantesTodos: [fPharmA, fPortug1, fPortug2, fPortugCompleto, fSAU1, fSAU2] });
    const rFerring = resolverFabricantePorCnp(produto(), { titularAim: titularFerring, estadoAim: "Ativo" }, null, true, mFerring);
    check(
      rFerring.tipo === "resolvido_existente" && rFerring.via === "correspondencia_textual" && rFerring.fabricanteId === "cmtjw2ece1nbx01th7axdvqio",
      "M1: das 6 linhas Ferring reais, associa à variante portuguesa com MAIS evidência (5 produtos, 'FERRING PORTUG. - P.F. SOC. UN') — nunca à dinamarquesa (A/S), nunca à espanhola (S.A.U.), nunca cria um Fabricante novo",
      JSON.stringify(rFerring),
    );
    check(rFerring.tipo === "resolvido_existente" && rFerring.criarAliasNormalizado === normalizarTitularAimGarantia(titularFerring), "M2: regista o titular real actual como alias da variante portuguesa escolhida");

    const titularLabialfarma = "LABIALFARMA - LABORATORIO DE PRODUTOS FARMACEUTICOS E NUTRACEUTICOS SA";
    const fLabial1: FabricanteParaResolverFabricante = { id: "cmu6em2iv8s2201qmhtwwkmk3", nomeNormalizado: normalizarTitularAimGarantia("LABIALFARMA-PROD FARM NUT LDA")!, produtosAssociados: 0 };
    const fLabial2: FabricanteParaResolverFabricante = { id: "cmtlez13anc7s01ny14g5nn6c", nomeNormalizado: normalizarTitularAimGarantia("LABIALFARMA-PROD FARM. NUT LDA")!, produtosAssociados: 1 };
    const mLabialfarma = mapas({ fabricantesTodos: [fLabial1, fLabial2] });
    const rLabialfarma = resolverFabricantePorCnp(produto(), { titularAim: titularLabialfarma, estadoAim: "Ativo" }, null, true, mLabialfarma);
    check(
      rLabialfarma.tipo === "ambiguo" && rLabialfarma.motivo === "candidatos_textuais_fracos",
      "M3: as 2 linhas Labialfarma reais (Lda) pontuam FRACO contra o titular real (SA) — a forma jurídica difere e não há prova suficiente de transformação; BLOQUEIA para revisão em vez de decidir sozinho, nunca cria uma TERCEIRA linha Labialfarma",
      JSON.stringify(rLabialfarma),
    );
    check(
      rLabialfarma.tipo === "ambiguo" && rLabialfarma.candidatos.length === 2 && rLabialfarma.candidatos.every((c) => typeof c.score === "number" && typeof c.produtosAssociados === "number"),
      "M4: o relatório recebe AMBOS os candidatos reais, cada um com id, nome, produtos e score — nunca uma alegação vazia",
      JSON.stringify(rLabialfarma),
    );
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
