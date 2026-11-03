/**
 * scripts/tests/test-etico-nett-agent.ts
 *
 * A cópia da lógica pura no AGENT (agent/src/etico-nett.ts) tem de decidir EXACTAMENTE como o módulo do SaaS
 * (lib/classificacao/etico-nett.ts): mesma normalização, mesmo reconhecimento, mesma resolução de lookups.
 * E o que o agent envia tem de ser aceite pelo servidor tal como está (contrato de payload).
 *
 *   npx tsx scripts/tests/test-etico-nett-agent.ts
 */
import * as srv from "../../lib/classificacao/etico-nett";
import * as ag from "../../agent/src/etico-nett";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

const amostras: Array<string | null | undefined> = [
  "Éticos", "ÉTICOS", "ETICO", "Etico", "ético", " éticos ", "Éticos.", "(Éticos)", "NETT", "nett", "Nett", "NETT.", "Netts",
  "N.E.T.T.", "Serviços", "Servico", "Sacos L.", "Outros", "", "  ", null, undefined, "Éticos e NETT", "Ético/NETT",
  "Medicamentos éticos", "Etica", "Nettune", "Não NETT", "ETÍCOS", "eticos\t", "É T I C O",
];
let iguais = true;
for (const a of amostras) {
  if (srv.normalizarDescricaoEticoNett(a) !== ag.normalizarDescricaoEticoNett(a) || srv.categoriaDaDescricao(a) !== ag.categoriaDaDescricao(a)) {
    iguais = false;
    console.log(`     divergência em «${String(a)}»`);
  }
}
check(iguais, `normalização e categoria iguais em ${amostras.length} amostras`);

const lookups: Array<Array<{ codigo: number | null; descricao: string | null }>> = [
  [{ codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }, { codigo: 3, descricao: "Serviços" }],
  [{ codigo: 9, descricao: "ETICO" }, { codigo: 7, descricao: "nett" }],
  [{ codigo: 1, descricao: "Éticos" }, { codigo: 6, descricao: "ETICO" }, { codigo: 2, descricao: "NETT" }],
  [{ codigo: 1, descricao: "Éticos" }, { codigo: 1, descricao: "NETT" }],
  [], [{ codigo: null, descricao: "Éticos" }],
];
let eq = true;
for (const l of lookups) {
  const a = srv.resolverLookupEticoNett(l);
  const b = ag.resolverLookupEticoNett(l);
  if (JSON.stringify([...a.porCodigo]) !== JSON.stringify([...b.porCodigo]) || a.ignoradas !== b.ignoradas || JSON.stringify(a.ambiguos) !== JSON.stringify(b.ambiguos)) {
    eq = false;
    console.log(`     divergência no lookup ${JSON.stringify(l)}`);
  }
}
check(eq, `resolução de lookups igual em ${lookups.length} cenários`);

// Contrato: o que o agent envia é lido pelo servidor como VALOR (ou NAO_CLASSIFICADO / AUSENTE).
const plano: ag.PlanoEticoNett = {
  stocksColuna: "Etico_NETT",
  lookup: ag.resolverLookupEticoNett([{ codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }, { codigo: 3, descricao: "Serviços" }]),
  lookupAusente: null,
  linhasLookup: 3,
  contagens: { etico: 0, nett: 0, naoClassificados: 0, semCodigo: 0 },
};
const e = srv.lerEticoNettDoPayload(ag.eticoNettParaPayload(plano, 1));
check(e.tipo === "VALOR" && e.categoria === "ETICO" && e.codigoErp === 1 && e.descricaoErp === "Éticos", "o servidor aceita o ETICO que o agent envia");
const n = srv.lerEticoNettDoPayload(ag.eticoNettParaPayload(plano, 2));
check(n.tipo === "VALOR" && n.categoria === "NETT", "o servidor aceita o NETT que o agent envia");
check(srv.lerEticoNettDoPayload(ag.eticoNettParaPayload(plano, 3)).tipo === "NAO_CLASSIFICADO", "Serviço -> NAO_CLASSIFICADO no servidor (aviso, nada escrito)");
check(srv.lerEticoNettDoPayload(ag.eticoNettParaPayload(plano, null)).tipo === "AUSENTE", "sem código -> AUSENTE no servidor (nada observado)");

console.log(`\n${ok} OK, ${ko} FALHA(S)`);
process.exit(ko === 0 ? 0 : 1);
