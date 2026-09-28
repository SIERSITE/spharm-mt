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
    eq(r2, { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: normReal!, estadoAim: "Autorizado" }, "A2: sem correspondência exacta, cria um Fabricante novo com o nome canónico do titular — nunca reaproveita fPharmakernA por semelhança");

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
    eq(r, { tipo: "ambiguo" }, "E1: alias reclamado por 2 fabricantes — ambíguo, nunca escolhe arbitrariamente");
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
    eq(r2, { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: "NOME NOVO CANONICO LDA", estadoAim: "Revogado" }, "F2: plano curado aponta para um canónico que AINDA não existe — cria pelo nome canónico do plano, nunca pelo nome bruto do titular");
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

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
