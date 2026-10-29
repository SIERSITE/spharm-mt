#!/usr/bin/env node
/**
 * agent/src/audit-cli.ts
 *
 * Entry point DEDICADO do pacote de DIAGNÓSTICO `classification-audit` (base rev98). É o ÚNICO ponto de entrada do
 * bundle `agent.cjs` do pacote de diagnóstico; o `cli.ts` do agent (rev98) fica intacto e NÃO conhece este comando.
 *
 * Porque um entry point à parte (em vez de um comando no `cli.ts`):
 *  · o bundle do diagnóstico não contém `http-client`, `lock-pipeline`, `guarda-escrita`, `daily-pipeline`, nem
 *    qualquer comando de escrita ou de sincronização — não é só «não chamar», é «não existir» (provado por teste
 *    sobre o metafile do esbuild);
 *  · o `npm run agent:package` normal continua a produzir exatamente a rev98 (o comando nem entra no bundle);
 *  · NÃO está em COMANDOS_DE_ESCRITA e não adquire o lock operacional: pode correr ao lado da tarefa agendada
 *    sem a perturbar (e sem criar nem ler `run/pipeline.lock`).
 *
 * Comandos: `classification-audit` (+ `--help`, `--version`).
 */

import { classificationAudit, depsReais, USO } from "./commands/classification-audit.js";
import { commitDoPacote, FRASE_PACOTE, PACOTE_BASE_REV, PACOTE_ID, versaoDoPacote } from "./diagnostico-pacote.js";

function banner(): void {
  console.log(`${PACOTE_ID} ${versaoDoPacote()} (base rev${PACOTE_BASE_REV}${commitDoPacote() ? `, commit ${commitDoPacote()}` : ""}) — ${FRASE_PACOTE}`);
}

function ajuda(): void {
  console.log("Uso: node.exe agent.cjs classification-audit [opções]");
  console.log("");
  console.log("Único comando deste pacote:");
  console.log("  classification-audit   auditoria READ-ONLY da classificação do produto (Genérico/Ético/NETT/Serviço).");
  console.log("");
  console.log(USO);
}

/** Termina sem perder o código de saída (mesma cautela do cli.ts em Windows). */
async function sair(code: number): Promise<never> {
  process.exitCode = code;
  await new Promise((r) => setTimeout(r, 100));
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  banner();
  if (cmd === "--version" || cmd === "-v") return sair(0);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    ajuda();
    return sair(cmd ? 0 : 1);
  }
  if (cmd !== "classification-audit") {
    console.error(`✗ Comando desconhecido neste pacote de diagnóstico: ${cmd}`);
    ajuda();
    return sair(1);
  }
  try {
    return await sair(await classificationAudit(depsReais(args.slice(1))));
  } catch (err) {
    console.error("[fatal]", err instanceof Error ? err.message : String(err));
    return sair(1);
  }
}

void main();
