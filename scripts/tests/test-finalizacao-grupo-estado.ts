/**
 * scripts/tests/test-finalizacao-grupo-estado.ts
 *
 * Testes PUROS (sem BD, sem browser) das regras da finalização de Encomendas
 * em modo Grupo (lib/encomendas/finalizacao-grupo-estado.ts) e das garantias
 * estruturais do componente/acções que as aplicam. A prova de comportamento
 * em browser está em scripts/e2e/encomendas-grupo-finalizacao-browser.ts.
 *
 * Corre com:  npx tsx scripts/tests/test-finalizacao-grupo-estado.ts
 */
import { readFileSync } from "node:fs";
import {
  CHAVE_SESSAO_DOCUMENTOS_PENDENTES,
  TEMPO_AVISO_DEMORA_MS,
  VALIDADE_PENDENTE_MS,
  guardarDocumentosPendentes,
  lerDocumentosPendentes,
  limparDocumentosPendentes,
  mensagemDeErro,
  mensagemErroFinalizacaoInesperado,
  novasChavesFinalizacaoGrupo,
} from "../../lib/encomendas/finalizacao-grupo-estado";
import { deriveGrupoSimplesIdempotencyKey, deriveGrupoDraftIdempotencyKey } from "../../lib/encomendas/finalizar-multi-fornecedor-regras";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`); }
};
const src = (p: string) => readFileSync(p, "utf8");

class ArmazemFalso {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

console.log("\n=== A. Mensagens: qualquer coisa lançada vira texto legível ===");
ok("Error → a sua mensagem", mensagemDeErro(new Error("boom")) === "boom");
ok("string → ela própria", mensagemDeErro("rede caiu") === "rede caiu");
ok("rejeição sem mensagem (undefined/objeto/Error vazio) → texto genérico", [undefined, null, {}, new Error("  ")].every((e) => mensagemDeErro(e) === "falha de comunicação com o servidor"));
ok("a mensagem de finalização inesperada diz que o retry é seguro", /idempotente e não duplica/.test(mensagemErroFinalizacaoInesperado(new Error("x"))));

console.log("\n=== B. Chaves de idempotência ===");
{
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const k = novasChavesFinalizacaoGrupo(uuid);
  ok("duas chaves distintas, sem hífenes", k.encomendaBatchKey !== k.transferenciaBatchKey && !k.encomendaBatchKey.includes("-") && !k.transferenciaBatchKey.includes("-"));
  const a = deriveGrupoSimplesIdempotencyKey("lote1", "farmA");
  ok("a chave da encomenda única é determinística por (lote, farmácia)", a === deriveGrupoSimplesIdempotencyKey("lote1", "farmA") && a !== deriveGrupoSimplesIdempotencyKey("lote1", "farmB") && a !== deriveGrupoSimplesIdempotencyKey("lote2", "farmA"));
  ok("…e distinta da do ramo multi-fornecedor (nunca colidem)", a !== deriveGrupoDraftIdempotencyKey("lote1", "farmA"));
}

console.log("\n=== C. Recuperação: ids guardados em sessionStorage ===");
{
  const s = new ArmazemFalso();
  const t0 = 1_700_000_000_000;
  ok("sem nada guardado → null", lerDocumentosPendentes(s, t0) === null);
  guardarDocumentosPendentes(s, { listaEncomendaIds: ["a", "b"], transferenciaIds: ["t"], incluirConsolidado: true, correlacaoId: "c-1" }, t0);
  const r = lerDocumentosPendentes(s, t0 + 1000);
  ok("lê exactamente o que foi guardado", !!r && r.listaEncomendaIds.join() === "a,b" && r.transferenciaIds.join() === "t" && r.incluirConsolidado === true && r.correlacaoId === "c-1");
  ok("guarda SÓ ids e flags (nenhum conteúdo de produtos/notas)", Object.keys(JSON.parse(s.getItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES)!)).sort().join() === "correlacaoId,guardadoEm,incluirConsolidado,listaEncomendaIds,transferenciaIds");
  ok("expira ao fim de 24 h", lerDocumentosPendentes(s, t0 + VALIDADE_PENDENTE_MS + 1) === null);
  s.setItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES, "{lixo");
  ok("JSON corrompido → null (nunca lança)", lerDocumentosPendentes(s, t0) === null);
  s.setItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES, JSON.stringify({ listaEncomendaIds: [1], transferenciaIds: [], guardadoEm: t0 }));
  ok("ids de tipo errado → null", lerDocumentosPendentes(s, t0) === null);
  s.setItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES, JSON.stringify({ listaEncomendaIds: [], transferenciaIds: [], guardadoEm: t0 }));
  ok("nada a preparar → null", lerDocumentosPendentes(s, t0) === null);
  guardarDocumentosPendentes(s, { listaEncomendaIds: ["a"], transferenciaIds: [] }, t0);
  limparDocumentosPendentes(s);
  ok("limpar remove", lerDocumentosPendentes(s, t0) === null);
  ok("armazém indisponível (null) nunca lança", (() => { guardarDocumentosPendentes(null, { listaEncomendaIds: ["a"], transferenciaIds: [] }); limparDocumentosPendentes(null); return lerDocumentosPendentes(null) === null; })());
  const estragado = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("x"); } };
  ok("armazém que lança (modo privado/cheio) nunca propaga", (() => { guardarDocumentosPendentes(estragado, { listaEncomendaIds: ["a"], transferenciaIds: [] }); limparDocumentosPendentes(estragado); return lerDocumentosPendentes(estragado) === null; })());
}

console.log("\n=== D. O componente aplica a máquina de estados (garantias estruturais) ===");
{
  const c = src("components/encomendas/order-create-client.tsx");
  ok("a finalização do grupo já NÃO usa useTransition (startGerarPlano removido)", !/startGerarPlano/.test(c) && /useState<FaseFinalizacaoGrupo>/.test(c));
  ok("trava síncrona contra duplo clique (grupoEmVooRef)", /grupoEmVooRef\.current\) return/.test(c));
  ok("a trava liberta-se em finally", /finally \{\s*grupoEmVooRef\.current = false;/.test(c));
  ok("os documentos libertam o «ocupado» em finally (docsEmVooRef + carregandoResultado)", /finally \{\s*docsEmVooRef\.current = false;\s*setCarregandoResultado\(false\);/.test(c));
  ok("prepararDocumentos captura rejeições (try/catch à volta da Server Action)", /try \{\s*const r = await buildDocumentosFinalizacaoAction\(pedido\);[\s\S]{0,400}catch \(e\)/.test(c));
  ok("a finalização captura rejeições da Server Action de plano", /try \{\s*const result = await gerarPlanoGrupoAction\([\s\S]{0,900}catch \(e\)/.test(c));
  ok("o erro do plano aparece no modal (prop `erro`), não só no flash escondido", /erro=\{faseGrupo\.tipo === "erro"/.test(c) && /role="alert"/.test(c));
  ok("as chaves de idempotência são reutilizadas nos retries (chavesGrupoRef ??=)", /chavesGrupoRef\.current \?\?= novasChavesFinalizacaoGrupo/.test(c));
  ok("o plano envia as DUAS chaves (encomendas e transferências)", /encomendaBatchKey: chaves\.encomendaBatchKey,\s*transferenciaBatchKey: chaves\.transferenciaBatchKey/.test(c));
  ok("depois de persistir, as chaves são largadas e os documentos preparados à parte (nunca re-finalizar)", /chavesGrupoRef\.current = null;[\s\S]{0,300}void prepararDocumentos\(\{ \.\.\.persistido/.test(c));
  ok("existe «Tentar preparar documentos novamente» e «Concluir» no painel de erro", c.includes("Tentar preparar documentos novamente") && /function PainelErroDocumentos/.test(c));
  ok("o retry dos documentos só passa ids (nenhuma action de criação é chamada por ele)", (() => {
    const i = c.indexOf("async function prepararDocumentos");
    const f = c.indexOf("function mostrarResultadoFinalizacao");
    const corpo = c.slice(i, f);
    return !/gerarPlanoGrupoAction|finalizeFromDetailAction|finalizarConsolidacao|createEncomenda/.test(corpo);
  })());
  ok("não há navegação automática antes de o utilizador ver o resultado (router.push só em «Concluir»/«Encomendas»)", (c.match(/router\.push\("\/encomendas"\)/g) ?? []).length <= 4);
  ok("o aviso de demora é visível (modal e overlay) e usa o tempo definido no módulo puro", TEMPO_AVISO_DEMORA_MS === 45_000 && /avisoDemoraGrupo/.test(c) && /avisoDemoraDocs/.test(c));
  ok("sem timeout arbitrário nem reload automático a esconder o problema", !/location\.reload|window\.location\.href/.test(c.slice(c.indexOf("async function executarFinalizacaoGrupo"), c.indexOf("function cancelarFinalizacaoGrupo"))));
}

console.log("\n=== E. Acções do servidor: observabilidade e idempotência ===");
{
  const a = src("app/encomendas/nova/actions.ts");
  for (const e of ["group-finalization-start", "group-finalization-persisted", "group-documents-start", "group-documents-success", "group-documents-failed"]) {
    ok(`log estruturado ${e}`, a.includes(`"${e}"`));
  }
  const log = a.slice(a.indexOf("function logGrupo"), a.indexOf("export async function gerarPlanoGrupoAction"));
  ok("os logs são uma linha JSON com correlação e durações", /JSON\.stringify\(\{ evento, ts:/.test(log) && /correlacaoSegura/.test(log));
  const chamadas = [...a.matchAll(/logGrupo\("group-[a-z-]+", \{([\s\S]*?)\}\);/g)].map((m) => m[1]).join("\n");
  ok("nenhum log inclui produtos, notas, nomes ou designações", !/designacao|notas|nome\b|produto|cnp|linhas\b/i.test(chamadas.replace(/nDecisoes|nFarmacias|nDirecoes|nEncomendas|nTransferencias/g, "")));
  ok("o ramo de encomenda única usa chave de idempotência derivada do lote", /deriveGrupoSimplesIdempotencyKey\(input\.encomendaBatchKey, farmaciaId\)/.test(a));
  ok("a correlação é validada (só [A-Za-z0-9-], ≤64) antes de ir para os logs", /\^\[A-Za-z0-9-\]\{1,64\}\$/.test(a));
  ok("buildDocumentosFinalizacaoAction continua só de leitura (sem create/update)", (() => {
    const i = a.indexOf("export async function buildDocumentosFinalizacaoAction");
    const corpo = a.slice(i, a.indexOf("\n}\n", i));
    return !/\.create\(|\.update\(|createEncomenda|criarTransferencia|finalizeAndQueue/.test(corpo);
  })());
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
