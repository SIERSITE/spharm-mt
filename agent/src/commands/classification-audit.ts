/**
 * agent/src/commands/classification-audit.ts
 *
 * Auditoria ESTRITAMENTE READ-ONLY da classificação do produto numa farmácia
 * REAL (Ético / NETT / Serviço / Genérico / ...). Recolhe FACTOS para que o
 * modelo seja fixado depois, por pessoas — não conclui significados nem
 * propõe mapeamento. Toda a lógica está em `../classificacao-auditoria.ts`
 * (testada sem SQL Server); aqui só há argumentos, ligação e ficheiros.
 *
 * Garantias (ver o módulo):
 *  · só SELECT — cada query é validada (guarda read-only + sql-validador)
 *    ANTES de executar; qualquer outra coisa lança e a auditoria não a corre;
 *  · ligação com ApplicationIntent=ReadOnly (readOnlyIntent) e timeout por
 *    pedido; leituras com `WITH (NOLOCK)` para não bloquear o ERP; limite
 *    total de tempo (`--max-minutos`);
 *  · nunca imprime credenciais, anfitrião ou connection string; o relatório
 *    é sanitizado (segredos, e-mails, telefones, NIF) e nunca lê colunas cujo
 *    nome sugere dado pessoal;
 *  · não comunica com o SaaS.
 *
 * Uso (ver run-classification-audit.bat):
 *   agent classification-audit
 *   agent classification-audit --out run\audit.json
 *   agent classification-audit --out run\audit.md --cnps 1234567,7654321
 *   agent classification-audit --cnps-ficheiro cnps.txt --top 20 --max-colunas 60
 *
 * Sem `--out` grava ./run/classification-audit-<ts>.md e .json.
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import { openPool, withPool, type SqlPool } from "../sql-client.js";
import { redigir } from "../politica-retry.js";
import {
  criarLeitorSeguro,
  executarAuditoria,
  parseCnps,
  renderMarkdown,
  FRASE_READ_ONLY,
  OPCOES_OMISSAO,
  type Linha,
  type RelatorioAuditoria,
} from "../classificacao-auditoria.js";

const RULE = "═".repeat(72);

/** Pool com ApplicationIntent=ReadOnly e timeout próprio (nunca mexe em `openPool`). */
export function abrirPoolSoLeitura(cfg: AgentConfig, timeoutMs: number): SqlPool {
  const pool = openPool({ ...cfg, sqlRequestTimeoutMs: timeoutMs });
  // `config` existe em runtime (mssql ConnectionPool) mas não nos tipos; `options` é lido no connect() e passado
  // ao tedious, que traduz `readOnlyIntent` em ApplicationIntent=ReadOnly.
  const interno = pool as unknown as { config: { options?: Record<string, unknown> } };
  interno.config.options = { ...(interno.config.options ?? {}), readOnlyIntent: true };
  return pool;
}

export type SaidaAuditoria = { formato: "json" | "md"; ficheiro: string };

/** Decide onde escrever. `--out` tem de acabar em .json ou .md; sem `--out`: os dois em outDir. */
export function resolverSaidas(out: string | undefined, outDir: string, ts: string): SaidaAuditoria[] {
  if (out === undefined) {
    return [
      { formato: "md", ficheiro: path.join(outDir, `classification-audit-${ts}.md`) },
      { formato: "json", ficheiro: path.join(outDir, `classification-audit-${ts}.json`) },
    ];
  }
  const ext = path.extname(out).toLowerCase();
  if (ext !== ".json" && ext !== ".md") {
    throw new Error("--out tem de terminar em .json ou .md");
  }
  return [{ formato: ext === ".json" ? "json" : "md", ficheiro: out }];
}

/** Escreve o relatório já sanitizado; passa ainda o texto final por `redigir` (defesa em profundidade). */
export function escreverRelatorio(rel: RelatorioAuditoria, saidas: SaidaAuditoria[], segredos: string[]): string[] {
  const escritos: string[] = [];
  for (const s of saidas) {
    const texto = s.formato === "json" ? JSON.stringify(rel, null, 2) : renderMarkdown(rel);
    mkdirSync(path.dirname(path.resolve(s.ficheiro)), { recursive: true });
    writeFileSync(s.ficheiro, redigir(texto, segredos), "utf8");
    escritos.push(s.ficheiro);
  }
  return escritos;
}

export async function classificationAudit(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        out: { type: "string" },
        "out-dir": { type: "string", default: "./run" },
        top: { type: "string", default: String(OPCOES_OMISSAO.top) },
        "max-colunas": { type: "string", default: String(OPCOES_OMISSAO.maxColunas) },
        cnps: { type: "string" },
        "cnps-ficheiro": { type: "string" },
        "timeout-segundos": { type: "string", default: "60" },
        "max-minutos": { type: "string", default: "10" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`✗ Argumentos inválidos: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Uso: classification-audit [--out <ficheiro>.json|.md] [--cnps 1234567,7654321] [--cnps-ficheiro f.txt] [--top N] [--max-colunas N]");
    return 2;
  }

  const inteiro = (v: unknown, omissao: number, min: number, max: number) => {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : omissao;
  };
  const top = inteiro(values.top, OPCOES_OMISSAO.top, 5, 200);
  const maxColunas = inteiro(values["max-colunas"], OPCOES_OMISSAO.maxColunas, 5, 200);
  const timeoutMs = inteiro(values["timeout-segundos"], 60, 5, 600) * 1000;
  const orcamentoMs = inteiro(values["max-minutos"], 10, 1, 120) * 60_000;

  // CNPs conhecidos (só dígitos; nada mais do ficheiro entra no SQL nem no relatório).
  let textoCnps = String(values.cnps ?? "");
  if (values["cnps-ficheiro"]) {
    try {
      textoCnps += "\n" + readFileSync(String(values["cnps-ficheiro"]), "utf8");
    } catch {
      console.error("✗ Não foi possível ler o ficheiro de CNPs indicado em --cnps-ficheiro.");
      return 2;
    }
  }
  const { cnps, invalidos } = parseCnps(textoCnps);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  let saidas: SaidaAuditoria[];
  try {
    saidas = resolverSaidas(values.out as string | undefined, String(values["out-dir"]), ts);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(redigir(err instanceof Error ? err.message : String(err)));
    return 1;
  }
  const segredos = [cfg.sqlPassword, cfg.sqlUser, cfg.sqlHost];

  console.log(RULE);
  console.log("  Auditoria da classificação do produto (Ético · NETT · Serviço · Genérico)");
  console.log(`  ${FRASE_READ_ONLY} — só SELECT; não conclui significados.`);
  console.log(RULE);
  if (cnps.length > 0) console.log(`  CNPs conhecidos a comparar: ${cnps.length}${invalidos ? ` (${invalidos} tokens inválidos ignorados)` : ""}`);

  try {
    const rel = await withPool(
      cfg,
      async (pool) => {
        const executar = async (sql: string): Promise<Linha[]> => (await pool.request().query(sql)).recordset as unknown as Linha[];
        return executarAuditoria(criarLeitorSeguro(executar), {
          top,
          maxColunas,
          cnps,
          orcamentoMs,
          segredos,
          agentRev: process.env.AGENT_REV || "dev",
        });
      },
      { abrirPool: (c) => abrirPoolSoLeitura(c, timeoutMs) },
    );

    const escritos = escreverRelatorio(rel, saidas, segredos);

    const h = rel.cabecalho;
    const insp = rel.colunasCandidatas.filter((c) => c.inspeccao === "inspeccionada").length;
    console.log(`\n  SQL Server : ${h.sqlServer ?? "(não obtido)"}`);
    console.log(`  Base       : ${h.baseDados ?? "(não obtida)"}`);
    console.log(`  Colunas candidatas: ${rel.colunasCandidatas.length} (${insp} inspeccionadas em profundidade)`);
    console.log(`  Tabulações cruzadas: ${rel.cruzadas.length}`);
    if (rel.servicos.disponivel) {
      console.log(`  Processa_Stocks = 0: ${rel.servicos.zero} · <> 0: ${rel.servicos.diferenteDeZero} · NULL: ${rel.servicos.nulos}`);
    }
    if (rel.conhecidos.length > 0) {
      console.log(`  CNPs conhecidos encontrados: ${rel.conhecidos.filter((c) => c.encontrado).length}/${rel.conhecidos.length}`);
    }
    console.log(`  Queries executadas (todas SELECT): ${h.queriesExecutadas} · avisos: ${rel.avisos.length}`);
    console.log(`\n${RULE}`);
    for (const f of escritos) console.log(`  Relatório: ${f}`);
    console.log(RULE);
    console.log("\nNenhum significado foi concluído. O relatório é sanitizado; revê-o antes de o partilhar.");
    return 0;
  } catch (err) {
    console.error(`✗ Auditoria falhou: ${redigir(err instanceof Error ? err.message : String(err), segredos)}`);
    return 1;
  }
}
