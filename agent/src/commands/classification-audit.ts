/**
 * agent/src/commands/classification-audit.ts
 *
 * Auditoria ESTRITAMENTE READ-ONLY da classificação do produto numa farmácia
 * REAL (Genérico / Ético / NETT / Serviço / ...). Recolhe FACTOS para que o
 * modelo seja fixado depois, por pessoas — não conclui significados nem
 * propõe mapeamento. Toda a lógica está em `../classificacao-auditoria.ts`
 * (testada sem SQL Server); aqui só há argumentos, ligação e ficheiros.
 *
 * PACOTE DE DIAGNÓSTICO (base rev98), modo read-only, não instalável. Este comando
 * só é alcançável pelo entry point dedicado `../audit-cli.ts`; o `cli.ts` do agent
 * (rev98) não o conhece.
 *
 * Garantias (ver os módulos):
 *  · só SELECT — cada query é validada (`sql-somente-leitura.ts` + `sql-validador.ts`)
 *    ANTES de executar; qualquer outra coisa lança e a auditoria não a corre;
 *  · ligação com ApplicationIntent=ReadOnly (readOnlyIntent), isolamento READ UNCOMMITTED e
 *    appName identificável; timeout por pedido; leituras com `WITH (NOLOCK)` para não
 *    bloquear o ERP; limite total de tempo (`--max-minutos`). O SQL Server NÃO tem
 *    «transação read-only»; ver docs na função `abrirPoolSoLeitura`;
 *  · não adquire o lock operacional (não importa `lock-pipeline`), não usa o cliente HTTP,
 *    não fala com o SaaS, não escreve nada além do relatório pedido em `--out`;
 *  · exige `agent.config.json` na pasta de trabalho e nunca o altera;
 *  · nunca imprime credenciais, anfitrião ou connection string; o relatório
 *    é sanitizado (segredos, e-mails, telefones, NIF) e nunca lê colunas cujo
 *    nome sugere dado pessoal ou monetário.
 *
 * Uso:
 *   classification-audit --out .\output\auditoria-classificacao.json     (grava .json E .md)
 *   classification-audit --out .\output\auditoria.md --cnps 1234567,7654321
 *   classification-audit --cnps-ficheiro cnps.txt --top 20 --max-colunas 60
 *
 * Sem `--out` grava ./output/classification-audit-<ts>.json e .md.
 */

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { openPool, withPool, type SqlPool } from "../sql-client.js";
import { redigir } from "../politica-retry.js";
import {
  criarLeitorSeguro,
  executarAuditoria,
  pacoteOmissao,
  parseCnps,
  renderMarkdown,
  FRASE_READ_ONLY,
  OPCOES_OMISSAO,
  type Linha,
  type RelatorioAuditoria,
} from "../classificacao-auditoria.js";
import { commitDoPacote, FRASE_PACOTE, PACOTE_ID, versaoDoPacote } from "../diagnostico-pacote.js";

const RULE = "═".repeat(72);
export const NOME_CONFIG = "agent.config.json";
export const APP_NAME = "SPharmMT-Diagnostico-ClassificationAudit";

/**
 * Pool de LEITURA. O que o driver (mssql 12 / tedious 19) permite:
 *  · `readOnlyIntent: true` → ApplicationIntent=ReadOnly no login. Só tem efeito em Always On (encaminha para uma réplica
 *    secundária legível); num SQL Server isolado é ignorado — NÃO impede escritas;
 *  · `isolationLevel: READ_UNCOMMITTED` → o isolamento de cada pedido (leituras sem bloquear o ERP);
 *  · `appName` → a ligação aparece identificada nas ferramentas do DBA;
 *  · NÃO existe «transação read-only» em T-SQL nem no tedious. A barreira real contra escritas é o validador de SQL
 *    (todas as queries são SELECT, validadas antes de sair) e, recomendado, um login só de leitura (o relatório mostra
 *    as permissões efectivas do login).
 * Nunca mexe em `openPool`: aplica as opções à instância devolvida, antes do connect().
 */
export function abrirPoolSoLeitura(cfg: AgentConfig, timeoutMs: number): SqlPool {
  const pool = openPool({ ...cfg, sqlRequestTimeoutMs: timeoutMs });
  // `config` existe em runtime (mssql ConnectionPool) mas não nos tipos; `options` é lido no connect() e passado
  // ao tedious, que traduz `readOnlyIntent` em ApplicationIntent=ReadOnly.
  const interno = pool as unknown as { config: { options?: Record<string, unknown> } };
  interno.config.options = {
    ...(interno.config.options ?? {}),
    readOnlyIntent: true,
    isolationLevel: sql.ISOLATION_LEVEL.READ_UNCOMMITTED,
    appName: APP_NAME,
  };
  return pool;
}

export type SaidaAuditoria = { formato: "json" | "md"; ficheiro: string };

/**
 * Decide onde escrever. `--out` tem de acabar em .json ou .md e grava SEMPRE os dois (mesmo nome, extensões
 * .json e .md). Sem `--out`: os dois em outDir com carimbo de tempo.
 */
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
  const base = out.slice(0, out.length - ext.length);
  return [
    { formato: "json", ficheiro: `${base}.json` },
    { formato: "md", ficheiro: `${base}.md` },
  ];
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

export const USO =
  "Uso: classification-audit [--out <ficheiro>.json|.md] [--cnps 1234567,7654321] [--cnps-ficheiro f.txt] [--top N] [--max-colunas N]\n" +
  "     [--timeout-segundos N] [--max-minutos N]\n" +
  "  --out              relatório a gravar (.json e .md com o mesmo nome). Omissão: ./output/classification-audit-<ts>.*\n" +
  "  --cnps             CNPs conhecidos (só dígitos, separados por vírgulas) a comparar. Opcional.\n" +
  "  --cnps-ficheiro    ficheiro de texto com CNPs (um por linha ou separados por vírgulas). Opcional.\n" +
  "Requer agent.config.json na pasta de trabalho. Só executa SELECT; não escreve nada além do relatório.";

/** Dependências injetáveis (testes): tudo o que toca no exterior. */
export type DepsAuditoria = {
  argv: string[];
  cwd: string;
  loadConfig: (scope: "sql") => AgentConfig;
  withPool: typeof withPool;
  abrirPool: (cfg: AgentConfig, timeoutMs: number) => SqlPool;
  log: (linha: string) => void;
  erro: (linha: string) => void;
  agora: () => Date;
};

export function depsReais(argv: string[]): DepsAuditoria {
  return {
    argv,
    cwd: process.cwd(),
    loadConfig,
    withPool,
    abrirPool: abrirPoolSoLeitura,
    log: (l) => console.log(l),
    erro: (l) => console.error(l),
    agora: () => new Date(),
  };
}

/** `argv` = argumentos DEPOIS do nome do comando. */
export async function classificationAudit(parciais: Partial<DepsAuditoria> = {}): Promise<number> {
  const d: DepsAuditoria = { ...depsReais(process.argv.slice(3)), ...parciais };
  let values;
  try {
    ({ values } = parseArgs({
      args: d.argv,
      options: {
        out: { type: "string" },
        "out-dir": { type: "string", default: "./output" },
        top: { type: "string", default: String(OPCOES_OMISSAO.top) },
        "max-colunas": { type: "string", default: String(OPCOES_OMISSAO.maxColunas) },
        cnps: { type: "string" },
        "cnps-ficheiro": { type: "string" },
        "timeout-segundos": { type: "string", default: "60" },
        "max-minutos": { type: "string", default: "10" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    d.erro(`✗ Argumentos inválidos: ${err instanceof Error ? err.message : String(err)}`);
    d.erro(USO);
    return 2;
  }
  if (values.help) {
    d.log(`classification-audit — ${FRASE_PACOTE}`);
    d.log(USO);
    return 0;
  }

  const inteiro = (v: unknown, omissao: number, min: number, max: number) => {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : omissao;
  };
  const top = inteiro(values.top, OPCOES_OMISSAO.top, 5, 200);
  const maxColunas = inteiro(values["max-colunas"], OPCOES_OMISSAO.maxColunas, 5, 200);
  const timeoutMs = inteiro(values["timeout-segundos"], 60, 5, 600) * 1000;
  const orcamentoMs = inteiro(values["max-minutos"], 10, 1, 120) * 60_000;

  const ts = d.agora().toISOString().replace(/[:.]/g, "-");
  let saidas: SaidaAuditoria[];
  try {
    saidas = resolverSaidas(values.out as string | undefined, String(values["out-dir"]), ts);
  } catch (err) {
    d.erro(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // O pacote de diagnóstico exige o ficheiro de configuração; não cai para variáveis de ambiente / .env.
  const ficheiroConfig = path.resolve(d.cwd, NOME_CONFIG);
  if (!existsSync(ficheiroConfig)) {
    d.erro(`✗ ${NOME_CONFIG} não encontrado na pasta de trabalho (${d.cwd}).`);
    d.erro("  Este pacote de diagnóstico lê a ligação ao SQL Server desse ficheiro e não o cria nem o altera.");
    d.erro("  Corre o script de instalação (Install-ClassificationAudit.ps1), que copia o agent.config.json da rev98 para esta pasta.");
    return 1;
  }

  // CNPs conhecidos (só dígitos; nada mais do ficheiro entra no SQL nem no relatório).
  let textoCnps = String(values.cnps ?? "");
  if (values["cnps-ficheiro"]) {
    try {
      textoCnps += "\n" + readFileSync(String(values["cnps-ficheiro"]), "utf8");
    } catch {
      d.erro("✗ Não foi possível ler o ficheiro de CNPs indicado em --cnps-ficheiro.");
      return 2;
    }
  }
  const { cnps, invalidos } = parseCnps(textoCnps);

  let cfg: AgentConfig;
  try {
    cfg = d.loadConfig("sql");
  } catch (err) {
    d.erro(`✗ ${NOME_CONFIG} inválido:`);
    d.erro(redigir(err instanceof Error ? err.message : String(err)));
    return 1;
  }
  // Tudo o que é segredo ou identifica a ligação/tenant: removido de qualquer texto que saia.
  const segredos = [cfg.sqlPassword, cfg.sqlUser, cfg.sqlHost, cfg.ingestKey, cfg.tenantSlug].filter((s): s is string => !!s);

  d.log(RULE);
  d.log("  Auditoria da classificação do produto (Genérico · Ético · NETT · Serviço)");
  d.log(`  ${FRASE_PACOTE}`);
  d.log(`  ${PACOTE_ID} · versão ${versaoDoPacote()}`);
  d.log(`  ${FRASE_READ_ONLY} — só SELECT; não conclui significados; não toca no lock nem no SaaS.`);
  d.log(RULE);
  if (cnps.length > 0) d.log(`  CNPs conhecidos a comparar: ${cnps.length}${invalidos ? ` (${invalidos} tokens inválidos ignorados)` : ""}`);

  try {
    const registo: string[] = [];
    const rel = await d.withPool(
      cfg,
      async (pool) => {
        registo.length = 0; // uma retentativa de ligação recomeça o registo
        const executar = async (sqlTexto: string): Promise<Linha[]> => (await pool.request().query(sqlTexto)).recordset as unknown as Linha[];
        return executarAuditoria(criarLeitorSeguro(executar, registo), {
          top,
          maxColunas,
          cnps,
          orcamentoMs,
          segredos,
          pacote: pacoteOmissao(commitDoPacote()),
          queriesExecutadasTexto: () => registo,
        });
      },
      { abrirPool: (c) => d.abrirPool(c, timeoutMs) },
    );

    const escritos = escreverRelatorio(rel, saidas, segredos);

    const h = rel.cabecalho;
    const insp = rel.colunasCandidatas.filter((c) => c.inspeccao === "inspeccionada").length;
    d.log(`\n  SQL Server : ${h.sqlServer ?? "(não obtido)"}`);
    d.log(`  Base       : ${h.baseDados ?? "(não obtida)"}`);
    d.log(`  Colunas candidatas: ${rel.colunasCandidatas.length} (${insp} inspeccionadas em profundidade)`);
    d.log(`  Tabulações cruzadas: ${rel.cruzadas.length}`);
    if (rel.servicos.disponivel) {
      d.log(`  Processa_Stocks = 0: ${rel.servicos.zero} · <> 0: ${rel.servicos.diferenteDeZero} · NULL: ${rel.servicos.nulos}`);
    }
    if (rel.conhecidos.length > 0) {
      d.log(`  CNPs conhecidos encontrados: ${rel.conhecidos.filter((c) => c.encontrado).length}/${rel.conhecidos.length}`);
    }
    d.log(`  Queries executadas (todas SELECT): ${h.queriesExecutadas} · avisos: ${rel.avisos.length}`);
    d.log(`\n${RULE}`);
    for (const f of escritos) d.log(`  Relatório: ${f}`);
    d.log(RULE);
    d.log("\nNenhum significado foi concluído. O relatório é sanitizado; revê-o antes de o partilhar.");
    return 0;
  } catch (err) {
    d.erro(`✗ Auditoria falhou: ${redigir(err instanceof Error ? err.message : String(err), segredos)}`);
    return 1;
  }
}
