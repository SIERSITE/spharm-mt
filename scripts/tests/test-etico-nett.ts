/**
 * scripts/tests/test-etico-nett.ts
 *
 * Classificação Ético/NETT — lógica PURA (sem base de dados): normalização, reconhecimento por descrição,
 * resolução do lookup (códigos diferentes entre farmácias, ambiguidade), consolidação e leitura do payload.
 *
 *   npx tsx scripts/tests/test-etico-nett.ts
 */
import {
  categoriaDaDescricao,
  consolidarEticoNett,
  lerEticoNettDoPayload,
  lerValoresFiltroEticoNett,
  normalizarDescricaoEticoNett,
  resolverLookupEticoNett,
} from "../../lib/classificacao/etico-nett";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const mesmo = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

secao("A · normalização e reconhecimento por descrição");
check(normalizarDescricaoEticoNett("  Éticos. ") === "eticos", "«  Éticos. » -> eticos");
check(normalizarDescricaoEticoNett("N.E.T.T.") === "n e t t", "pontuação -> espaço (não colapsa letras)");
for (const d of ["Éticos", "ÉTICOS", "ETICO", "Etico", "ético", " éticos ", "Éticos.", "(Éticos)", "É-ticos".replace("-", "")]) {
  check(categoriaDaDescricao(d) === "ETICO", `«${d}» -> ETICO`);
}
for (const d of ["NETT", "nett", "Nett", " N E T T".replace(/ /g, ""), "NETT.", "Netts", "NETT\t"]) {
  check(categoriaDaDescricao(d) === "NETT", `«${d}» -> NETT`);
}
for (const d of ["Serviços", "Servico", "Sacos L.", "Outros", "", "   ", null, undefined, "Éticos e NETT", "Ético/NETT", "Medicamentos éticos", "Etica", "Nettune", "Não NETT"]) {
  check(categoriaDaDescricao(d as string) === null, `«${String(d)}» -> null (não é Ético/NETT inequívoco)`);
}

secao("B · lookup com códigos DIFERENTES entre farmácias");
const farmaciaA = resolverLookupEticoNett([
  { codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }, { codigo: 3, descricao: "Serviços" },
  { codigo: 4, descricao: "Sacos L." }, { codigo: 5, descricao: "Outros" },
]);
const farmaciaB = resolverLookupEticoNett([
  { codigo: 7, descricao: "NETT" }, { codigo: 9, descricao: "ETICO" }, { codigo: 1, descricao: "Serviços" },
]);
check(mesmo([...farmaciaA.porCodigo], [[1, "ETICO"], [2, "NETT"]]), "farmácia A: 1->ETICO, 2->NETT");
check(farmaciaA.ignoradas === 3 && farmaciaA.ambiguos.length === 0, "farmácia A: Serviço/Sacos/Outros ignorados, sem ambiguidade");
check(mesmo([...farmaciaB.porCodigo], [[7, "NETT"], [9, "ETICO"]]), "farmácia B: 7->NETT, 9->ETICO (códigos diferentes de A)");
check(farmaciaA.porCodigo.get(1) === "ETICO" && farmaciaB.porCodigo.get(1) === undefined, "o código 1 é ÉTICO em A e Serviço em B (nunca assumir códigos)");

secao("C · ambiguidade e lookup em falta");
const amb1 = resolverLookupEticoNett([{ codigo: 1, descricao: "Éticos" }, { codigo: 6, descricao: "ETICO" }, { codigo: 2, descricao: "NETT" }]);
check(amb1.porCodigo.size === 1 && amb1.porCodigo.get(2) === "NETT" && mesmo(amb1.ambiguos, [1, 6]), "duas linhas «Ético» em códigos diferentes -> ambos descartados");
const amb2 = resolverLookupEticoNett([{ codigo: 1, descricao: "Éticos" }, { codigo: 1, descricao: "NETT" }]);
check(amb2.porCodigo.size === 0 && mesmo(amb2.ambiguos, [1]), "o mesmo código com Ético e NETT -> descartado");
const vazio = resolverLookupEticoNett([]);
check(vazio.porCodigo.size === 0 && vazio.ambiguos.length === 0, "lookup vazio/em falta -> nada resolvido, nada inventado");
const invalido = resolverLookupEticoNett([{ codigo: null, descricao: "Éticos" }, { codigo: 1.5, descricao: "NETT" }]);
check(invalido.porCodigo.size === 0 && invalido.ignoradas === 2, "códigos inválidos ignorados");

secao("D · consolidação (nunca «a última farmácia ganha»)");
check(consolidarEticoNett([]) === "SEM", "nenhuma farmácia -> SEM");
check(consolidarEticoNett([null, undefined]) === "SEM", "farmácias sem informação -> SEM");
check(consolidarEticoNett(["ETICO"]) === "ETICO", "uma farmácia ÉTICO -> ETICO");
check(consolidarEticoNett(["ETICO", "ETICO", null]) === "ETICO", "duas concordam, uma sem informação -> ETICO");
check(consolidarEticoNett(["NETT", "NETT"]) === "NETT", "duas concordam -> NETT");
check(consolidarEticoNett(["ETICO", "NETT"]) === "DIVERGENTE", "Ético vs NETT -> DIVERGENTE");
check(consolidarEticoNett(["NETT", "ETICO"]) === "DIVERGENTE", "a ordem não decide (NETT depois ETICO)");
check(consolidarEticoNett(["ETICO", "NETT", "ETICO"]) === "DIVERGENTE", "a maioria também não decide");

secao("E · payload: ausente ≠ null ≠ valor");
check(lerEticoNettDoPayload({}).tipo === "AUSENTE", "agent rev98 (sem campos) -> AUSENTE (preserva)");
check(lerEticoNettDoPayload({ eticoNett: null }).tipo === "NAO_CLASSIFICADO", "null -> NAO_CLASSIFICADO (aviso, não apaga)");
const v = lerEticoNettDoPayload({ eticoNett: "NETT", eticoNettCodigo: 7, eticoNettDescricao: "NETT" });
check(v.tipo === "VALOR" && v.categoria === "NETT" && v.codigoErp === 7 && v.descricaoErp === "NETT", "NETT com código e descrição");
check(lerEticoNettDoPayload({ eticoNett: "ETICO" }).tipo === "VALOR", "ETICO sem código/descrição é aceite");
check(lerEticoNettDoPayload({ eticoNett: "SERVICO" }).tipo === "INVALIDO", "SERVICO -> INVALIDO");
check(lerEticoNettDoPayload({ eticoNett: "etico" }).tipo === "INVALIDO", "minúsculas -> INVALIDO (o contrato é exacto)");
check(lerEticoNettDoPayload({ eticoNett: 1 }).tipo === "INVALIDO", "número -> INVALIDO");
check(lerEticoNettDoPayload({ eticoNett: "ETICO", eticoNettDescricao: "Serviços" }).tipo === "INVALIDO", "descrição que não confirma a categoria -> INVALIDO");
const cod = lerEticoNettDoPayload({ eticoNett: "ETICO", eticoNettCodigo: -3 });
check(cod.tipo === "VALOR" && cod.codigoErp === null, "código fora do intervalo -> null (categoria mantém-se)");

secao("F · valores de filtro");
check(mesmo(lerValoresFiltroEticoNett(["ETICO", "x", "NETT", "ETICO", 3, "SEM", "DIVERGENTE"]), ["ETICO", "NETT", "SEM", "DIVERGENTE"]), "lixo e duplicados descartados");
check(mesmo(lerValoresFiltroEticoNett(undefined), []) && mesmo(lerValoresFiltroEticoNett("ETICO"), []), "não-array -> []");

console.log(`\n${ok} OK, ${ko} FALHA(S)`);
process.exit(ko === 0 ? 0 : 1);
