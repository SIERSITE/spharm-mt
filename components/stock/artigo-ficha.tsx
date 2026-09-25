import Image from "next/image";
import { Package, Tag, Building2, Image as ImageIcon, Pill, Stethoscope } from "lucide-react";
import type { ArtigoFichaData } from "@/lib/stock/artigo-ficha-data";

/**
 * components/stock/artigo-ficha.tsx
 *
 * Conteúdo da "ficha do artigo" — identidade + stock por farmácia — como
 * componente PURO (sem MainShell, sem "voltar", sem extrato de
 * movimentos: essas partes são específicas de cada sítio que a usa).
 * Extraído de app/stock/artigo/[cnp]/page.tsx para ser reutilizado quer
 * pela página completa (acesso directo por URL) quer pelo painel
 * lateral (components/stock/artigo-panel.tsx) — a MESMA lógica, nunca
 * duplicada.
 */

const PLACEHOLDER = "—";

function fmtNumber(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return `${value.toLocaleString("pt-PT")}${suffix}`;
}

function fmtCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function fmtDelta(delta: number): string {
  const abs = Math.abs(delta).toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${delta > 0 ? "+" : "−"}${abs}`;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return PLACEHOLDER;
  return new Date(value).toLocaleDateString("pt-PT");
}

const COLUNAS_STOCK = "grid-cols-[1.2fr_0.85fr_0.85fr_0.55fr_0.55fr_0.8fr_0.8fr]";

function SmallMetric({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-tight text-slate-900">{value}</div>
      <div className="mt-1 text-[10px] text-slate-500">{helper}</div>
    </div>
  );
}

function IdentityField({ icon, label, value, iconClass }: { icon: React.ReactNode; label: string; value: string; iconClass: string }) {
  return (
    <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={iconClass}>{icon}</span>
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</div>
      </div>
      <div className="text-[13px] font-medium text-slate-800">{value}</div>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-slate-800">{value}</div>
    </div>
  );
}

export function ArtigoFicha({ data, compacto = false }: { data: ArtigoFichaData; compacto?: boolean }) {
  return (
    <div className="space-y-5">
      {!compacto && (
        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-4 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid gap-5 lg:grid-cols-[180px_1fr]">
            <div className="flex items-center justify-center rounded-[14px] border border-slate-100 bg-slate-50/80 p-4">
              {data.imagemUrl ? (
                <Image src={data.imagemUrl} alt={data.designacao} width={160} height={180} className="h-auto max-h-[180px] w-auto object-contain" unoptimized />
              ) : (
                <div className="flex h-full min-h-[180px] w-full flex-col items-center justify-center rounded-[12px] border border-dashed border-slate-200 bg-white text-center">
                  <ImageIcon className="h-8 w-8 text-slate-300" />
                  <div className="mt-3 text-[12px] font-medium text-slate-500">Sem imagem</div>
                </div>
              )}
            </div>
            <ArtigoIdentidade data={data} />
          </div>
        </section>
      )}
      {compacto && <ArtigoIdentidade data={data} />}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SmallMetric label="Stock total" value={fmtNumber(data.stockTotal, " un.")} helper={`${data.farmaciasComStock} farmácia(s) com stock`} />
        <SmallMetric label="Farmácias" value={fmtNumber(data.stockRows.length)} helper="Activas com este artigo" />
        <SmallMetric label="Última venda" value={fmtDate(data.ultimaVenda)} helper="Mais recente entre farmácias" />
        <SmallMetric label="PVP de referência" value={fmtCurrency(data.pvpReferencia)} helper={data.pvpReferenciaDescricao} />
        <SmallMetric label="Custo de referência" value={fmtCurrency(data.custoReferencia)} helper={data.custoReferenciaDescricao} />
      </section>

      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
        <div className="mb-3 flex items-center gap-2">
          <Package className="h-4 w-4 text-emerald-600" />
          <h2 className="text-[14px] font-semibold text-slate-900">Stock por farmácia</h2>
        </div>
        {data.stockRows.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-slate-500">Sem registos de ProdutoFarmacia para este artigo.</div>
        ) : (
          <>
            <div className={`grid ${COLUNAS_STOCK} gap-4 border-b border-slate-100 pb-2 text-[10px] uppercase tracking-[0.14em] text-slate-400`}>
              <div>Farmácia</div>
              <div className="text-right">PVP</div>
              <div className="text-right">Custo</div>
              <div>Stock</div>
              <div>Mínimo</div>
              <div>Última venda</div>
              <div>Validade + antiga</div>
            </div>
            {data.stockRows.map((row) => (
              <div key={row.farmaciaId} className={`grid ${COLUNAS_STOCK} gap-4 border-b border-slate-100 py-3 text-[12px] text-slate-600 last:border-b-0`}>
                <div className="font-medium text-slate-800">{row.farmaciaNome}</div>
                <div className="text-right tabular-nums">
                  <span className={row.desvioPvp !== null ? "text-slate-800" : undefined}>{fmtCurrency(row.pvp)}</span>
                  {row.desvioPvp !== null && (
                    <span className="ml-1.5 text-[10px] font-medium tabular-nums text-amber-700" title={`Difere do PVP de referência (${fmtCurrency(data.pvpReferencia)})`}>
                      {fmtDelta(row.desvioPvp)}
                    </span>
                  )}
                </div>
                <div className="text-right tabular-nums" title={row.fonteCusto === "PUC" ? "Custo da última compra (sem preço médio disponível)" : "Preço médio de compra"}>
                  <span className="text-slate-800">{fmtCurrency(row.custo)}</span>
                  {row.fonteCusto === "PUC" && <span className="ml-0.5 text-[10px] text-slate-400">*</span>}
                  {row.desvioCusto !== null && (
                    <span className="ml-1.5 text-[10px] font-medium tabular-nums text-amber-700" title={`Difere do custo de referência (${fmtCurrency(data.custoReferencia)})`}>
                      {fmtDelta(row.desvioCusto)}
                    </span>
                  )}
                </div>
                <div>{fmtNumber(row.stock, " un.")}</div>
                <div>{fmtNumber(row.stockMinimo)}</div>
                <div>{fmtDate(row.ultimaVenda)}</div>
                <div>{fmtDate(row.validadeMaisAntiga)}</div>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function ArtigoIdentidade({ data }: { data: ArtigoFichaData }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Identificação</div>
        <h2 className="mt-1 text-[18px] font-semibold text-slate-900">{data.designacao}</h2>
        {(data.categoria || data.grupo) && (
          <p className="mt-1 text-[12px] text-slate-500">
            {data.categoria}
            {data.grupo && data.grupo !== data.categoria ? ` · ${data.grupo}` : ""}
          </p>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <IdentityField icon={<Tag className="h-4 w-4" />} iconClass="text-emerald-600" label="Categoria" value={data.categoria} />
        <IdentityField icon={<Building2 className="h-4 w-4" />} iconClass="text-cyan-600" label="Fabricante" value={data.fabricante} />
        <IdentityField icon={<Pill className="h-4 w-4" />} iconClass="text-violet-600" label="Princípio ativo" value={data.principioAtivo} />
        <IdentityField icon={<Stethoscope className="h-4 w-4" />} iconClass="text-rose-600" label="ATC" value={data.atc} />
        <IdentityField icon={<Package className="h-4 w-4" />} iconClass="text-amber-600" label="Forma" value={data.forma} />
      </div>

      <div className="grid gap-3 md:grid-cols-6">
        <MetaCell label="CNP" value={String(data.cnp)} />
        <MetaCell label="Subcategoria" value={data.subcategoria} />
        <MetaCell label="Tipo de produto" value={data.tipoProduto} />
        <MetaCell label="Dosagem" value={data.dosagem} />
        <MetaCell label="Embalagem" value={data.embalagem} />
        <MetaCell label="PVP" value={fmtCurrency(data.pvpReferencia)} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <MetaCell label="Utilizações" value={data.utilizacoes} />
        <MetaCell label="Genérico" value={data.flagGenerico ? "Sim" : data.flagGenerico === false ? "Não" : PLACEHOLDER} />
      </div>
    </div>
  );
}
