/**
 * scripts/tests/test-eliminacao-encomenda-transferencia.ts
 *
 * Bloco 2026-09 — soft-delete de ListaEncomenda/Transferencia +
 * substituição do mecanismo de "transferência interna fingida".
 *
 *   A  `foiExportadaDeFacto` distingue exportação real de simulada
 *   B  `podeEliminarListaEncomenda` decide livre vs. aviso
 *   C  as server actions de eliminação existem, com a gate certa
 *   D  as listagens normais escondem ELIMINADA por omissão
 *   E  `createInternalTransferAction` cria uma Transferencia real,
 *      não uma ListaEncomenda/OrderOutbox
 *
 * Corre com:  npm run test:eliminacao-encomenda-transferencia
 */
import { readFileSync } from "node:fs";
import {
  AVISO_ELIMINACAO_JA_EXPORTADA,
  foiExportadaDeFacto,
  podeEliminarListaEncomenda,
  type OutboxExportInfo,
} from "../../lib/encomendas/eliminacao";
import { podeAnularListaEncomenda } from "../../lib/encomendas/anulacao";
import { podeAnularTransferencia } from "../../lib/transferencias/anulacao";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};

const src = (p: string) => readFileSync(p, "utf8");

// ═════════════════════════════════════════════════════════════════════
// A · foiExportadaDeFacto — real vs. simulada
// ═════════════════════════════════════════════════════════════════════
console.log("\nA · foiExportadaDeFacto distingue exportação real de simulada\n");

const fixtures: Array<{ outbox: OutboxExportInfo; esperado: boolean; label: string }> = [
  { outbox: null, esperado: false, label: "sem OrderOutbox nenhum" },
  {
    outbox: { state: "PENDENTE", spharmDocumentId: null },
    esperado: false,
    label: "PENDENTE — ainda nem tentou",
  },
  {
    outbox: { state: "EM_EXPORTACAO", spharmDocumentId: null },
    esperado: false,
    label: "EM_EXPORTACAO — a meio da lease",
  },
  {
    outbox: { state: "FALHADO", spharmDocumentId: null },
    esperado: false,
    label: "FALHADO — nunca chegou a exportar",
  },
  {
    outbox: { state: "CANCELADO", spharmDocumentId: null },
    esperado: false,
    label: "CANCELADO — cancelado antes de exportar",
  },
  {
    outbox: { state: "EXPORTADO", spharmDocumentId: "SPH-2026-000123" },
    esperado: true,
    label: "EXPORTADO com spharmDocumentId real",
  },
  {
    outbox: { state: "EXPORTADO", spharmDocumentId: "SIM-1735599999999" },
    esperado: false,
    label: 'EXPORTADO via ACK SIMULADO ("SIM-" prefix) não conta como real',
  },
  {
    outbox: { state: "EXPORTADO", spharmDocumentId: null },
    esperado: true,
    label: "EXPORTADO sem spharmDocumentId (caso limite) ainda conta como real — só \"SIM-\" exclui",
  },
];

for (const f of fixtures) {
  check(
    foiExportadaDeFacto(f.outbox) === f.esperado,
    `${f.label} ⇒ ${f.esperado}`,
    `obtido ${foiExportadaDeFacto(f.outbox)}`
  );
}

// ═════════════════════════════════════════════════════════════════════
// B · podeEliminarListaEncomenda — livre vs. aviso
// ═════════════════════════════════════════════════════════════════════
console.log("\nB · podeEliminarListaEncomenda decide entre eliminar livre e exigir aviso\n");

{
  const d = podeEliminarListaEncomenda(null);
  check(d.podeEliminarDirectamente === true, "sem outbox: elimina directamente, sem aviso");
}
{
  const d = podeEliminarListaEncomenda({ state: "PENDENTE", spharmDocumentId: null });
  check(d.podeEliminarDirectamente === true, "outbox PENDENTE: elimina directamente");
}
{
  const d = podeEliminarListaEncomenda({ state: "FALHADO", spharmDocumentId: null });
  check(d.podeEliminarDirectamente === true, "outbox FALHADO: elimina directamente");
}
{
  const d = podeEliminarListaEncomenda({ state: "EXPORTADO", spharmDocumentId: "SPH-999" });
  check(d.podeEliminarDirectamente === false, "outbox EXPORTADO real: exige aviso");
  check(
    !d.podeEliminarDirectamente && d.aviso === AVISO_ELIMINACAO_JA_EXPORTADA,
    "…com o aviso exportado pelo módulo (para o cliente mostrar o mesmo texto)"
  );
  check(
    !d.podeEliminarDirectamente && /não desfaz/i.test(d.aviso),
    "…o aviso deixa claro que eliminar NÃO desfaz a exportação"
  );
}
{
  const d = podeEliminarListaEncomenda({ state: "EXPORTADO", spharmDocumentId: "SIM-123" });
  check(d.podeEliminarDirectamente === true, "outbox EXPORTADO simulado: elimina directamente, sem aviso");
}

// ═════════════════════════════════════════════════════════════════════
// B-bis · podeAnularListaEncomenda / podeAnularTransferencia (2026-09-29)
// ═════════════════════════════════════════════════════════════════════
console.log("\nB-bis · podeAnular* — Anular só depois de sair de RASCUNHO, motivo obrigatório\n");

{
  const semMotivo = podeAnularListaEncomenda("FINALIZADA", "");
  check(semMotivo.podeAnular === false, "encomenda FINALIZADA sem motivo: bloqueado");
  const comMotivo = podeAnularListaEncomenda("FINALIZADA", "Erro de fornecedor");
  check(comMotivo.podeAnular === true, "encomenda FINALIZADA com motivo: permitido");
  check(podeAnularListaEncomenda("EXPORTADA", "motivo").podeAnular === true, "encomenda EXPORTADA com motivo: permitido");
  check(podeAnularListaEncomenda("RASCUNHO", "motivo").podeAnular === false, "encomenda RASCUNHO: bloqueado (usa Eliminar)");
  check(podeAnularListaEncomenda("ANULADA", "motivo").podeAnular === false, "encomenda já ANULADA: bloqueado");
  check(podeAnularListaEncomenda("ELIMINADA", "motivo").podeAnular === false, "encomenda já ELIMINADA: bloqueado");
}
{
  check(podeAnularTransferencia("FINALIZADA", "Produto trocado").podeAnular === true, "transferência FINALIZADA com motivo: permitido");
  check(podeAnularTransferencia("FINALIZADA", "   ").podeAnular === false, "transferência FINALIZADA com motivo em branco: bloqueado");
  check(podeAnularTransferencia("RASCUNHO", "motivo").podeAnular === false, "transferência RASCUNHO: bloqueado (usa Eliminar)");
  check(podeAnularTransferencia("ANULADA", "motivo").podeAnular === false, "transferência já ANULADA: bloqueado");
}

// ═════════════════════════════════════════════════════════════════════
// C · As server actions de eliminação existem, com a gate certa
// ═════════════════════════════════════════════════════════════════════
console.log("\nC · deleteListaEncomendaAction / deleteTransferenciaAction — existência e gate\n");

{
  const listaActions = src("app/encomendas/lista/actions.ts");
  check(
    listaActions.includes("export async function deleteListaEncomendaAction"),
    "deleteListaEncomendaAction existe"
  );
  check(
    listaActions.includes("podeEliminarListaEncomenda(lista.outbox)"),
    "…e usa a lógica pura testada acima, não uma cópia"
  );
  check(
    /export async function deleteListaEncomendaAction[\s\S]{0,200}requirePermission\("settings\.global"\)/.test(
      listaActions
    ),
    "…exige settings.global — a mesma gate de cancelOutboxAction/retryOutboxAction"
  );
  check(
    listaActions.includes("confirmarExportadaMesmoAssim"),
    "…aceita o parâmetro explícito de segunda confirmação"
  );
  check(
    listaActions.includes('estado: "ELIMINADA"'),
    "…transita para ELIMINADA (soft-delete), nunca prisma...delete()"
  );
  check(
    !/deleteListaEncomendaAction[\s\S]{0,2000}listaEncomenda\.delete\(/.test(listaActions),
    "…nunca apaga a row (prisma.listaEncomenda.delete)"
  );
  check(
    /export async function deleteListaEncomendaAction[\s\S]{0,900}estado !== "RASCUNHO"/.test(listaActions),
    "…desde 2026-09-29 só elimina um RASCUNHO (finalizada anula-se)"
  );
  check(listaActions.includes("export async function anularListaEncomendaAction"), "anularListaEncomendaAction existe");
  check(
    listaActions.includes("podeAnularListaEncomenda(lista.estado, motivo)"),
    "…usa a lógica pura de anulação, não uma cópia"
  );
  check(listaActions.includes('estado: "ANULADA"'), "…transita para ANULADA (nunca apaga row/linhas)");
  check(
    listaActions.includes("anuladoPorId: session.sub") && listaActions.includes("anuladoEm: new Date()"),
    "…regista quem e quando"
  );
}
{
  const transfActions = src("app/transferencias/actions.ts");
  check(
    transfActions.includes("export async function deleteTransferenciaAction"),
    "deleteTransferenciaAction existe"
  );
  check(
    /export async function deleteTransferenciaAction[\s\S]{0,200}requirePermission\("settings\.global"\)/.test(
      transfActions
    ),
    "…exige settings.global — mesma família de acções destrutivas"
  );
  check(
    transfActions.includes('estado: "ELIMINADA"'),
    "…transita para ELIMINADA (soft-delete)"
  );
  check(
    !/deleteTransferenciaAction[\s\S]{0,1500}transferencia\.delete\(/.test(transfActions),
    "…nunca apaga a row (prisma.transferencia.delete)"
  );
  check(
    /export async function deleteTransferenciaAction[\s\S]{0,900}estado !== "RASCUNHO"/.test(transfActions),
    "…desde 2026-09-29 só elimina um RASCUNHO (finalizada anula-se)"
  );
  check(transfActions.includes("export async function anularTransferenciaAction"), "anularTransferenciaAction existe");
  check(
    transfActions.includes("podeAnularTransferencia(transferencia.estado, motivo)"),
    "…usa a lógica pura de anulação, não uma cópia"
  );
  check(transfActions.includes('estado: "ANULADA"'), "…transita para ANULADA (nunca apaga row/linhas)");
  check(
    transfActions.includes("canAccessFarmaciaSync(session, transferencia.farmaciaOrigemId)") &&
      transfActions.includes("canAccessFarmaciaSync(session, transferencia.farmaciaDestinoId)"),
    "…verifica acesso a AMBAS as farmácias (origem e destino) antes de anular"
  );
  check(transfActions.includes("export async function duplicarTransferenciaAction"), "duplicarTransferenciaAction existe");
}

// ═════════════════════════════════════════════════════════════════════
// D · As listagens normais escondem ELIMINADA por omissão
// ═════════════════════════════════════════════════════════════════════
console.log("\nD · ELIMINADA sai das listagens normais por omissão\n");

{
  const ordersData = src("lib/encomendas/orders-data.ts");
  check(
    /where\.estado\s*=\s*\{\s*not:\s*"ELIMINADA"\s*\}/.test(ordersData),
    "loadOrderListData filtra ELIMINADA quando não há filtro de estado explícito"
  );
}
{
  const registadas = src("lib/transferencias/registadas-data.ts");
  check(
    /where:\s*\{\s*estado:\s*\{\s*not:\s*"ELIMINADA"\s*\}\s*\}/.test(registadas),
    "loadTransferenciasRegistadas filtra ELIMINADA por omissão"
  );
}

// ═════════════════════════════════════════════════════════════════════
// E · createInternalTransferAction cria uma Transferencia real
// ═════════════════════════════════════════════════════════════════════
console.log("\nE · createInternalTransferAction já não cria ListaEncomenda/OrderOutbox\n");

{
  const acoes = src("app/encomendas/nova/actions.ts");
  // \r?\n — o repositório é desenvolvido em Windows com core.autocrlf=true;
  // um \n bare não sobrevive a um checkout com terminadores CRLF.
  const match = acoes.match(/export async function createInternalTransferAction\b[\s\S]*?\r?\n\}\r?\n/);
  check(match !== null, "a função existe e tem um corpo isolável");
  const corpo = match ? match[0] : "";
  // Desde 2026-09-29 a criação passa por `criarTransferenciaComLinhas`
  // (lib/transferencias/criar-transferencia.ts) — o mesmo caminho único e
  // idempotente que também serve `gerarPlanoGrupoAction`. Já não chama
  // `tx.transferencia.create` directamente.
  check(corpo.includes("criarTransferenciaComLinhas("), "cria a Transferencia real via o módulo único de criação");
  check(corpo.includes("linhas:"), "…com a sua LinhaTransferencia");
  check(corpo.includes("finalize: true"), "…nasce já FINALIZADA (não fica presa em RASCUNHO)");
  check(!corpo.includes("createEncomendaWithOutbox"), "…sem passar pelo caminho de ListaEncomenda+Outbox");
  check(!corpo.includes("OrderOutbox"), "…nenhum OrderOutbox nasce daqui");
  check(
    corpo.includes("return { ok: true, transferenciaId };"),
    "…devolve transferenciaId, não listaEncomendaId"
  );
}
{
  const botao = src("components/transferencias/create-internal-transfer-button.tsx");
  check(
    botao.includes('router.push("/transferencias")'),
    "o botão navega para a listagem de Transferências reais"
  );
  check(!botao.includes("listaEncomendaId"), "…e já não referencia listaEncomendaId");
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
