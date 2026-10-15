/**
 * agent/src/daily-pipeline-resiliencia.test.ts
 *
 * Ligações (wiring) da rev98 no `daily-pipeline`, verificadas sobre o código-fonte — o orquestrador precisa de um ERP SQL
 * Server para correr de verdade, por isso o COMPORTAMENTO está provado noutros ficheiros
 * (`http-resiliencia`, `resiliencia-pipeline`, `plano-integracao`); aqui garante-se que nada disso fica desligado:
 *
 *   · checkpoints dos passos; nenhum registo/alerta nas tentativas intermédias; chave de idempotência estável;
 *   · o lock fica retido durante as esperas e só se liberta no fim;
 *   · PipelineRun com fallback local; alertas deduplicados e resolvidos;
 *   · o cliente HTTP nunca regista corpo, headers nem token;
 *   · subcomandos transitórios saem com EXIT_TRANSITORIO.
 *
 * Uso: npx tsx agent/src/daily-pipeline-resiliencia.test.ts
 */
import fs from "node:fs";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}`); }
};
const ler = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const dp = ler("./commands/daily-pipeline.ts");
const corpo = dp.slice(dp.indexOf("async function correrDiaCompleto("));
const http = ler("./http-client.ts");
const cli = ler("./cli.ts");

console.log("A · checkpoints: um passo já confirmado não se repete na retoma");
for (const passo of ["daily-sync", "refresh-operacional", "designacoes", "aggregate-month"]) {
  check(corpo.includes(`acc.passosOk.has("${passo}")`) && corpo.includes(`acc.passosOk.add("${passo}")`), `passo «${passo}»: lido e gravado no checkpoint`);
}
check(corpo.includes("acc.passosOk.has(p.label)") && corpo.includes("acc.passosOk.add(p.label)"), "fornecedores/compras/devoluções/movimentos: idem");
check(!/passosOk\.add\("daily-sync"\)[\s\S]{0,200}saudeVendas\.saudavel\s*===\s*false/.test(corpo), "um daily-sync PARCIAL (saúde das vendas) NÃO entra no checkpoint");

console.log("\nB · tentativas intermédias não registam nem alertam");
check(/const vaiRetomar = !ctx\.ultima && transitoria;/.test(corpo) && /if \(!vaiRetomar\) \{[\s\S]*registarPipelineRunDuravel\([\s\S]*abrirAlerta\(/.test(corpo), "PipelineRun e alerta só no desfecho final (não por tentativa)");
check(corpo.includes("const startedAt = acc.startedAtOriginal;") && corpo.includes("`daily-pipeline:${farmaciaId}:${parsedDate}:${startedAt.toISOString()}`"), "idempotencyKey estável: usa o arranque ORIGINAL do dia (todas as tentativas → o mesmo registo)");
check(/correrComRetoma\(\{[\s\S]*dia,[\s\S]*correr: \(info\) => correrDiaCompleto\(dia,/.test(dp), "a retoma repete o MESMO dia (nunca recalcula «ontem»)");

console.log("\nC · lock mantido durante as esperas");
check(!/releaseLock\(\)/.test(corpo) && /if \(lockPertenceAEsteProcesso\(\)\) await releaseLock\(\);/.test(dp), "correrDiaCompleto não liberta o lock; liberta-se no fim das tentativas (correrDiaComRetoma)");
check(dp.includes("antesDeEsperar") && /registarPendente\(dirEstadoPadrao\(\)/.test(dp), "o estado pendente é gravado ANTES de dormir (sobrevive a um reinício)");

console.log("\nD · PipelineRun, alertas e estado local");
check(/guardarRegistoPendente\(dirEstadoPadrao\(\), body\)/.test(dp), "PipelineRun que não chega ao SaaS é guardado localmente (mesma idempotencyKey)");
check(dp.includes("recuperarPendenciasDeEnvio(cfg, clientePlano") && dp.includes("reenviarRegistosPendentes") && dp.includes("reenviarAlertasPendentes"), "no arranque reenvia registos e alertas pendentes");
check(dp.includes("resolverAlertasDoDia(dirE") && dp.includes("removerPendente(dirE, parsedDate)"), "dia concluído: resolve alertas e limpa o pendente");
check(/enviarPing\(cfg\.healthcheckUrl, "fail"/.test(dp) && !/pingHealthcheck\(\s*cfg\.healthcheckUrl,\s*pipelineStatus === "OK"/.test(dp), "o /fail do Healthchecks passa pelo alerta deduplicado (não em cada tentativa/corrida)");
check(dp.includes("a notificação FALHOU") && dp.includes("a causa mantém-se"), "falha do envio do alerta fica visível no log (não esconde a causa)");
check(dp.includes("ROTULO_DESFECHO[desfecho]") && dp.includes("RESUMO DA EXECUÇÃO"), "resumo final distingue os desfechos");
check(dp.includes('plan: { type: "boolean" }') && dp.includes("--plan"), "--plan (dry-run do plano) disponível");

console.log("\nE · cliente HTTP: sem segredos nos logs");
const logsHttp = http.split("this.log(").slice(1).map((t) => t.slice(0, 600));
check(logsHttp.length >= 6, `há ${logsHttp.length} pontos de log HTTP`);
check(logsHttp.every((l) => !/\$\{[^}]*\b(headers|corpo|body|ingestKey|jsonCorpo|textoCorpo)\b[^}]*\}/.test(l.split(");")[0] ?? l)), "nenhum log HTTP interpola headers, corpo ou a chave");
check(/private log\(linha: string\): void \{[\s\S]{0,200}redigir\(linha, \[this\.ingestKey\]\)/.test(http), "barreira final: todo o log HTTP passa por redigir()");

console.log("\nF · códigos de saída");
check(cli.includes("EXIT_TRANSITORIO") && cli.includes("houveFalhaTransitoriaDefinitiva()"), "subcomando que falhou por causa transitória sai com 75 (o orquestrador espera e repete)");
check(cli.includes("sairLimpo"), "saída limpa (evita o crash 0xC0000409 do Node em Windows com ligações a fechar)");
check(!/comRetryDeRede/.test(dp), "o retry local antigo (3× de 3 s só no aggregate-month) foi substituído pela política central");

console.log("\nG · SQL Server transitório, log em tempo real e lock com heartbeat");
const sqlClient = ler("./sql-client.ts");
check(/function ehTransitoria\(err: unknown\): boolean \{\s*return eFalhaTransitoria\(err\) \|\| eFalhaSqlTransitoria\(err\);/.test(dp), "o pipeline retoma falhas transitórias do SQL Server (além das do SaaS)");
check(sqlClient.includes("classificarErroSql(err)") && sqlClient.includes("if (!classe.transitoria) throw err;"), "withPool só repete o transitório; o permanente sobe de imediato");
check(sqlClient.includes("marcarFalhaTransitoriaDefinitiva()"), "esgotadas as retentativas SQL o comando sai com 75");
check(/appendFileSync\(this\.filePath, `\$\{linha\}\\n`/.test(dp), "o log do dia é escrito linha a linha (execução longa deixa o log atualizado)");
check(dp.includes("descreverLock()") && dp.includes("esperasSqlDoAmbiente()"), "--plan mostra o estado do lock (só leitura) e a política SQL");

console.log(`\n${ok} OK, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
