/**
 * lib/reporting/adapters/encomenda-consolidada-documento.ts
 *
 * "Encomenda única do Grupo" — o documento consolidado para negociar
 * volume com o fornecedor (ver decisão de arquitectura em order-create-
 * client.tsx / handleFinalizarGrupo): NÃO existe nenhuma `ListaEncomenda`
 * multi-farmácia na base de dados — continuam a criar-se as mesmas N
 * `ListaEncomenda` por farmácia de sempre (outbox/exportação ao ERP de
 * cada farmácia intactos). Isto é só a APRESENTAÇÃO: agrega as
 * quantidades por produto entre as N encomendas já criadas, com a
 * origem por farmácia preservada como sub-linhas dentro do mesmo grupo
 * (nunca perdida — só apresentada agregada).
 *
 * Mesmo mecanismo do Relatório de Vendas (agrupar por artigo, sublinhas
 * por farmácia, TOTAL ARTIGO, TOTAL GERAL) — aqui chamado directamente
 * porque a forma dos dados (uma `OrderDetail` por farmácia, juntar por
 * produto) não é exactamente a de `agruparLinhasPorArtigo` (que espera já
 * uma lista achatada de (artigo, farmácia)).
 */
import type { OrderDetail } from "@/lib/encomendas/order-detail";
import type { Report, ReportColumn, ReportRow, ReportSummaryItem } from "../report-types";
import { ROW_KIND_KEY, GROUP_KEY } from "../report-types";
import { normalizarLargura } from "../column-widths";
import { ordenarPorFarmacia } from "../ordenacao-farmacias";

const W = normalizarLargura({ cnp: 12, produto: 34, fabricante: 16, farmacia: 20, quantidade: 18 });

const COLUMNS: ReportColumn[] = [
  { key: "cnp", label: "CNP", format: "text", width: W.cnp, spanGroup: true },
  { key: "produto", label: "Produto", format: "text", width: W.produto, spanGroup: true },
  { key: "fabricante", label: "Fabricante", format: "text", width: W.fabricante, spanGroup: true },
  { key: "farmacia", label: "Farmácia (origem)", format: "text", width: W.farmacia },
  { key: "quantidade", label: "Quantidade", format: "integer", align: "right", width: W.quantidade, showTotal: true },
];

type LinhaAchatada = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  farmaciaNome: string;
  quantidade: number;
};

/**
 * Agrupa por produto preservando a ordem de 1ª aparição, cada grupo com
 * as suas sub-linhas por farmácia em ordem estável (`ordenarPorFarmacia`
 * — a mesma função usada por Vendas/Margens/Inventário).
 */
function agruparPorProduto(linhas: readonly LinhaAchatada[]): LinhaAchatada[][] {
  const porProduto = new Map<string, LinhaAchatada[]>();
  const ordem: string[] = [];
  for (const l of linhas) {
    const lista = porProduto.get(l.produtoId);
    if (lista) lista.push(l);
    else {
      porProduto.set(l.produtoId, [l]);
      ordem.push(l.produtoId);
    }
  }
  return ordem.map((id) => ordenarPorFarmacia(porProduto.get(id)!, (l) => l.farmaciaNome));
}

export function buildEncomendaConsolidadaDocumentoReport(details: readonly OrderDetail[]): Report {
  const achatadas: LinhaAchatada[] = [];
  for (const d of details) {
    for (const l of d.linhas) {
      achatadas.push({
        produtoId: l.produtoId,
        cnp: l.cnp,
        designacao: l.designacao,
        fabricante: l.fabricante,
        farmaciaNome: d.farmaciaNome,
        quantidade: l.quantidadeAjustada ?? 0,
      });
    }
  }
  const grupos = agruparPorProduto(achatadas);

  const rows: ReportRow[] = [];
  for (const grupo of grupos) {
    const primeira = grupo[0];
    for (const l of grupo) {
      rows.push({
        [GROUP_KEY]: l.produtoId,
        cnp: String(l.cnp),
        produto: l.designacao,
        fabricante: l.fabricante ?? "—",
        farmacia: l.farmaciaNome,
        quantidade: l.quantidade,
      });
    }
    // Só vale a pena um TOTAL PRODUTO quando há mais de uma farmácia a
    // contribuir — com uma só seria uma cópia exacta da linha de
    // detalhe (mesmo critério de `grupoArtigoPrecisaDeTotal`).
    if (grupo.length > 1) {
      rows.push({
        [GROUP_KEY]: primeira.produtoId,
        [ROW_KIND_KEY]: "subtotal",
        cnp: String(primeira.cnp),
        produto: primeira.designacao,
        fabricante: primeira.fabricante ?? "—",
        farmacia: `TOTAL — ${grupo.length} farmácias`,
        quantidade: grupo.reduce((s, l) => s + l.quantidade, 0),
      });
    }
  }

  const farmaciasEnvolvidas = new Set(details.map((d) => d.farmaciaNome));
  const totalUnidades = achatadas.reduce((s, l) => s + l.quantidade, 0);
  const summary: ReportSummaryItem[] = [
    { label: "Farmácias", value: farmaciasEnvolvidas.size, format: "integer" },
    { label: "Referências", value: grupos.length, format: "integer" },
    { label: "Unidades (total)", value: totalUnidades, format: "integer" },
  ];

  return {
    title: "Encomenda Consolidada do Grupo",
    subtitle: `${farmaciasEnvolvidas.size} farmácia(s) · ${[...farmaciasEnvolvidas].join(", ")}`,
    generatedAt: new Date(),
    summary,
    columns: COLUMNS,
    rows,
    meta: {
      slug: "encomenda-consolidada-grupo",
      orientation: "portrait",
      organization: "SPharm.MT",
      density: "compact",
      footer:
        "SPharm.MT · Documento de negociação — cada farmácia continua a ser facturada/recebida separadamente; origem por farmácia mantida acima.",
    },
  };
}
