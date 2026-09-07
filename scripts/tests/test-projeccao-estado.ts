/**
 * scripts/tests/test-projeccao-estado.ts
 *
 * A projecção do catálogo global deixa o produto COERENTE: se escreve
 * N1/N2, escreve também o estado que os descreve.
 *
 * ── O defeito que isto guarda ────────────────────────────────────────
 *
 * `projectarParaTenant` escrevia `classificacaoNivel1Id`,
 * `classificacaoNivel2Id` e `dataAtualizacao`, e mais nada. O produto
 * ficava classificado com `classificacaoEstado = 'AUSENTE'` — e não havia
 * rotina nenhuma que o viesse corrigir depois. Ficava assim até alguém
 * correr `catalog:sincronizar-estado` à mão.
 *
 * Mediu-se: 775 produtos na Garantia, logo a seguir a
 * `catalog:project-global`. E como `POST /api/ingest/.../products` chama a
 * MESMA função de forma síncrona, cada upload de qualquer farmácia
 * produzia casos novos — o comando de reparação nunca ia acabar.
 *
 * ── O que estas asserções fixam, para lá do estado ───────────────────
 *
 * A correcção só é segura se o CONJUNTO de produtos escritos não mudar.
 * Por isso metade deste ficheiro não é sobre o estado: é sobre as guardas
 * continuarem exactamente onde estavam — `validadoManualmente` intocável,
 * classificação específica divergente a abrir revisão em vez de ser
 * sobreposta, e a segunda passagem a não escrever nada.
 *
 * Sem base de dados e sem rede: o prisma do tenant é falso e os dois
 * acessos ao control plane são injectados.
 *
 * Corre com:  npm run test:projeccao-estado
 */
import {
  projectarParaTenant,
  type RevisaoProjeccao,
} from "../../lib/catalog/global-catalog-store";
import { carimboProjeccao } from "../../lib/catalog/projeccao-classificacao";
import { FATOR_PROJECCAO, type ConhecimentoGlobal } from "../../lib/catalog/global-catalog";
import type { PrismaClient } from "../../generated/prisma/client";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};
const quase = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ─────────────────────────────────────────────────────────────────────
// O tenant falso
// ─────────────────────────────────────────────────────────────────────

/** Uma linha de `Produto`, com as colunas que a projecção lê e escreve. */
type Linha = {
  id: string;
  cnp: number;
  designacao: string;
  validadoManualmente: boolean;
  categoria: string | null;
  subcategoria: string | null;
  productType: string | null;
  classificacaoEstado: string;
  classificacaoOrigem: string | null;
  classificacaoConfianca: number | null;
  classificacaoVersao: string | null;
};

const produto = (over: Partial<Linha> = {}): Linha => ({
  id: "p1",
  cnp: 2_000_101,
  designacao: "Ozempic 1 mg",
  validadoManualmente: false,
  categoria: null,
  subcategoria: null,
  productType: null,
  classificacaoEstado: "AUSENTE",
  classificacaoOrigem: null,
  classificacaoConfianca: null,
  classificacaoVersao: null,
  ...over,
});

const globalDiabetes = (over: Partial<ConhecimentoGlobal> = {}): ConhecimentoGlobal => ({
  cnp: 2_000_101,
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  // null de propósito: isola a escrita da classificação da do productType,
  // que tem regra própria e não é o objecto deste teste.
  productType: null,
  confidence: 0.94,
  evidenceType: "SUBSTANCIA_CONHECIDA",
  origem: "MODELO",
  versaoRegras: "ke-2.0",
  verificado: true,
  utilizacoes: [],
  ...over,
});

type Falso = {
  prisma: PrismaClient;
  linhas: Linha[];
  /** Todos os UPDATE/INSERT que chegaram à base. */
  escritas: Array<{ sql: string; args: unknown[] }>;
  revisoes: RevisaoProjeccao[];
};

function tenantFalso(linhas: Linha[]): Falso {
  const escritas: Falso["escritas"] = [];
  const revisoes: RevisaoProjeccao[] = [];

  const prisma = {
    $queryRawUnsafe: async (sql: string) => {
      // A consulta dos produtos é a única com `array_agg` — as outras
      // duas mencionam "Classificacao"/"Utilizacao" e seriam apanhadas
      // por um teste menos específico.
      if (/array_agg/.test(sql)) {
        return linhas.map((l) => ({
          id: l.id,
          cnp: l.cnp,
          designacao: l.designacao,
          validadoManualmente: l.validadoManualmente,
          categoria: l.categoria,
          subcategoria: l.subcategoria,
          productType: l.productType,
          utilizacoes: [],
          fontes: [],
          confiancas: [],
          codigoATC: null,
          dci: null,
          formaFarmaceutica: null,
          dosagem: null,
          embalagem: null,
        }));
      }
      if (/from "Classificacao" where estado/.test(sql)) {
        return [
          { id: "n1", nome: "MEDICAMENTOS", pai: null },
          { id: "n2", nome: "Diabetes", pai: "n1" },
          { id: "n2b", nome: "Dor e Febre", pai: "n1" },
        ];
      }
      if (/from "Utilizacao" where estado/.test(sql)) return [];
      throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
    },

    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      escritas.push({ sql, args });
      if (!/"classificacaoNivel1Id"/.test(sql)) return 0;

      // As colunas escritas são lidas DO SQL, não da ordem dos
      // argumentos. É o que torna este duplo capaz de falhar: com um
      // `set` que não mencione `classificacaoEstado`, a coluna não é
      // tocada aqui — tal como não seria na base. Um duplo que fosse
      // buscar os valores por posição escrevia o estado na mesma e as
      // asserções passavam sobre o código partido.
      const set = sql.slice(sql.indexOf(" set "), sql.indexOf(" where "));
      const colunas = new Map<string, unknown>();
      for (const m of set.matchAll(/"(\w+)"\s*=\s*\$(\d+)/g)) {
        colunas.set(m[1], args[Number(m[2]) - 1]);
      }

      // Espelha o WHERE da instrução real. Se alguém relaxar aquele
      // WHERE, é o teste do texto (mais abaixo) que acusa — este bloco
      // é o comportamento esperado, não a sua cópia autoritária.
      const cnpArg = /p\.cnp = \$(\d+)/.exec(sql);
      const cnp = Number(args[Number(cnpArg?.[1]) - 1]);
      const l = linhas.find((x) => x.cnp === cnp);
      if (!l) return 0;
      if (l.validadoManualmente) return 0;
      if (l.subcategoria !== null && !/^Outros /i.test(l.subcategoria)) return 0;

      const NOMES: Record<string, string> = {
        n1: "MEDICAMENTOS",
        n2: "Diabetes",
        n2b: "Dor e Febre",
      };
      const escrever = <K extends keyof Linha>(col: string, campo: K, mapear?: (v: unknown) => Linha[K]) => {
        if (!colunas.has(col)) return;
        const v = colunas.get(col);
        l[campo] = (mapear ? mapear(v) : v) as Linha[K];
      };
      escrever("classificacaoNivel1Id", "categoria", (v) => NOMES[String(v)] ?? String(v));
      escrever("classificacaoNivel2Id", "subcategoria", (v) => NOMES[String(v)] ?? String(v));
      escrever("classificacaoEstado", "classificacaoEstado");
      escrever("classificacaoOrigem", "classificacaoOrigem");
      escrever("classificacaoConfianca", "classificacaoConfianca");
      escrever("classificacaoVersao", "classificacaoVersao");
      return 1;
    },

    knowledgeEnrichmentCache: { upsert: async () => ({}) },
  } as unknown as PrismaClient;

  return { prisma, linhas, escritas, revisoes };
}

const correr = (f: Falso, global: Map<number, ConhecimentoGlobal>) =>
  projectarParaTenant(f.prisma, "garantia", {
    dryRun: false,
    controlo: {
      lerGlobal: async () => global,
      abrirRevisao: async (r) => {
        f.revisoes.push(r);
      },
    },
  });

const mapa = (...gs: ConhecimentoGlobal[]) => new Map(gs.map((g) => [g.cnp, g]));

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ── 1. O carimbo, sozinho ──────────────────────────────────────────
  console.log("\n=== o carimbo derivado do global ===");
  {
    const canonico = carimboProjeccao({
      evidenceType: "SUBSTANCIA_CONHECIDA",
      confidence: 0.94,
      versaoRegras: "ke-2.0",
    });
    check(canonico.estado === "CANONICA", `evidência forte → CANONICA (${canonico.estado})`);
    check(canonico.origem === "GLOBAL", `origem é GLOBAL (${canonico.origem})`);
    check(
      quase(canonico.confianca, 0.94 * FATOR_PROJECCAO),
      `a confiança entra reduzida por FATOR_PROJECCAO (${canonico.confianca})`,
    );
    check(canonico.versao === "ke-2.0", `a versão de regras é a do global (${canonico.versao})`);

    // A que interessa: uma provisória não vira facto ao atravessar a
    // fronteira entre tenants.
    const prov = carimboProjeccao({
      evidenceType: "CATEGORIA_PRODUTO",
      confidence: 0.9,
      versaoRegras: "ke-2.0",
    });
    check(prov.estado === "PROVISORIA", `evidência CATEGORIA_PRODUTO → PROVISORIA (${prov.estado})`);
    check(prov.origem === "GLOBAL", "…e a origem continua GLOBAL");

    // Linhas antigas do global não têm evidência registada. Ausência
    // lê-se como "não provisória", que é o lado que não inventa.
    const semEvidencia = carimboProjeccao({
      evidenceType: null,
      confidence: 0.9,
      versaoRegras: "ke-2.0",
    });
    check(semEvidencia.estado === "CANONICA", `sem evidência → CANONICA (${semEvidencia.estado})`);
  }

  // ── 2. AUSENTE + global conhecido → escreve e fica coerente ────────
  console.log("\n=== AUSENTE + N1/N2 no global → escrito e coerente ===");
  {
    const f = tenantFalso([produto()]);
    const r = await correr(f, mapa(globalDiabetes()));
    const l = f.linhas[0];

    check(r.classificacoesEscritas === 1, `escreveu a classificação (${r.classificacoesEscritas})`);
    check(l.subcategoria === "Diabetes", `N2 preenchido (${l.subcategoria})`);
    check(
      l.classificacaoEstado === "CANONICA",
      `…e o estado acompanha (${l.classificacaoEstado})`,
    );
    check(l.classificacaoOrigem === "GLOBAL", `origem GLOBAL (${l.classificacaoOrigem})`);
    check(
      quase(l.classificacaoConfianca ?? 0, 0.94 * FATOR_PROJECCAO),
      `confiança registada (${l.classificacaoConfianca})`,
    );
    check(l.classificacaoVersao === "ke-2.0", `versão registada (${l.classificacaoVersao})`);

    // O defeito original em forma de asserção: nunca mais pode existir
    // uma linha com N1/N2 preenchidos e o enum a dizer AUSENTE.
    check(
      !(l.subcategoria !== null && l.classificacaoEstado === "AUSENTE"),
      "não fica classificado-mas-AUSENTE",
      `n2=${l.subcategoria} estado=${l.classificacaoEstado}`,
    );
  }

  // ── 3. Provisória no global chega como provisória ──────────────────
  console.log("\n=== provisória no global → PROVISORIA no tenant ===");
  {
    const f = tenantFalso([produto()]);
    await correr(f, mapa(globalDiabetes({ evidenceType: "CATEGORIA_PRODUTO" })));
    check(
      f.linhas[0].classificacaoEstado === "PROVISORIA",
      `não é lavada em CANONICA (${f.linhas[0].classificacaoEstado})`,
    );
  }

  // ── 4. Local específica divergente: revisão, nunca escrita ─────────
  console.log("\n=== local específica divergente → não é sobreposta ===");
  {
    const f = tenantFalso([
      produto({
        categoria: "MEDICAMENTOS",
        subcategoria: "Dor e Febre",
        classificacaoEstado: "CANONICA",
        classificacaoOrigem: "MODELO",
      }),
    ]);
    const r = await correr(f, mapa(globalDiabetes()));
    const l = f.linhas[0];

    check(r.classificacoesEscritas === 0, `nada escrito (${r.classificacoesEscritas})`);
    check(f.escritas.length === 0, `nem uma instrução chegou à base (${f.escritas.length})`);
    check(l.subcategoria === "Dor e Febre", `a classificação local ficou (${l.subcategoria})`);
    check(l.classificacaoEstado === "CANONICA", "…e o estado dela também");
    check(r.revisoesAbertas === 1, `abriu revisão (${r.revisoesAbertas})`);
    check(
      f.revisoes[0]?.valorLocal === "MEDICAMENTOS > Dor e Febre" &&
        f.revisoes[0]?.valorGlobal === "MEDICAMENTOS > Diabetes",
      "…com os dois lados da divergência",
      JSON.stringify(f.revisoes[0] ?? null),
    );
  }

  // ── 5. validadoManualmente: intocável ──────────────────────────────
  console.log("\n=== validadoManualmente → intocável ===");
  {
    const f = tenantFalso([produto({ validadoManualmente: true })]);
    const r = await correr(f, mapa(globalDiabetes()));
    const l = f.linhas[0];

    check(r.intocaveis === 1, `contado como intocável (${r.intocaveis})`);
    check(f.escritas.length === 0, `zero escritas (${f.escritas.length})`);
    check(l.subcategoria === null, "N2 continua vazio");
    check(l.classificacaoEstado === "AUSENTE", `e o estado não foi carimbado (${l.classificacaoEstado})`);
    // Uma decisão humana no tenant também não é uma divergência a
    // arbitrar: o global não opina sobre ela.
    check(r.revisoesAbertas === 0, `nem revisão abriu (${r.revisoesAbertas})`);
  }

  // ── 6. Idempotência: a segunda passagem não faz nada ───────────────
  console.log("\n=== correr outra vez → zero alterações adicionais ===");
  {
    const f = tenantFalso([produto()]);
    const g = mapa(globalDiabetes());

    const r1 = await correr(f, g);
    const depoisDaPrimeira = JSON.stringify(f.linhas[0]);
    const escritasDaPrimeira = f.escritas.length;

    const r2 = await correr(f, g);

    check(r1.classificacoesEscritas === 1, "a primeira escreveu");
    check(r2.classificacoesEscritas === 0, `a segunda não (${r2.classificacoesEscritas})`);
    check(r2.noOp === 1, `foi reconhecida como no-op (${r2.noOp})`);
    check(
      f.escritas.length === escritasDaPrimeira,
      `nenhuma instrução nova chegou à base (${f.escritas.length - escritasDaPrimeira})`,
    );
    check(
      JSON.stringify(f.linhas[0]) === depoisDaPrimeira,
      "…e a linha ficou byte a byte igual",
      `${depoisDaPrimeira}\n            ${JSON.stringify(f.linhas[0])}`,
    );
    check(r2.revisoesAbertas === 0, `sem revisões espúrias (${r2.revisoesAbertas})`);
  }

  // ── 7. As guardas continuam no WHERE, e o carimbo no mesmo UPDATE ──
  //
  // O ponto 2 prova que o estado é escrito; este prova que é escrito na
  // MESMA instrução que N1/N2. Se alguém partir isto em dois UPDATEs, há
  // um instante em que o produto diz o contrário do que é — e um
  // relatório que corra pelo meio lê o estado errado.
  console.log("\n=== o texto da instrução ===");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/catalog/global-catalog-store.ts", "utf8");
    const i = src.indexOf('set "classificacaoNivel1Id"');
    const stmt = src.slice(i, src.indexOf("`,", i));

    check(i > 0, "a instrução de classificação existe");
    check(
      /"classificacaoEstado"\s*=/.test(stmt) &&
        /"classificacaoOrigem"\s*=/.test(stmt) &&
        /"classificacaoConfianca"\s*=/.test(stmt) &&
        /"classificacaoVersao"\s*=/.test(stmt),
      "o carimbo vai no mesmo UPDATE que N1/N2",
    );
    // As guardas, palavra por palavra. São o que garante que o conjunto
    // de produtos escritos não mudou com esta correcção.
    check(
      /p\."validadoManualmente" = false/.test(stmt),
      "a guarda de validadoManualmente continua no WHERE",
    );
    check(
      /p\."classificacaoNivel2Id" is null/.test(stmt) && /ilike 'Outros %'/.test(stmt),
      "…e a de não-degradação (null ou 'Outros X') também",
    );
  }

  // ── 8. A reparação das projecções antigas ──────────────────────────
  //
  // As linhas escritas ANTES desta correcção ficaram sem estado, e uma
  // passagem do `catalog:sincronizar-estado` carimbou-lhes
  // `ORIGEM_NAO_REGISTADA` — que era honesto quando o comando não sabia
  // ler a marca da projecção, e deixou de ser assim que passou a saber.
  console.log("\n=== a reparação da proveniência ===");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/catalog/sincronizar-estado-classificacao.ts", "utf8");

    const iProv = src.indexOf("const n0 = await prisma.$executeRawUnsafe");
    const iEnum = src.indexOf("const n1 = await prisma.$executeRawUnsafe");
    const stmt = src.slice(iProv, iEnum);

    check(iProv > 0 && iEnum > 0, "os dois passos existem");
    // A ordem É o mecanismo: ao contrário, o valor neutro entrava
    // primeiro e a reparação ficava sem nada que reparar.
    check(iProv < iEnum, "a proveniência corre ANTES do enum", `${iProv} < ${iEnum}`);

    check(
      /ORIGEM_PROJECTADA/.test(stmt) && /"GLOBAL"/.test(src),
      "escreve GLOBAL, um valor que já existia em OrigemClassificacao",
    );
    // Nunca reescreve uma proveniência verdadeira por outra.
    check(
      /"classificacaoOrigem" is null or p\."classificacaoOrigem" = \$1/.test(stmt),
      "só toca em origem vazia ou no valor neutro",
    );
    check(
      /p\."validadoManualmente" = false/.test(stmt),
      "não toca no que foi validado à mão — aí a origem é MANUAL",
    );
    // Sem isto a confiança gravada dependia do plano de execução.
    check(
      /distinct on \(cnp\)/.test(stmt),
      "escolhe uma linha de cache de forma determinística",
    );
    check(
      /coalesce\(p\."classificacaoConfianca"/.test(stmt) &&
        /coalesce\(p\."classificacaoVersao"/.test(stmt),
      "confiança e versão só preenchem o vazio",
    );
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
