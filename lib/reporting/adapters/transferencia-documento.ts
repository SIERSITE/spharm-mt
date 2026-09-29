/**
 * lib/reporting/adapters/transferencia-documento.ts
 *
 * "Guia de Transferência" — documento formal de UMA (ou várias)
 * `Transferencia` já geradas (ver order-create-client.tsx, Bloco D:
 * decisão TRANSFERIR em modo grupo). Mesmo mecanismo/infra de
 * `encomenda-documento.ts` — ver esse ficheiro para a explicação do
 * padrão "1 = documento simples, N = um grupo por transferência".
 */
import type { TransferenciaDetail } from "@/lib/transferencias/transferencia-detail";
import type { Report, ReportColumn, ReportFilter, ReportRow, ReportSummaryItem } from "../report-types";
import { ROW_KIND_KEY, GROUP_KEY } from "../report-types";
import { normalizarLargura } from "../column-widths";

/**
 * SÓ estes três dados de produto — CNP, designação, quantidade. Nunca
 * fabricante, stock, cobertura, rotação, preço de custo, sugestão ou
 * qualquer outro critério interno: a farmácia que recebe não precisa
 * (nem deve ver) esses dados, só o que tem de conferir fisicamente.
 */
const BASE_WIDTHS = { rota: 22, cnp: 14, produto: 44, quantidade: 14, notas: 20 };

function columns(multi: boolean): ReportColumn[] {
  const w = normalizarLargura(BASE_WIDTHS);
  const cols: ReportColumn[] = [];
  if (multi) cols.push({ key: "rota", label: "Origem → Destino", format: "text", width: w.rota, spanGroup: true });
  cols.push(
    { key: "cnp", label: "CNP", format: "text", width: multi ? w.cnp : w.cnp * 1.3 },
    { key: "produto", label: "Produto", format: "text", width: multi ? w.produto : w.produto * 1.3 },
    { key: "quantidade", label: "Quantidade", format: "integer", align: "right", width: w.quantidade, showTotal: true },
    { key: "notas", label: "Notas", format: "text", width: w.notas }
  );
  return cols;
}

/** "TR-000045", ou um marcador claro quando ainda não foi finalizada. */
function formatNumero(numero: string | null): string {
  return numero ?? "(rascunho)";
}

function formatDataSimples(d: Date): string {
  return d.toLocaleDateString("pt-PT");
}

/**
 * Referências/unidades — SÓ isto entra em `summary`. `meta.density:
 * "compact"` (ver mais abaixo) esconde os cartões de resumo em HTML/PDF
 * (ver report-html.ts `renderSummary`/`isCompact`) — `summary` continua a
 * alimentar o Excel/email (report-excel-buffer.ts lê `report.summary`
 * sempre, independente de density), mas nunca é isto que a farmácia vê
 * no documento impresso. Número/data/estado vão por `filtersApplied` e
 * "Preparado por"/"Recebido por" por `meta.footer` — ver
 * `buildHeaderFilters`/`buildFooterTexto` abaixo, que SÃO desenhados em
 * compact (mesmo padrão de `encomenda-documento.ts`).
 */
function buildSummary(details: readonly TransferenciaDetail[]): ReportSummaryItem[] {
  const totalLinhas = details.reduce((s, d) => s + d.linhas.length, 0);
  const totalUnidades = details.reduce((s, d) => s + d.linhas.reduce((s2, l) => s2 + l.quantidade, 0), 0);
  return [
    { label: "Transferências", value: details.length, format: "integer" },
    { label: "Linhas", value: totalLinhas, format: "integer" },
    { label: "Unidades", value: totalUnidades, format: "integer" },
  ];
}

/**
 * Nome de quem preparou, só quando é a MESMA pessoa em todo o documento
 * — num lote (>1 transferência) cada uma pode ter sido criada por
 * alguém diferente, e assinar só a primeira seria enganador.
 */
function preparadoPorUniforme(details: readonly TransferenciaDetail[]): string | null {
  const nomes = new Set(details.map((d) => d.criadoPorNome));
  return nomes.size === 1 ? (details[0]?.criadoPorNome ?? null) : null;
}

/**
 * Número/data/estado do documento — mesmo mecanismo de
 * `encomenda-documento.ts` (`filtersApplied`), porque em `density:
 * "compact"` é isto (e não `summary`) que o HTML/PDF desenha por baixo
 * do cabeçalho. Origem/destino já vêm no `subtitle` (caso simples) ou na
 * coluna `rota` por grupo (caso multi) — não repetidos aqui.
 *
 * No caso multi (>1 transferência) número/data variam por documento, por
 * isso só entra "Estado" e só quando é o MESMO para todo o lote — um
 * valor por documento individual não cabe num único cabeçalho.
 */
function buildHeaderFilters(details: readonly TransferenciaDetail[], multi: boolean): ReportFilter[] {
  if (details.length === 0) return [];
  if (!multi) {
    const d = details[0];
    return [
      { label: "Nº Documento", value: formatNumero(d.numero) },
      { label: "Data", value: formatDataSimples(d.dataFinalizacao ?? d.dataCriacao) },
      { label: "Estado", value: d.estado },
    ];
  }
  const estados = new Set(details.map((d) => d.estado));
  return estados.size === 1 ? [{ label: "Estado", value: [...estados][0] }] : [];
}

/**
 * "Preparado por"/"Recebido por" — em `meta.footer`, nunca em `summary`
 * (invisível em compact, ver comentário de `buildSummary`). "Recebido
 * por" é sempre uma linha em branco de propósito, para a farmácia que
 * recebe assinar à mão.
 */
function buildFooterTexto(details: readonly TransferenciaDetail[]): string {
  const preparadoPor = preparadoPorUniforme(details);
  const partes = preparadoPor ? [`Preparado por: ${preparadoPor}`] : [];
  partes.push("Recebido por: ____________________");
  return partes.join("   ·   ");
}

export function buildTransferenciaDocumentoReport(details: readonly TransferenciaDetail[]): Report {
  const multi = details.length > 1;
  // Uma transferência ANULADA num lote misto (algumas ANULADAS, outras
  // não) não pode acender o selo "ANULADO" do documento inteiro — esse
  // selo é um mecanismo de UM por documento. Só quando o lote INTEIRO
  // está ANULADO é que faz sentido ao nível do documento; caso
  // contrário marca-se só a linha/grupo afectado (ver `anuladaMista`
  // abaixo).
  const todasAnuladas = details.length > 0 && details.every((d) => d.estado === "ANULADA");

  const rows: ReportRow[] = [];
  for (const d of details) {
    const anuladaMista = multi && d.estado === "ANULADA" && !todasAnuladas;
    const rota = `${anuladaMista ? "(ANULADO) " : ""}${d.farmaciaOrigemNome} → ${d.farmaciaDestinoNome}`;
    for (const l of d.linhas) {
      rows.push({
        [GROUP_KEY]: d.id,
        rota,
        cnp: String(l.cnp),
        produto: l.designacao,
        quantidade: l.quantidade,
        notas: l.notas ?? "",
      });
    }
    if (multi && d.linhas.length > 1) {
      rows.push({
        [GROUP_KEY]: d.id,
        [ROW_KIND_KEY]: "subtotal",
        rota,
        cnp: "",
        produto: `TOTAL ${rota}`,
        quantidade: d.linhas.reduce((s, l) => s + l.quantidade, 0),
        notas: "",
      });
    }
  }

  const primeira = details[0];
  const report: Report = {
    title: multi ? "Guias de Transferência" : "Guia de Transferência",
    subtitle: multi
      ? `${details.length} transferência(s) geradas`
      : `${primeira?.farmaciaOrigemNome ?? ""} → ${primeira?.farmaciaDestinoNome ?? ""}`,
    generatedAt: new Date(),
    filtersApplied: buildHeaderFilters(details, multi),
    summary: buildSummary(details),
    columns: columns(multi),
    rows,
    meta: {
      slug: multi ? "guias-transferencia" : "guia-transferencia",
      orientation: "portrait",
      // Carta-cabeçalho = a farmácia de ORIGEM (quem emite a guia), não
      // o nome comercial do SaaS.
      organization: primeira?.farmaciaOrigemNome,
      organizationAddress: primeira?.farmaciaOrigemMorada ?? undefined,
      organizationNif: primeira?.farmaciaOrigemNif ?? undefined,
      organizationContact: primeira?.farmaciaOrigemContacto ?? undefined,
      density: "compact",
      footer: buildFooterTexto(details),
    },
  };

  // Selo "ANULADO" ao nível do documento: caso simples ANULADA, ou lote
  // inteiro ANULADO (ver `todasAnuladas` acima). Lote misto fica sem
  // selo — a marcação fica só na(s) linha(s) via `anuladaMista`.
  if (primeira && ((!multi && primeira.estado === "ANULADA") || (multi && todasAnuladas))) {
    report.meta!.cancelledStamp = {
      motivo: primeira.motivoAnulacao,
      por: primeira.anuladoPorNome,
      em: primeira.anuladoEm,
    };
  }

  return report;
}
