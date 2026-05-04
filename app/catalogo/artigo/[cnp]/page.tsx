import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MainShell } from "@/components/layout/main-shell";
import {
  loadCatalogoArticle,
  type CatalogoArticle,
} from "@/lib/catalogo-data";
import type { ProdutoEstado, VerificationStatus } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

type ArticlePageProps = {
  params: Promise<{ cnp: string }>;
};

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  MEDICAMENTO: "Medicamento",
  SUPLEMENTO: "Suplemento alimentar",
  DERMOCOSMETICA: "Dermocosmética",
  DISPOSITIVO_MEDICO: "Dispositivo médico",
  HIGIENE_CUIDADO: "Higiene & cuidado",
  ORTOPEDIA: "Ortopedia",
  PUERICULTURA: "Puericultura",
  VETERINARIA: "Veterinária",
  OUTRO: "Outro / não classificado",
};

const ESTADO_LABELS: Record<ProdutoEstado, string> = {
  NOVO: "Novo",
  PENDENTE: "Pendente",
  PARCIALMENTE_ENRIQUECIDO: "Parc. enriquecido",
  ENRIQUECIDO_AUTOMATICAMENTE: "Enriquecido auto.",
  VALIDADO: "Validado",
  INATIVO: "Inativo",
};

const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  PENDING: "Pendente",
  IN_PROGRESS: "Em curso",
  VERIFIED: "Verificado",
  PARTIALLY_VERIFIED: "Parcialmente verificado",
  FAILED: "Sem dados",
  NEEDS_REVIEW: "Precisa revisão",
};

const VERIFICATION_TONES: Record<VerificationStatus, string> = {
  VERIFIED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARTIALLY_VERIFIED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  NEEDS_REVIEW: "border-amber-200 bg-amber-50 text-amber-700",
  PENDING: "border-slate-200 bg-slate-50 text-slate-600",
  IN_PROGRESS: "border-sky-200 bg-sky-50 text-sky-700",
  FAILED: "border-rose-200 bg-rose-50 text-rose-700",
};

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtNumber(n: number | null, digits = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function or(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "—";
}

export default async function CatalogArticlePage({ params }: ArticlePageProps) {
  const { cnp } = await params;
  const cnpNum = Number(cnp);
  if (!Number.isFinite(cnpNum) || cnpNum <= 0) notFound();

  const article = await loadCatalogoArticle(cnpNum);
  if (!article) notFound();

  return (
    <MainShell>
      <ArticleView article={article} />
    </MainShell>
  );
}

function ArticleView({ article }: { article: CatalogoArticle }) {
  const tipo = article.productType
    ? PRODUCT_TYPE_LABELS[article.productType] ?? article.productType
    : "—";

  const minPvp = article.presencas
    .map((p) => p.pvp)
    .filter((n): n is number => n != null && n > 0);
  const headerPvp = minPvp.length > 0 ? Math.min(...minPvp) : null;

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/catalogo"
          className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
        >
          ← Voltar ao catálogo
        </Link>
        <Link
          href={`/admin/catalogo/revisao/${article.id}`}
          className="inline-flex items-center rounded-full border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 transition hover:border-cyan-400"
        >
          Verificar classificação
        </Link>
      </section>

      {/* Cabeçalho */}
      <section className="rounded-[24px] border border-white/70 bg-white/90 px-5 py-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex items-start gap-4">
            {article.imagemUrl ? (
              <Image
                src={article.imagemUrl}
                alt=""
                width={84}
                height={84}
                unoptimized
                className="h-20 w-20 shrink-0 rounded-xl border border-slate-200 bg-white object-contain"
              />
            ) : (
              <div className="h-20 w-20 shrink-0 rounded-xl border border-dashed border-slate-200 bg-slate-50" />
            )}
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                Ficha mestre do artigo
              </div>
              <h1 className="text-[26px] font-semibold tracking-tight text-slate-900">
                {article.designacao}
              </h1>
              <p className="text-[13px] text-slate-600">
                CNP {article.cnp}
                {article.fabricante && (
                  <>
                    <span className="px-1.5 text-slate-400">·</span>
                    {article.fabricante.nomeNormalizado}
                  </>
                )}
                {article.classificacaoNivel1 && (
                  <>
                    <span className="px-1.5 text-slate-400">·</span>
                    {article.classificacaoNivel1.nome}
                    {article.classificacaoNivel2 && (
                      <span className="text-slate-500">
                        {" "}
                        / {article.classificacaoNivel2.nome}
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge tone="slate" label={ESTADO_LABELS[article.estado]} />
            <Badge
              tone={article.verificationStatus === "VERIFIED" ? "emerald" : article.verificationStatus === "NEEDS_REVIEW" ? "amber" : "cyan"}
              label={VERIFICATION_LABELS[article.verificationStatus]}
              className={VERIFICATION_TONES[article.verificationStatus]}
            />
            {article.flagMSRM && <Badge tone="sky" label="Receita médica" />}
            {article.flagMNSRM && <Badge tone="slate" label="Sem receita" />}
            {article.flagGenerico && <Badge tone="emerald" label="Genérico" />}
            {article.validadoManualmente && (
              <Badge tone="emerald" label="Validado manualmente" />
            )}
          </div>
        </div>
      </section>

      {/* Métricas */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="PVP min."
          value={headerPvp == null ? "—" : `${fmtMoney(headerPvp)} €`}
          hint={
            article.presencas.length > 0
              ? `${article.presencas.length} farmácia${article.presencas.length === 1 ? "" : "s"}`
              : "Sem registo nas farmácias"
          }
        />
        <MetricCard label="ATC" value={or(article.codigoATC)} hint="Código terapêutico" />
        <MetricCard label="Forma" value={or(article.formaFarmaceutica)} />
        <MetricCard label="Dosagem" value={or(article.dosagem)} />
      </section>

      {/* Cartões de detalhe */}
      <section className="grid gap-4 xl:grid-cols-2">
        <InfoCard
          title="Identificação"
          items={[
            { label: "CNP", value: String(article.cnp) },
            { label: "Designação", value: article.designacao },
            {
              label: "Fabricante",
              value: article.fabricante?.nomeNormalizado ?? "—",
            },
            { label: "Origem dos dados", value: article.origemDados },
            { label: "Estado do artigo", value: ESTADO_LABELS[article.estado] },
          ]}
        />

        <InfoCard
          title="Classificação"
          items={[
            { label: "Princípio ativo (DCI)", value: or(article.dci) },
            { label: "Código ATC", value: or(article.codigoATC) },
            {
              label: "Categoria nível 1",
              value: article.classificacaoNivel1?.nome ?? "—",
            },
            {
              label: "Categoria nível 2",
              value: article.classificacaoNivel2?.nome ?? "—",
            },
            { label: "Tipo de produto", value: tipo },
            { label: "Genérico", value: article.flagGenerico ? "Sim" : "Não" },
          ]}
        />

        <InfoCard
          title="Apresentação comercial"
          items={[
            { label: "Forma farmacêutica", value: or(article.formaFarmaceutica) },
            { label: "Dosagem", value: or(article.dosagem) },
            { label: "Embalagem", value: or(article.embalagem) },
            { label: "Receita médica (MSRM)", value: article.flagMSRM ? "Sim" : "Não" },
            { label: "Sem receita (MNSRM)", value: article.flagMNSRM ? "Sim" : "Não" },
          ]}
        />

        <InfoCard
          title="Estado de verificação"
          items={[
            { label: "Verificação", value: VERIFICATION_LABELS[article.verificationStatus] },
            {
              label: "Confiança no tipo",
              value: fmtPct(article.productTypeConfidence),
            },
            {
              label: "Fonte da classificação",
              value: or(article.classificationSource),
            },
            {
              label: "Versão da classificação",
              value: or(article.classificationVersion),
            },
            { label: "Verificado externamente", value: article.externallyVerified ? "Sim" : "Não" },
            {
              label: "Validado manualmente",
              value: article.validadoManualmente ? "Sim" : "Não",
            },
            {
              label: "Última verificação",
              value: fmtDate(article.lastVerifiedAt),
            },
          ]}
        />
      </section>

      {/* Motivo da revisão manual, se aplicável */}
      {article.needsManualReview && article.manualReviewReason && (
        <section className="rounded-[20px] border border-amber-200 bg-amber-50 px-5 py-4 text-[13px] text-amber-900">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
            Motivo da revisão manual
          </div>
          <p className="mt-1 leading-6">{article.manualReviewReason}</p>
        </section>
      )}

      {/* Presença por farmácia */}
      <section className="overflow-hidden rounded-[24px] border border-white/70 bg-white/90 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Presença por farmácia</h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Dados locais (PVP, PMC, stock) por farmácia que comercializa o produto.
          </p>
        </div>
        {article.presencas.length === 0 ? (
          <div className="px-5 py-6 text-center text-[13px] text-slate-400">
            Este produto não está registado em nenhuma farmácia.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Farmácia</th>
                  <th className="px-3 py-2.5 font-semibold">Designação local</th>
                  <th className="px-3 py-2.5 text-right font-semibold">PVP</th>
                  <th className="px-3 py-2.5 text-right font-semibold">PMC</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                {article.presencas.map((pf) => (
                  <tr key={pf.farmaciaId} className="hover:bg-slate-50/70">
                    <td className="px-4 py-2 font-medium text-slate-800">{pf.farmaciaNome}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-600">
                      {or(pf.designacaoLocal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {pf.pvp == null ? "—" : `${fmtMoney(pf.pvp)} €`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">
                      {pf.pmc == null ? "—" : `${fmtMoney(pf.pmc)} €`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {fmtNumber(pf.stockAtual, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function InfoCard({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: string }[];
}) {
  return (
    <section className="rounded-[24px] border border-white/70 bg-white/90 p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div className="border-b border-dashed border-slate-200 pb-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      </div>
      <div className="mt-4 space-y-2.5">
        {items.map((item) => (
          <div
            key={`${title}-${item.label}`}
            className="flex items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-2.5"
          >
            <div className="text-[12px] font-medium text-slate-500">{item.label}</div>
            <div className="max-w-[60%] text-right text-[13px] font-medium text-slate-900">
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/70 bg-white/90 px-5 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function Badge({
  label,
  tone = "slate",
  className,
}: {
  label: string;
  tone?: "slate" | "emerald" | "cyan" | "amber" | "sky";
  className?: string;
}) {
  const tones: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 text-slate-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-semibold ${
        className ?? tones[tone]
      }`}
    >
      {label}
    </span>
  );
}
