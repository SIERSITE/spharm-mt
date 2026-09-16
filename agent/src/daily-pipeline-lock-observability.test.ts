/**
 * agent/src/daily-pipeline-lock-observability.test.ts
 *
 * Correcção (2026-09): um abort de `daily-pipeline` por
 * `run/pipeline.lock` ocupado NUNCA chegava a `PipelineRun` no SaaS.
 *
 * ── A causa exacta ───────────────────────────────────────────────────
 *
 * A ordem original era: 1) tentar o lock; 2) SÓ DEPOIS resolver
 * `farmaciaId`. O bloco `finally` de `correrDiaCompleto` só regista
 * `PipelineRun` com `if (farmaciaId)` — e um abort de lock devolvia
 * `return 1` com `farmaciaId` ainda `""`. O abort ficava só no log local
 * (`logs/pipeline-YYYY-MM-DD.log`) e, quando muito, num ping a
 * Healthchecks.io: invisível em `/admin/pipeline`.
 *
 * ── A correcção ──────────────────────────────────────────────────────
 *
 * `resolveFarmaciaId` (uma chamada HTTP de leitura, não toca no lock nem
 * no ERP) passa a correr ANTES da tentativa de lock. Um abort por lock
 * ocupado já tem `farmaciaId` preenchido, e o MESMO `finally` — sem
 * precisar de nenhuma excepção à sua própria regra `if (farmaciaId)` —
 * grava `PipelineRun` com `status="ABORTED"` e o `errorMessage` exacto
 * do lock (ex.: "Pipeline já corre (pid=1234, ...)").
 *
 * ── Como se prova sem SQL Server nem lockfile a sério ───────────────
 *
 * `correrDiaCompleto` precisa de config carregada, pool SQL e
 * `SaasClient` reais para correr — não é isolável em unidade sem mocks
 * pesados. A prova aqui é ESTRUTURAL sobre o código-fonte: a ORDEM
 * textual das duas chamadas, e que nenhum `return` acontece entre
 * `resolveFarmaciaId` ter sucesso e a tentativa de lock — exactamente a
 * disciplina já usada em `scripts/tests/test-sync-on-demand.ts` (secção
 * N, "Wiring do long-poll") para provar uma ordem de chamadas
 * equivalente (`runLongPollCycles()` antes de `acquireLock()`) sem
 * precisar de correr o comando a sério.
 *
 * Uso: npx tsx agent/src/daily-pipeline-lock-observability.test.ts
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const ficheiroCompleto = readFileSync(new URL("./commands/daily-pipeline.ts", import.meta.url), "utf8");

/**
 * `resolveFarmaciaId` também é chamado por `planearDias` (o catch-up),
 * uma função DIFERENTE e anterior no ficheiro. Recortar para o corpo de
 * `correrDiaCompleto` evita apanhar essa outra chamada por engano — o
 * mesmo cuidado de âncora que `catalogo-retirado-diario.test.ts` já usa
 * para não recortar a sub-query errada.
 */
const idxFuncao = ficheiroCompleto.indexOf("async function correrDiaCompleto(");
if (idxFuncao === -1) throw new Error("correrDiaCompleto não encontrada em daily-pipeline.ts");
const src = ficheiroCompleto.slice(idxFuncao);

console.log("\n=== A. farmaciaId é resolvido ANTES da tentativa de lock ===");
{
  const idxResolve = src.indexOf("farmaciaId = await resolveFarmaciaId(");
  const idxLock = src.indexOf("await acquireLock(");
  ok(idxResolve !== -1, "resolveFarmaciaId é chamado algures no ficheiro");
  ok(idxLock !== -1, "acquireLock é chamado algures no ficheiro");
  ok(
    idxResolve !== -1 && idxLock !== -1 && idxResolve < idxLock,
    "…e resolveFarmaciaId aparece ANTES de acquireLock no texto (a ordem de execução real)",
    `resolveFarmaciaId@${idxResolve}, acquireLock@${idxLock}`,
  );
}

console.log("\n=== B. O corpo entre resolver farmaciaId e tentar o lock não tem 'return' nenhum ===");
{
  const idxResolveTryStart = src.indexOf("farmaciaId = await resolveFarmaciaId(");
  const idxLockTryStart = src.indexOf("// Lock acquire");
  ok(idxResolveTryStart !== -1, "encontra o try/catch de resolveFarmaciaId");
  ok(idxLockTryStart !== -1, "encontra o comentário '// Lock acquire'");
  if (idxResolveTryStart !== -1 && idxLockTryStart !== -1) {
    // O texto ENTRE o catch de resolveFarmaciaId (que pode legitimamente
    // sair com return, mas SÓ nesse catch — ver secção C) e o início da
    // tentativa de lock.
    const idxCatchFecha = src.indexOf("pipelineLog.log(`Farmácia resolved", idxResolveTryStart);
    ok(idxCatchFecha !== -1, "encontra o log 'Farmácia resolved' logo a seguir ao try/catch");
    const meio = src.slice(idxCatchFecha, idxLockTryStart);
    ok(
      !/\breturn\s+\d/.test(meio),
      "nenhum 'return' entre farmaciaId resolvido e a tentativa de lock — farmaciaId chega sempre ao lock",
      meio,
    );
  }
}

console.log("\n=== C. O catch do lock regista um step e preserva farmaciaId (não o reseta) ===");
{
  const idxLock = src.indexOf("await acquireLock(");
  const idxCatchLock = src.indexOf("} catch (err) {", idxLock);
  const idxFimCatchLock = src.indexOf("}", src.indexOf("return 1;", idxCatchLock));
  ok(idxCatchLock !== -1, "encontra o catch de acquireLock");
  const corpoCatchLock = idxCatchLock !== -1 ? src.slice(idxCatchLock, idxFimCatchLock + 1) : "";
  ok(/pipelineStatus = "ABORTED"/.test(corpoCatchLock), "…marca o pipeline como ABORTED");
  ok(
    /steps\.push\(\{\s*name:\s*"lock"/.test(corpoCatchLock),
    "…regista um step \"lock\" — visível em details.steps no SaaS, não só no errorMessage",
  );
  ok(
    !/farmaciaId\s*=\s*""/.test(corpoCatchLock),
    "…nunca reseta farmaciaId — o finally continua a vê-lo preenchido",
  );
}

console.log("\n=== D. O finally regista PipelineRun sempre que farmaciaId existe — sem excepção para lock ===");
{
  ok(
    src.includes('if (farmaciaId) {') && src.indexOf('if (farmaciaId) {') > src.indexOf("} finally {"),
    "o finally continua a gatear o registo por farmaciaId — não precisou de nenhuma excepção nova",
  );
  ok(
    src.includes("await client.pipelineRecord("),
    "…e chama pipelineRecord (POST /api/admin/pipeline/record) dentro desse bloco",
  );
  // A garantia central: como A+B+C provam que farmaciaId chega sempre
  // preenchido a um abort de lock, esta condição já existente no finally
  // basta — não é preciso um caminho novo só para o lock.
}

console.log("\n=== E. O comentário de topo do ficheiro documenta a nova ordem ===");
{
  ok(
    /farmaciaId[\s\S]{0,30}ANTES do lock|ANTES[\s\S]{0,30}lock/i.test(ficheiroCompleto.slice(0, 3000)),
    "o cabeçalho do ficheiro explica a ordem farmaciaId→lock, para não regredir sem se notar",
  );
}

console.log(`\n${pass} ok, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
