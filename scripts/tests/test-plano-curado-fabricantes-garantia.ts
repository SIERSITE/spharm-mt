/**
 * scripts/tests/test-plano-curado-fabricantes-garantia.ts
 *
 * Testa DOIS módulos juntos, deliberadamente:
 *   - lib/catalog/plano-normalizacao-fabricantes-garantia.ts (leitor,
 *     puro, sem I/O em `construirMapeamentoCuradoDoPlano`);
 *   - scripts/gerar-plano-curado-fabricantes-garantia.ts (gerador
 *     offline do derivado, incluindo o filtro `do_not_merge`).
 *
 * A razão de os testar juntos: o bug real desta ronda foi um MISMATCH de
 * formato entre os dois — o leitor esperava `{origin:{canonical_id,
 * canonical_name}}` mas a fonte real (`catalog/normalizacao-fabricantes-
 * garantia`, commit 0d39253) é `{canonical_id, canonical_name_before}`,
 * sem `origin`. Por isso o primeiro dry-run real (VPS, cc11820) reportou
 * sempre "plano curado: (nenhum) — 0 mapeamentos carregados", mesmo que
 * um ficheiro fosse apontado. Este teste carrega o ARTEFACTO REAL
 * versionado nesta branch (`scripts/data/plano-curado-fabricantes-
 * garantia.json`) — não apenas fixtures sintéticas — para nunca mais
 * este mismatch passar despercebido.
 *
 * Corre com: npx tsx scripts/tests/test-plano-curado-fabricantes-garantia.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  construirMapeamentoCuradoDoPlano,
  carregarMapeamentoCuradoDoPlano,
} from "../../lib/catalog/plano-normalizacao-fabricantes-garantia";
import { gerarPlanoCurado, violaDoNotMerge } from "../gerar-plano-curado-fabricantes-garantia";
import { normalizarTitularAimGarantia } from "../../lib/catalog/fabricante-normalizacao-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

function principal() {
  console.log("A · construirMapeamentoCuradoDoPlano — formato REAL da fonte (sem `origin`, com canonical_name_before)");
  {
    const plano = {
      groups: [
        {
          canonical_id: "cCanon1",
          canonical_name_before: "Boehringer Ingelheim Animal Health Portugal Unipe",
          sources: [{ source_name: "Merial Portuguesa" }, { source_name: "Merial Portuguesa - Saude Animal Lda" }],
        },
      ],
    };
    const mapa = construirMapeamentoCuradoDoPlano(plano);
    const nomeCanonico = normalizarTitularAimGarantia(plano.groups[0].canonical_name_before)!;
    check(mapa.get(normalizarTitularAimGarantia("Merial Portuguesa")!) === nomeCanonico, "A1: fonte no formato real (canonical_name_before, sem origin) é lida correctamente");
    check(mapa.get(normalizarTitularAimGarantia("Merial Portuguesa - Saude Animal Lda")!) === nomeCanonico, "A2: segunda source do mesmo grupo também mapeada");
    check(mapa.size === 2, "A3: exactamente 2 entradas (as 2 sources, canónico nunca é chave de si próprio)");
  }

  console.log("\nB · construirMapeamentoCuradoDoPlano — nunca lança, nunca inventa");
  {
    check(construirMapeamentoCuradoDoPlano({}).size === 0, "B1: plano sem `groups` — mapa vazio, sem lançar");
    check(construirMapeamentoCuradoDoPlano({ groups: [{ canonical_id: "c1", sources: [{ source_name: "X" }] }] }).size === 0, "B2: grupo sem canonical_name_before — ignorado, nunca usa um nome vazio");
    check(construirMapeamentoCuradoDoPlano({ groups: [{ canonical_id: "c1", canonical_name_before: "Igual Lda", sources: [{ source_name: "Igual Lda" }] }] }).size === 0, "B3: source igual ao canónico (após normalizar) — não vira auto-referência inútil");
    check(construirMapeamentoCuradoDoPlano({ groups: [{ canonical_id: "c1", canonical_name_before: "X Lda", sources: ["Nome Como String"] }] }).size === 1, "B4: aceita também sources como string simples (não só {source_name})");
  }

  console.log("\nC · carregarMapeamentoCuradoDoPlano — ficheiro ausente/inválido nunca bloqueia");
  {
    check(carregarMapeamentoCuradoDoPlano(undefined).size === 0, "C1: sem path — mapa vazio");
    check(carregarMapeamentoCuradoDoPlano("/caminho/que/nao/existe.json").size === 0, "C2: ficheiro inexistente — mapa vazio, nunca lança");
  }

  console.log("\nD · gerarPlanoCurado — filtro do_not_merge (nunca junta 2 membros DISTINTOS da MESMA família)");
  {
    const fonteComViolacao = {
      do_not_merge: [["JANSSEN-CILAG", "JANSSEN FARMA"]],
      groups: [
        {
          canonical_id: "cViolacao",
          canonical_name_before: "Janssen-Cilag",
          sources: [{ source_name: "Janssen Farma" }], // junta os DOIS membros da mesma família — deve ser excluído
        },
        {
          canonical_id: "cSeguro",
          canonical_name_before: "Nome Seguro Qualquer Lda",
          sources: [{ source_name: "Nome Seguro Qualquer" }], // sem relação com do_not_merge — deve passar
        },
      ],
    };
    const gerado = gerarPlanoCurado(fonteComViolacao, { branch: "b", commit: "c", ficheiro: "f" });
    check(gerado.totalGruposExcluidosDoNotMerge === 1, "D1: exactamente 1 grupo excluído por juntar 2 membros da mesma família do_not_merge", String(gerado.totalGruposExcluidosDoNotMerge));
    check(gerado.groups.length === 1 && gerado.groups[0]!.canonical_id === "cSeguro", "D2: o grupo seguro continua no derivado");

    // Regressão do falso positivo encontrado na investigação real: um
    // rótulo do_not_merge que é PREFIXO de outro (famílias DIFERENTES)
    // nunca deve gerar uma exclusão por correspondência de substring.
    const fonteComPrefixosDeFamiliasDiferentes = {
      do_not_merge: [["JANSSEN-CILAG", "JANSSEN FARMA"], ["JANSSEN-CILAG FARMACEUTICA", "JANSSEN FARMACEUTICA PORTUGAL"]],
      groups: [
        {
          canonical_id: "cJanssenCilagFarmaceutica",
          canonical_name_before: "Janssen Cilag Farmaceut. Lda",
          sources: [{ source_name: "Janssen-Cilag Farmaceutica" }], // só 1 membro da 2ª família — nunca é violação
        },
      ],
    };
    const gerado2 = gerarPlanoCurado(fonteComPrefixosDeFamiliasDiferentes, { branch: "b", commit: "c", ficheiro: "f" });
    check(gerado2.totalGruposExcluidosDoNotMerge === 0 && gerado2.groups.length === 1, "D3: rótulo do_not_merge que é substring de outro (famílias diferentes) não causa falso positivo — regressão da investigação real");
  }

  console.log("\nE · violaDoNotMerge — só por igualdade EXACTA do nome normalizado, nunca por prefixo/substring");
  {
    const familias = [["JANSSEN-CILAG", "JANSSEN FARMA"]];
    const nomesSemViolacao = new Set([normalizarTitularAimGarantia("Janssen-Cilag Farmaceutica")!]); // contém "Janssen-Cilag" como substring, não como membro exacto
    check(!violaDoNotMerge(nomesSemViolacao, familias), "E1: substring de um membro não conta como o membro");
    const nomesComViolacao = new Set([normalizarTitularAimGarantia("Janssen-Cilag")!, normalizarTitularAimGarantia("Janssen Farma")!]);
    check(violaDoNotMerge(nomesComViolacao, familias), "E2: os DOIS membros exactos presentes — violação real");
  }

  console.log("\nF · gerarPlanoCurado — grupo sem nenhuma fonte útil é omitido (nunca gera uma entrada vazia)");
  {
    const fonte = {
      groups: [
        { canonical_id: "c1", canonical_name_before: "Nome X Lda", sources: [] },
        { canonical_id: "c2", canonical_name_before: "Nome Y Lda", sources: [{ source_name: "Nome Y LDA" }] }, // idêntico após normalizar
      ],
    };
    const gerado = gerarPlanoCurado(fonte, { branch: "b", commit: "c", ficheiro: "f" });
    check(gerado.groups.length === 0, "F1: ambos os grupos omitidos — zero sources úteis em qualquer um");
    check(gerado.totalGruposSemFonteUtilizavel === 2, "F2: contados como sem-fonte-utilizável, não como erro silencioso");
  }

  console.log("\nG · artefacto REAL versionado nesta branch — smoke test de ponta-a-ponta (o mismatch que causou \"plano curado: (nenhum)\" no dry-run real não pode voltar)");
  {
    const caminhoReal = join(__dirname, "..", "data", "plano-curado-fabricantes-garantia.json");
    check(existsSync(caminhoReal), "G0: o ficheiro do artefacto real existe nesta branch", caminhoReal);
    const mapaReal = carregarMapeamentoCuradoDoPlano(caminhoReal);
    check(mapaReal.size > 0, "G1: o artefacto real carrega para um mapa NÃO VAZIO — a regressão exacta do dry-run cc11820 nunca mais passa despercebida", `mapa.size=${mapaReal.size}`);
    check(mapaReal.size >= 150, "G2: pelo menos 150 aliases reais carregados (ordem de grandeza esperada desta fonte — 226 sources brutas no derivado, algumas colapsam por normalização partilhada entre grupos)", `mapa.size=${mapaReal.size}`);
    const alvoBoehringer = mapaReal.get(normalizarTitularAimGarantia("Merial Portuguesa")!);
    check(!!alvoBoehringer && alvoBoehringer.includes("BOEHRINGER INGELHEIM"), "G3: exemplo concreto e verificável — Merial Portuguesa aponta para o canónico Boehringer Ingelheim real", String(alvoBoehringer));
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
