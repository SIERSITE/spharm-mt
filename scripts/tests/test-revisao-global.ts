/**
 * scripts/tests/test-revisao-global.ts
 *
 * O workflow das divergências globais: listar, filtrar, resolver — e o
 * que a resolução NÃO pode fazer.
 *
 * ── O que estas asserções guardam ────────────────────────────────────
 *
 * `CatalogoGlobalRevisao` era escrita e nunca lida. Ao dar-lhe um
 * caminho de escrita novo, três coisas passam a poder correr mal em
 * silêncio, e são estas três que o ficheiro fixa:
 *
 *   1. uma resolução sem autor ou sem motivo passar — e ficar na base uma
 *      linha marcada como tratada que não diz por quem nem porquê;
 *   2. uma segunda resolução sobrepor a primeira sem ninguém dar por
 *      isso, apagando a decisão de outra pessoa;
 *   3. o ecrã de triagem começar a escrever classificações.
 *
 * Sem base de dados e sem rede: o cliente do control plane é injectado.
 *
 * Corre com:  npm run test:revisao-global
 */
import {
  contarPorSnapshot,
  duplicadosRevisoesGlobais,
  encerrarFalsosConflitos,
  listarRevisoesGlobais,
  resolverRevisaoGlobal,
  resumoRevisoesGlobais,
  SNAPSHOT_SEM_CLASSIFICACAO,
  validarPedidoResolucao,
  type ClienteControl,
} from "../../lib/catalog/revisao-global";

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

// ─────────────────────────────────────────────────────────────────────
// O control plane falso
// ─────────────────────────────────────────────────────────────────────

type Linha = {
  id: string;
  cnp: number;
  tenantSlug: string;
  tipo: string;
  valorGlobal: string | null;
  valorLocal: string | null;
  detalhe: string | null;
  detectadoEm: Date;
  resolvidoEm: Date | null;
  resolucao: string | null;
  resolvidoPor: string | null;
  produto: {
    categoria: string | null; subcategoria: string | null;
    origem: string; confidence: number; versaoRegras: string;
  } | null;
};

const linha = (over: Partial<Linha> = {}): Linha => ({
  id: "r1",
  cnp: 2_000_101,
  tenantSlug: "garantia",
  tipo: "CLASSIFICACAO",
  valorGlobal: "MEDICAMENTOS > Diabetes",
  valorLocal: "MEDICAMENTOS > Dor e Febre",
  detalhe: "o tenant tem uma classificação específica diferente da global",
  detectadoEm: new Date("2026-09-01T10:00:00Z"),
  resolvidoEm: null,
  resolucao: null,
  resolvidoPor: null,
  produto: {
    categoria: "MEDICAMENTOS", subcategoria: "Diabetes",
    origem: "MODELO", confidence: 0.93, versaoRegras: "ke-2.0",
  },
  ...over,
});

type Falso = { cliente: ClienteControl; linhas: Linha[]; updates: number };

/** Avalia os `where` que este módulo constrói, e só esses. */
function bate(l: Linha, w: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(w)) {
    // Filtro sobre a relacao: `produto: { categoria: { not: null } }`.
    // Suporta-se o unico predicado que o modulo usa — `{ not: null }` —
    // e nada mais: um duplo que aceitasse predicados que o codigo nao
    // escreve dava confianca sobre consultas que ninguem faz.
    if (k === "produto") {
      const campos = v as Record<string, { not: null }>;
      for (const campo of Object.keys(campos)) {
        const actual = (l.produto as unknown as Record<string, unknown> | null)?.[campo] ?? null;
        if (actual === null) return false;
      }
      continue;
    }
    if (k === "resolvidoEm") {
      if (v === null && l.resolvidoEm !== null) return false;
      if (v !== null && typeof v === "object" && "not" in (v as object)) {
        if (l.resolvidoEm === null) return false;
      }
      continue;
    }
    if ((l as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

function controlFalso(linhas: Linha[]): Falso {
  const f: Falso = { cliente: null as unknown as ClienteControl, linhas, updates: 0 };

  const agrupar = (campo: "tenantSlug" | "tipo" | "cnp", w: Record<string, unknown>) => {
    const m = new Map<string, { chave: unknown; n: number; l: Linha }>();
    for (const l of linhas.filter((x) => bate(x, w))) {
      const k = String(l[campo]);
      const e = m.get(k);
      if (e) e.n++;
      else m.set(k, { chave: l[campo], n: 1, l });
    }
    return m;
  };

  f.cliente = {
    catalogoGlobalRevisao: {
      findMany: async (a: {
        where: Record<string, unknown>; skip?: number; take?: number;
      }) => {
        const r = linhas.filter((l) => bate(l, a.where));
        return r.slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? r.length));
      },
      count: async (a: { where: Record<string, unknown> }) =>
        linhas.filter((l) => bate(l, a.where)).length,
      findFirst: async (a: { where: Record<string, unknown> }) =>
        linhas.filter((l) => bate(l, a.where))
          .sort((x, y) => x.detectadoEm.getTime() - y.detectadoEm.getTime())[0] ?? null,
      findUnique: async (a: { where: { id: string } }) =>
        linhas.find((l) => l.id === a.where.id) ?? null,
      groupBy: async (a: {
        by: string[]; where: Record<string, unknown>; having?: unknown;
      }) => {
        if (a.by.length === 3) {
          // duplicados: (cnp, tenantSlug, tipo) com mais do que uma linha
          const m = new Map<string, { l: Linha; n: number }>();
          for (const l of linhas.filter((x) => bate(x, a.where))) {
            const k = `${l.cnp}|${l.tenantSlug}|${l.tipo}`;
            const e = m.get(k);
            if (e) e.n++;
            else m.set(k, { l, n: 1 });
          }
          return [...m.values()]
            .filter((e) => e.n > 1)
            .map((e) => ({
              cnp: e.l.cnp, tenantSlug: e.l.tenantSlug, tipo: e.l.tipo,
              _count: { _all: e.n },
            }));
        }
        const campo = a.by[0] as "tenantSlug" | "tipo";
        return [...agrupar(campo, a.where).values()].map((e) => ({
          [campo]: e.chave, _count: { _all: e.n },
        }));
      },
      updateMany: async (a: {
        where: Record<string, unknown>;
        data: { resolvidoEm: Date; resolucao: string; resolvidoPor: string };
      }) => {
        f.updates++;
        const alvo = linhas.filter((l) => bate(l, a.where));
        for (const l of alvo) {
          l.resolvidoEm = a.data.resolvidoEm;
          l.resolucao = a.data.resolucao;
          l.resolvidoPor = a.data.resolvidoPor;
        }
        return { count: alvo.length };
      },
    },
  } as unknown as ClienteControl;

  return f;
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ── 1. A validação, sozinha ────────────────────────────────────────
  console.log("\n=== validação do pedido ===");
  {
    const semAprovador = validarPedidoResolucao({ id: "r1", motivo: "está certo" });
    check(!semAprovador.ok, "sem aprovador é recusado");
    check(
      !semAprovador.ok && /aprovador/i.test(semAprovador.erro),
      "…e o erro diz qual falta",
      !semAprovador.ok ? semAprovador.erro : "",
    );

    const semMotivo = validarPedidoResolucao({ id: "r1", aprovador: "Bruno" });
    check(!semMotivo.ok, "sem motivo é recusado");
    check(
      !semMotivo.ok && /motivo/i.test(semMotivo.erro),
      "…e o erro diz qual falta",
      !semMotivo.ok ? semMotivo.erro : "",
    );

    // Um espaço não é um nome. Sem `trim` antes de medir, "  " passava.
    check(
      !validarPedidoResolucao({ id: "r1", aprovador: "   ", motivo: "x" }).ok,
      "aprovador só com espaços é recusado",
    );
    check(
      !validarPedidoResolucao({ id: "r1", aprovador: "Bruno", motivo: "  " }).ok,
      "motivo só com espaços é recusado",
    );
    check(!validarPedidoResolucao({ aprovador: "Bruno", motivo: "x" }).ok, "sem id é recusado");

    const bom = validarPedidoResolucao({ id: " r1 ", aprovador: " Bruno ", motivo: " ok " });
    check(bom.ok, "pedido completo é aceite");
    check(
      bom.ok && bom.limpo.id === "r1" && bom.limpo.aprovador === "Bruno" && bom.limpo.motivo === "ok",
      "…e vem aparado",
      bom.ok ? JSON.stringify(bom.limpo) : "",
    );
  }

  // ── 2. Listagem e filtros ──────────────────────────────────────────
  console.log("\n=== listagem e filtros ===");
  {
    const f = controlFalso([
      linha({ id: "r1", cnp: 2_000_101, tenantSlug: "garantia" }),
      linha({ id: "r2", cnp: 2_000_102, tenantSlug: "silveira" }),
      linha({ id: "r3", cnp: 2_000_103, tenantSlug: "silveira", tipo: "UTILIZACAO" }),
      linha({
        id: "r4", cnp: 2_000_104, tenantSlug: "garantia",
        resolvidoEm: new Date("2026-09-05T09:00:00Z"),
        resolucao: "o global estava certo", resolvidoPor: "Bruno",
      }),
    ]);

    const pend = await listarRevisoesGlobais({}, f.cliente);
    check(pend.total === 3, `por omissão só as pendentes (${pend.total})`);
    check(!pend.linhas.some((l) => l.resolvidoEm !== null), "…e nenhuma resolvida entrou");

    const res = await listarRevisoesGlobais({ estado: "RESOLVIDA" }, f.cliente);
    check(res.total === 1 && res.linhas[0].id === "r4", `filtro RESOLVIDA (${res.total})`);
    check(
      res.linhas[0].resolvidoPor === "Bruno",
      `…e traz quem resolveu (${res.linhas[0].resolvidoPor})`,
    );

    const todas = await listarRevisoesGlobais({ estado: "TODAS" }, f.cliente);
    check(todas.total === 4, `filtro TODAS (${todas.total})`);

    const porTenant = await listarRevisoesGlobais({ tenantSlug: "silveira" }, f.cliente);
    check(porTenant.total === 2, `filtro por tenant (${porTenant.total})`);

    const porCnp = await listarRevisoesGlobais({ cnp: 2_000_102 }, f.cliente);
    check(porCnp.total === 1 && porCnp.linhas[0].id === "r2", `filtro por CNP (${porCnp.total})`);

    const porTipo = await listarRevisoesGlobais({ tipo: "UTILIZACAO" }, f.cliente);
    check(porTipo.total === 1, `filtro por tipo (${porTipo.total})`);

    // O estado global vem junto — é metade da comparação que a página faz.
    check(
      pend.linhas[0].globalOrigem === "MODELO" && pend.linhas[0].globalConfidence === 0.93,
      "a origem e a confiança do global acompanham a linha",
    );

    const resumo = await resumoRevisoesGlobais(f.cliente);
    check(resumo.pendentes === 3 && resumo.resolvidas === 1, "o resumo conta os dois estados");
    check(
      resumo.porTenant.find((t) => t.tenantSlug === "silveira")?.n === 2,
      "…e distribui por tenant",
      JSON.stringify(resumo.porTenant),
    );
  }

  // ── 3. Resolução válida ────────────────────────────────────────────
  console.log("\n=== resolução válida ===");
  {
    const f = controlFalso([linha({ id: "r1" })]);
    const r = await resolverRevisaoGlobal(
      { id: "r1", aprovador: "Bruno Reis", motivo: "acordo local; o global fica" },
      f.cliente,
    );

    check(r.ok, "resolve", r.ok ? "" : r.erro);
    check(f.linhas[0].resolvidoEm !== null, "escreve resolvidoEm");
    check(f.linhas[0].resolvidoPor === "Bruno Reis", `escreve resolvidoPor (${f.linhas[0].resolvidoPor})`);
    check(
      f.linhas[0].resolucao === "acordo local; o global fica",
      `escreve resolucao (${f.linhas[0].resolucao})`,
    );
  }

  // ── 4. Um pedido inválido não chega à base ─────────────────────────
  console.log("\n=== pedido inválido não escreve ===");
  {
    const f = controlFalso([linha({ id: "r1" })]);
    const semAprov = await resolverRevisaoGlobal({ id: "r1", motivo: "x" }, f.cliente);
    const semMot = await resolverRevisaoGlobal({ id: "r1", aprovador: "Bruno" }, f.cliente);

    check(!semAprov.ok, "sem aprovador falha");
    check(!semMot.ok, "sem motivo falha");
    // A validação corre ANTES da escrita — não é o `where` a salvar.
    check(f.updates === 0, `nenhum update foi tentado (${f.updates})`);
    check(f.linhas[0].resolvidoEm === null, "e a linha continua por resolver");
  }

  // ── 5. A segunda resolução não sobrepõe em silêncio ────────────────
  console.log("\n=== segunda resolução ===");
  {
    const f = controlFalso([linha({ id: "r1" })]);
    await resolverRevisaoGlobal(
      { id: "r1", aprovador: "Bruno", motivo: "primeira decisão" },
      f.cliente,
    );
    const antes = { ...f.linhas[0] };

    const segunda = await resolverRevisaoGlobal(
      { id: "r1", aprovador: "Outra Pessoa", motivo: "outra decisão" },
      f.cliente,
    );

    check(!segunda.ok, "a segunda é recusada");
    check(
      !segunda.ok && segunda.jaResolvida?.resolvidoPor === "Bruno",
      "…e diz quem já a tinha resolvido",
      !segunda.ok ? String(segunda.jaResolvida?.resolvidoPor) : "",
    );
    check(f.linhas[0].resolvidoPor === "Bruno", `a autoria original ficou (${f.linhas[0].resolvidoPor})`);
    check(f.linhas[0].resolucao === antes.resolucao, "…e a resolução original também");
    check(
      f.linhas[0].resolvidoEm?.getTime() === antes.resolvidoEm?.getTime(),
      "…e a data não mexeu",
    );
    // A recusa é falada, não engolida: sem isto quem resolveu ficava a
    // pensar que a sua decisão tinha ficado registada.
    check(!segunda.ok && segunda.erro.length > 0, "e a recusa vem com motivo legível");
  }

  // ── 6. Id inexistente ──────────────────────────────────────────────
  console.log("\n=== id inexistente ===");
  {
    const f = controlFalso([linha({ id: "r1" })]);
    const r = await resolverRevisaoGlobal(
      { id: "nao-existe", aprovador: "Bruno", motivo: "x" },
      f.cliente,
    );
    check(!r.ok && /não existe/.test(r.erro), "recusa com mensagem clara", r.ok ? "" : r.erro);
  }

  // ── 7. Duplicados ──────────────────────────────────────────────────
  console.log("\n=== duplicados por resolver ===");
  {
    const f = controlFalso([
      linha({ id: "r1", cnp: 2_000_101, tenantSlug: "garantia" }),
      linha({ id: "r2", cnp: 2_000_101, tenantSlug: "garantia" }),
      linha({ id: "r3", cnp: 2_000_102, tenantSlug: "garantia" }),
    ]);
    const d = await duplicadosRevisoesGlobais(f.cliente);
    check(d.length === 1 && d[0].n === 2, `apanha o grupo repetido (${JSON.stringify(d)})`);
  }

  // ── 8. A resolução não pode ganhar poderes ─────────────────────────
  //
  // O risco desta funcionalidade não é escrever mal numa revisão: é o
  // ecrã de triagem começar, um dia, a escrever classificações.
  console.log("\n=== a resolução não toca em classificações ===");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/catalog/revisao-global.ts", "utf8");
    const codigo = src.slice(src.indexOf("// ═"));

    check(!/\.produto\.update/.test(codigo), "não escreve em Produto");
    check(!/catalogoGlobal\.(update|upsert|create)/.test(codigo), "não escreve em CatalogoGlobal");
    check(
      !/escreverClassificacao|projectarParaTenant|promoverAoGlobal/.test(src),
      "não importa nenhum dos caminhos de escrita de classificação",
    );
    // As escritas do módulo: DUAS, e as duas na tabela de revisões.
    //
    // Eram uma só até o encerramento em bloco existir. O número em si não
    // é a garantia — a garantia é que toda a escrita deste módulo passa
    // por `catalogoGlobalRevisao.updateMany` e escreve os três campos da
    // resolução. Uma escrita nova noutra tabela, ou por outro verbo, faz
    // uma destas asserções cair.
    const updates = src.match(/\.updateMany\(/g) ?? [];
    check(updates.length === 2, `duas escritas: resolver uma, encerrar em bloco (${updates.length})`);
    check(
      (src.match(/catalogoGlobalRevisao\.updateMany\(/g) ?? []).length === 2,
      "…as duas em catalogoGlobalRevisao",
    );
    check(
      !/\.(create|createMany|upsert|delete|deleteMany|update)\(/.test(codigo),
      "nenhum outro verbo de escrita no módulo",
    );
    // Os três campos, e só esses, nas duas escritas.
    const campos = src.match(/resolvidoEm: new Date\(\), resolucao: motivo, resolvidoPor: aprovador/g) ?? [];
    check(campos.length === 2, `ambas escrevem os mesmos três campos (${campos.length})`);
  }

  // ── 9. Encerramento em bloco dos falsos conflitos ──────────────────
  //
  // O criterio e' o SNAPSHOT gravado na revisao, nao o estado de hoje do
  // `CatalogoGlobal`. Em producao a diferenca eram 27 linhas: nasceram
  // falsas e o cnp entretanto ganhou classificacao global. Pelo estado de
  // hoje pareceriam conflitos e ocupavam uma pessoa com uma divergencia
  // que nunca existiu.
  console.log("\n=== encerramento em bloco: o critério é o snapshot ===");
  {
    const cenario = () =>
      controlFalso([
        // falsos: snapshot vazio, global hoje continua vazio
        linha({ id: "f1", cnp: 2_000_101, valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO,
                produto: null }),
        linha({ id: "f2", cnp: 2_000_102, tenantSlug: "silveira",
                valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO, produto: null }),
        // falso TAMBEM: nasceu vazio, o global ganhou classificacao depois
        linha({ id: "f3", cnp: 2_000_103, valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO }),
        // conflito REAL: nasceu com um global especifico
        linha({ id: "real", cnp: 2_000_104, valorGlobal: "MEDICAMENTOS > Diabetes" }),
        // ja' resolvida, com snapshot vazio: nao volta a ser tocada
        linha({ id: "ja", cnp: 2_000_105, valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO,
                resolvidoEm: new Date("2026-09-06T09:00:00Z"),
                resolucao: "decisão anterior", resolvidoPor: "Alguém" }),
      ]);

    const contagem = await contarPorSnapshot(cenario().cliente);
    check(contagem.pendentes === 4, `pendentes (${contagem.pendentes})`);
    check(contagem.falsosSnapshot === 3, `falsos pelo snapshot (${contagem.falsosSnapshot})`);
    check(
      contagem.falsosMasGlobalMudou === 1,
      `…dos quais o global já classifica (${contagem.falsosMasGlobalMudou})`,
    );
    check(contagem.conflitosReais === 1, `conflitos reais (${contagem.conflitosReais})`);

    // dry-run: conta e nao escreve
    const seco = cenario();
    const rSeco = await encerrarFalsosConflitos(
      { aprovador: "Bruno", motivo: "falso conflito" },
      seco.cliente,
    );
    check(rSeco.ok && rSeco.resumo.candidatas === 3, "dry-run conta 3 candidatas");
    check(rSeco.ok && rSeco.resumo.preservadas === 1, "…e preserva 1 conflito real");
    check(rSeco.ok && rSeco.resumo.encerradas === 0, "…e não encerra nada");
    check(seco.updates === 0, `nenhuma escrita em dry-run (${seco.updates})`);

    // apply
    const f = cenario();
    const r = await encerrarFalsosConflitos(
      { aprovador: "Bruno", motivo: "falso conflito (bug corrigido)", dryRun: false },
      f.cliente,
    );
    check(r.ok && r.resumo.encerradas === 3, `apply encerra 3 (${r.ok ? r.resumo.encerradas : "?"})`);

    const porId = new Map(f.linhas.map((l) => [l.id, l]));
    check(porId.get("f1")!.resolvidoEm !== null, "f1 encerrada");
    check(porId.get("f3")!.resolvidoEm !== null, "f3 encerrada (o global mudou, o snapshot não)");
    check(porId.get("f1")!.resolvidoPor === "Bruno", "…com autor");
    check(
      porId.get("f1")!.resolucao === "falso conflito (bug corrigido)",
      "…e com a resolução escrita",
    );

    // O que NAO pode ser tocado.
    check(porId.get("real")!.resolvidoEm === null, "o conflito real continua PENDENTE");
    check(
      porId.get("ja")!.resolvidoPor === "Alguém",
      `a resolução anterior não foi sobreposta (${porId.get("ja")!.resolvidoPor})`,
    );

    // Idempotencia: a segunda corrida nao encontra candidatas.
    const r2 = await encerrarFalsosConflitos(
      { aprovador: "Bruno", motivo: "outra vez", dryRun: false },
      f.cliente,
    );
    check(r2.ok && r2.resumo.candidatas === 0, "a segunda corrida não tem candidatas");
    check(r2.ok && r2.resumo.encerradas === 0, "…e não encerra nada");
    check(porId.get("f1")!.resolucao === "falso conflito (bug corrigido)", "…nem reescreve");
  }

  // ── 10. Também aqui não há encerramento sem autor ──────────────────
  console.log("\n=== encerramento em bloco exige aprovador e motivo ===");
  {
    const f = controlFalso([
      linha({ id: "f1", valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO, produto: null }),
    ]);
    const semAprov = await encerrarFalsosConflitos(
      { aprovador: "  ", motivo: "x", dryRun: false },
      f.cliente,
    );
    const semMot = await encerrarFalsosConflitos(
      { aprovador: "Bruno", motivo: "", dryRun: false },
      f.cliente,
    );
    check(!semAprov.ok, "sem aprovador falha");
    check(!semMot.ok, "sem motivo falha");
    check(f.updates === 0, `e nada foi escrito (${f.updates})`);
    check(f.linhas[0].resolvidoEm === null, "a linha continua pendente");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
