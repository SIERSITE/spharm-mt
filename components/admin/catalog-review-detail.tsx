"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Lock } from "lucide-react";
import type {
  ReviewDetail,
  FabricanteOption,
  ClassificacaoOption,
  ProductEvidenceEntry,
} from "@/lib/admin/catalog-review-data";
import {
  applyReviewAction,
  dismissReviewAction,
  type ApplyReviewInput,
} from "@/app/admin/catalogo/revisao/actions";

type ProductType =
  | "MEDICAMENTO"
  | "SUPLEMENTO"
  | "DERMOCOSMETICA"
  | "DISPOSITIVO_MEDICO"
  | "HIGIENE_CUIDADO"
  | "ORTOPEDIA"
  | "PUERICULTURA"
  | "VETERINARIA"
  | "OUTRO";

const PRODUCT_TYPES: ProductType[] = [
  "MEDICAMENTO",
  "SUPLEMENTO",
  "DERMOCOSMETICA",
  "DISPOSITIVO_MEDICO",
  "HIGIENE_CUIDADO",
  "ORTOPEDIA",
  "PUERICULTURA",
  "VETERINARIA",
  "OUTRO",
];

const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  MEDICAMENTO: "Medicamento",
  SUPLEMENTO: "Suplemento alimentar",
  DERMOCOSMETICA: "Dermocosmética",
  DISPOSITIVO_MEDICO: "Dispositivo médico",
  HIGIENE_CUIDADO: "Higiene e cuidado",
  ORTOPEDIA: "Ortopedia",
  PUERICULTURA: "Puericultura",
  VETERINARIA: "Veterinária",
  OUTRO: "Outro",
};

type Props = {
  detail: ReviewDetail;
  fabricantes: FabricanteOption[];
  classificacoes: { nivel1: ClassificacaoOption[]; nivel2: ClassificacaoOption[] };
  evidence: ProductEvidenceEntry[];
};

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

export function CatalogReviewDetail({ detail, fabricantes, classificacoes, evidence }: Props) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(
    null
  );

  // Estado do formulário — pré-preenchido com valores actuais do produto.
  const [fabricanteMode, setFabricanteMode] = useState<"existing" | "novo" | "manter">(
    "manter"
  );
  const [fabricanteId, setFabricanteId] = useState<string>(detail.produto.fabricanteId ?? "");
  const [fabricanteNovo, setFabricanteNovo] = useState<string>("");
  const [productType, setProductType] = useState<ProductType | "">(
    (detail.produto.productType as ProductType | null) ?? ""
  );
  const [nivel1Id, setNivel1Id] = useState<string>(
    detail.produto.classificacaoNivel1Id ?? ""
  );
  const [nivel2Id, setNivel2Id] = useState<string>(
    detail.produto.classificacaoNivel2Id ?? ""
  );
  const [validar, setValidar] = useState<boolean>(false);

  const nivel2Filtered = useMemo(
    () => classificacoes.nivel2.filter((n) => n.paiId === nivel1Id),
    [classificacoes.nivel2, nivel1Id]
  );

  // Se o N1 escolhido muda, e o N2 actual já não pertence, limpa N2.
  if (nivel2Id) {
    const stillValid = nivel2Filtered.some((n) => n.id === nivel2Id);
    if (!stillValid && nivel1Id !== detail.produto.classificacaoNivel1Id) {
      setNivel2Id("");
    }
  }

  function handleApply(closeReview: boolean) {
    setFlash(null);

    const input: ApplyReviewInput = {
      produtoId: detail.produto.id,
      revisaoId: closeReview && detail.revisao ? detail.revisao.id : undefined,
    };

    if (fabricanteMode === "existing") {
      input.fabricanteId = fabricanteId || null;
    } else if (fabricanteMode === "novo") {
      const v = fabricanteNovo.trim();
      if (!v) {
        setFlash({ type: "err", msg: "Indique o nome do novo fabricante." });
        return;
      }
      input.fabricanteNovo = v;
    }

    if (productType) input.productType = productType;
    if (nivel1Id !== detail.produto.classificacaoNivel1Id) {
      input.classificacaoNivel1Id = nivel1Id || null;
    }
    if (nivel2Id !== detail.produto.classificacaoNivel2Id) {
      input.classificacaoNivel2Id = nivel2Id || null;
    }
    if (validar) input.validar = true;

    startTransition(async () => {
      const r = await applyReviewAction(input);
      if (!r.ok) {
        setFlash({ type: "err", msg: r.error });
        return;
      }
      setFlash({
        type: "ok",
        msg: r.revisaoFechada
          ? "Aplicado e revisão fechada."
          : "Aplicado.",
      });
      router.refresh();
    });
  }

  function handleDismiss() {
    if (!detail.revisao) return;
    if (!confirm("Marcar esta revisão como ignorada (sem alterar o produto)?")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await dismissReviewAction({ revisaoId: detail.revisao!.id });
      if (!r.ok) {
        setFlash({ type: "err", msg: r.error });
        return;
      }
      setFlash({ type: "info", msg: "Revisão ignorada." });
      setTimeout(() => router.push("/admin/catalogo/revisao"), 600);
    });
  }

  return (
    <div className="space-y-6">
      <Link
        href="/admin/catalogo/revisao"
        className="inline-flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Lista de revisões
      </Link>

      {/* Header */}
      <section className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              CNP {detail.produto.cnp}
            </div>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">
              {detail.produto.designacao}
            </h1>
            {detail.produto.tipoArtigo && (
              <div className="mt-1 text-[12px] text-slate-500">
                tipoArtigo (fonte): {detail.produto.tipoArtigo}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {detail.produto.validadoManualmente && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <Lock className="h-3 w-3" />
                Validado manualmente
              </span>
            )}
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">
              {detail.produto.verificationStatus}
            </span>
          </div>
        </div>

        {/* Bandeiras regulamentares */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-600">
          {detail.produto.flagMSRM && <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-cyan-700">MSRM</span>}
          {detail.produto.flagMNSRM && <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-cyan-700">MNSRM</span>}
          {detail.produto.codigoATC && <span>ATC: <span className="font-mono">{detail.produto.codigoATC}</span></span>}
          {detail.produto.dci && <span>DCI: {detail.produto.dci}</span>}
          {detail.produto.formaFarmaceutica && <span>{detail.produto.formaFarmaceutica}</span>}
          {detail.produto.dosagem && <span>{detail.produto.dosagem}</span>}
          {detail.produto.embalagem && <span>{detail.produto.embalagem}</span>}
        </div>
      </section>

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : flash.type === "info"
                ? "border-cyan-200 bg-cyan-50 text-cyan-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* Classificação actual */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">
              Classificação actual
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Estado actual do produto, resultado do último pipeline de
              classificação. A proposta automática só é gravada se mapear para
              uma categoria comercial real.
            </p>
          </div>
          <dl className="grid gap-2 px-4 py-3 text-[13px]">
            <Field label="Tipo de produto">
              <span className="font-medium">{detail.produto.productType ?? "—"}</span>
              <span className="ml-2 text-[11px] text-slate-500">
                conf {fmtPct(detail.produto.productTypeConfidence)}
              </span>
            </Field>
            <Field label="Fabricante / laboratório">
              {detail.produto.fabricanteNome ?? (
                <span className="text-slate-400">— (sem fabricante)</span>
              )}
            </Field>
            <Field label="Categoria N1 / N2">
              {detail.produto.classificacaoNivel1Nome ? (
                <>
                  <span className="font-medium text-slate-900">
                    {detail.produto.classificacaoNivel1Nome}
                  </span>
                  {detail.produto.classificacaoNivel2Nome && (
                    <span className="text-slate-500">
                      {" · "}
                      {detail.produto.classificacaoNivel2Nome}
                    </span>
                  )}
                </>
              ) : (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  Sem classificação · precisa revisão
                </span>
              )}
            </Field>
            <Field label="Verificação">
              <span className="font-medium">{detail.produto.verificationStatus}</span>
              {detail.produto.needsManualReview && (
                <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                  needsManualReview
                </span>
              )}
              {detail.produto.validadoManualmente && (
                <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                  validado manualmente
                </span>
              )}
            </Field>
            <Field label="Origem da classificação">
              {detail.produto.classificationSource ?? "—"}
              {detail.produto.classificationVersion && (
                <span className="ml-2 text-[11px] text-slate-500">
                  v{detail.produto.classificationVersion}
                </span>
              )}
            </Field>
            <Field label="Última verificação">
              {fmtDate(detail.produto.lastVerifiedAt)}
              {detail.produto.externallyVerified && (
                <span className="ml-2 rounded bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700">
                  externa
                </span>
              )}
            </Field>
            {detail.produto.manualReviewReason && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                <strong>Motivo:</strong> {detail.produto.manualReviewReason}
              </div>
            )}
          </dl>

          {detail.revisao && detail.revisao.dadosOrigem != null && (
            <details className="border-t border-slate-100 px-4 py-3 text-[12px]">
              <summary className="cursor-pointer text-slate-600 hover:text-slate-900">
                Dados de origem da revisão (JSON)
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-slate-50 p-3 text-[11px] text-slate-700">
                {JSON.stringify(detail.revisao.dadosOrigem, null, 2)}
              </pre>
            </details>
          )}

          {detail.historico.length > 0 && (
            <div className="border-t border-slate-100 px-4 py-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Histórico recente
              </h3>
              <ul className="mt-2 space-y-1 text-[12px]">
                {detail.historico.slice(0, 5).map((h) => (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-slate-500">{fmtDate(h.verificadoEm)}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-medium text-slate-700">
                      {h.productType ?? "—"} ({fmtPct(h.productTypeConf)})
                    </span>
                    <span className="text-slate-500">{h.verificationStatus}</span>
                    {h.fieldsUpdated.length > 0 && (
                      <span className="text-slate-400">
                        [{h.fieldsUpdated.join(", ")}]
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Formulário de correcção */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">Correcção manual</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Tudo o que não passar é mantido. &ldquo;Validar&rdquo; bloqueia overrides automáticos.
            </p>
          </div>

          <div className="space-y-4 px-4 py-4 text-[13px]">
            {/* Fabricante */}
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Fabricante / laboratório
              </label>
              <div className="mb-2 flex flex-wrap gap-3 text-[12px]">
                <RadioOpt
                  name="fabMode"
                  value="manter"
                  checked={fabricanteMode === "manter"}
                  onChange={() => setFabricanteMode("manter")}
                  label="Manter actual"
                  disabled={busy}
                />
                <RadioOpt
                  name="fabMode"
                  value="existing"
                  checked={fabricanteMode === "existing"}
                  onChange={() => setFabricanteMode("existing")}
                  label="Escolher existente"
                  disabled={busy}
                />
                <RadioOpt
                  name="fabMode"
                  value="novo"
                  checked={fabricanteMode === "novo"}
                  onChange={() => setFabricanteMode("novo")}
                  label="Criar novo"
                  disabled={busy}
                />
              </div>

              {fabricanteMode === "existing" && (
                <select
                  value={fabricanteId}
                  onChange={(e) => setFabricanteId(e.target.value)}
                  disabled={busy}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                >
                  <option value="">— sem fabricante —</option>
                  {fabricantes.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.nome}
                    </option>
                  ))}
                </select>
              )}

              {fabricanteMode === "novo" && (
                <input
                  type="text"
                  value={fabricanteNovo}
                  onChange={(e) => setFabricanteNovo(e.target.value)}
                  placeholder="Ex: Bayer Portugal, Bial, Pfizer…"
                  disabled={busy}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                />
              )}
            </div>

            {/* productType */}
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Tipo de produto
              </label>
              <select
                value={productType}
                onChange={(e) => setProductType(e.target.value as ProductType | "")}
                disabled={busy}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
              >
                <option value="">— manter actual —</option>
                {PRODUCT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PRODUCT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>

            {/* Classificação N1 */}
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Categoria (Nível 1)
              </label>
              <select
                value={nivel1Id}
                onChange={(e) => {
                  setNivel1Id(e.target.value);
                  setNivel2Id("");
                }}
                disabled={busy}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
              >
                <option value="">— sem categoria —</option>
                {classificacoes.nivel1.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.nome}
                  </option>
                ))}
              </select>
            </div>

            {/* Classificação N2 */}
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Subcategoria (Nível 2)
              </label>
              <select
                value={nivel2Id}
                onChange={(e) => setNivel2Id(e.target.value)}
                disabled={busy || !nivel1Id}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
              >
                <option value="">
                  {nivel1Id ? "— sem subcategoria —" : "Escolha primeiro a categoria"}
                </option>
                {nivel2Filtered.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.nome}
                  </option>
                ))}
              </select>
            </div>

            {/* Validar */}
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={validar}
                  onChange={(e) => setValidar(e.target.checked)}
                  disabled={busy}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium text-slate-800">
                    Validar manualmente (bloquear overrides)
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-600">
                    Marca o produto como{" "}
                    <code className="rounded bg-white px-1 text-[10px]">
                      validadoManualmente=true
                    </code>{" "}
                    e <code className="rounded bg-white px-1 text-[10px]">origemDados=VALIDADO</code>.
                    O pipeline automático nunca mais altera os campos deste produto.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Acções */}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
            {detail.revisao && detail.revisao.estado === "PENDENTE" && (
              <button
                type="button"
                onClick={handleDismiss}
                disabled={busy}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Ignorar revisão
              </button>
            )}
            <button
              type="button"
              onClick={() => handleApply(false)}
              disabled={busy}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ? "A aplicar..." : "Aplicar (manter aberta)"}
            </button>
            <button
              type="button"
              onClick={() => handleApply(true)}
              disabled={busy || !detail.revisao}
              className="rounded-lg border border-cyan-500 bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50"
            >
              {busy ? "A aplicar..." : "Aplicar e fechar"}
            </button>
          </div>
        </section>
      </div>

      {/* Evidência por fonte */}
      <EvidenceSection evidence={evidence} produto={detail.produto} />
    </div>
  );
}

// ─── Evidência por fonte ─────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  SUCCESS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARTIAL_HIT: "border-amber-200 bg-amber-50 text-amber-700",
  NO_MATCH: "border-slate-200 bg-slate-50 text-slate-500",
  ERROR: "border-rose-200 bg-rose-50 text-rose-700",
};

function EvidenceSection({
  evidence,
  produto,
}: {
  evidence: ProductEvidenceEntry[];
  produto: ReviewDetail["produto"];
}) {
  // Resumo: a partir das entries SUCCESS/PARTIAL, indica que fonte alimentou
  // cada campo final (heurística — comparamos rawBrand com fabricanteNome
  // actual e rawCategory com classificacaoNivel1/Nivel2). Não é fonte de
  // verdade — é só uma pista para o admin perceber a proveniência.
  const finalProvenance = computeFinalProvenance(evidence, produto);

  const grouped = new Map<string, ProductEvidenceEntry[]>();
  for (const e of evidence) {
    const list = grouped.get(e.source) ?? [];
    list.push(e);
    grouped.set(e.source, list);
  }
  const sources = Array.from(grouped.keys()).sort();

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-[14px] font-semibold text-slate-900">Evidência por fonte</h2>
        <p className="mt-0.5 text-[12px] text-slate-500">
          Histórico de chamadas a conectores externos para este produto. Mostra o
          que cada fonte devolveu cru (antes de normalização) — útil para
          decidir manualmente.
        </p>
      </div>

      {/* Proveniência heurística do estado actual */}
      <div className="grid gap-2 border-b border-slate-100 px-4 py-3 text-[12px] md:grid-cols-3">
        <ProvField label="Tipo de produto" value={produto.productType ?? "—"} prov={finalProvenance.productType} />
        <ProvField label="Fabricante" value={produto.fabricanteNome ?? "—"} prov={finalProvenance.fabricante} />
        <ProvField
          label="Categoria"
          value={
            produto.classificacaoNivel1Nome
              ? `${produto.classificacaoNivel1Nome}${produto.classificacaoNivel2Nome ? " · " + produto.classificacaoNivel2Nome : ""}`
              : "—"
          }
          prov={finalProvenance.categoria}
        />
      </div>

      {evidence.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-slate-400">
          Sem chamadas registadas. Corre o enrichment para popular evidência.
        </div>
      ) : (
        <ul className="divide-y divide-slate-50">
          {sources.flatMap((source) =>
            grouped.get(source)!.map((e) => (
              <li key={e.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] font-medium text-slate-800">
                    {e.source}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                      STATUS_BADGE[e.status] ?? STATUS_BADGE.ERROR
                    }`}
                  >
                    {e.status.toLowerCase().replace("_", " ")}
                  </span>
                  {e.matchedBy && (
                    <span className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">
                      via {e.matchedBy}
                    </span>
                  )}
                  {e.confidence != null && (
                    <span className="text-[11px] text-slate-500">
                      conf {Math.round(e.confidence * 100)}%
                    </span>
                  )}
                  {e.durationMs != null && (
                    <span className="text-[11px] text-slate-400">{e.durationMs}ms</span>
                  )}
                  <span className="ml-auto text-[11px] text-slate-400">
                    {new Date(e.createdAt).toLocaleString("pt-PT", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                {(e.url || e.query || e.rawProductName || e.rawBrand || e.rawCategory) && (
                  <dl className="mt-2 grid gap-1 text-[11px] md:grid-cols-2">
                    {e.url && (
                      <RawField label="URL">
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all text-cyan-700 hover:underline"
                        >
                          {e.url}
                        </a>
                      </RawField>
                    )}
                    {e.query && <RawField label="Query"><code className="break-all">{e.query}</code></RawField>}
                    {e.rawProductName && <RawField label="Nome cru">{e.rawProductName}</RawField>}
                    {e.rawBrand && <RawField label="Marca crua"><strong>{e.rawBrand}</strong></RawField>}
                    {e.rawCategory && <RawField label="Categoria crua">{e.rawCategory}</RawField>}
                  </dl>
                )}

                {e.fieldsReturned.length > 0 && (
                  <div className="mt-1 text-[11px] text-slate-500">
                    Campos: {e.fieldsReturned.map((f) => (
                      <code key={f} className="ml-1 rounded bg-slate-50 px-1 text-[10px]">{f}</code>
                    ))}
                  </div>
                )}

                {e.errorMessage && (
                  <div className="mt-1 rounded-md border border-rose-100 bg-rose-50 px-2 py-1 font-mono text-[11px] text-rose-700">
                    {e.errorMessage}
                  </div>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  );
}

function ProvField({ label, value, prov }: { label: string; value: string; prov: string | null }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium text-slate-800">{value}</div>
      <div className="mt-0.5 text-[10px] text-slate-500">
        {prov ? <>via <span className="font-mono">{prov}</span></> : "origem indeterminada"}
      </div>
    </div>
  );
}

function RawField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-700">{children}</dd>
    </div>
  );
}

/**
 * Heurística de proveniência: para cada campo final (productType, fabricante,
 * categoria) procura na evidência uma fonte SUCCESS/PARTIAL_HIT cujo raw
 * corresponda ao valor actual no Produto. Não é fonte de verdade; serve só
 * para o admin perceber rapidamente "isto veio donde?".
 */
function computeFinalProvenance(
  evidence: ProductEvidenceEntry[],
  produto: ReviewDetail["produto"]
): { productType: string | null; fabricante: string | null; categoria: string | null } {
  // Validação manual sobrepõe-se à evidência.
  if (produto.validadoManualmente) {
    return { productType: "manual", fabricante: "manual", categoria: "manual" };
  }

  const successes = evidence.filter((e) => e.status === "SUCCESS" || e.status === "PARTIAL_HIT");

  // Helper case-insensitive comparison.
  const eq = (a: string | null, b: string | null): boolean => {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  };

  const productTypeSrc =
    successes.find((e) => e.fieldsReturned.includes("fabricante") || e.fieldsReturned.includes("atc"))
      ?.source ?? (produto.productType ? "classifier" : null);

  const fabricanteSrc = produto.fabricanteNome
    ? successes.find((e) => eq(e.rawBrand, produto.fabricanteNome))?.source ?? null
    : null;

  // Categoria pode vir do mapeamento canónico; tentar match por raw.
  const categoriaSrc = produto.classificacaoNivel1Nome
    ? successes.find(
        (e) =>
          eq(e.rawCategory, produto.classificacaoNivel1Nome) ||
          (e.rawCategory ?? "").toLowerCase().includes((produto.classificacaoNivel1Nome ?? "").toLowerCase())
      )?.source ?? "taxonomy_map"
    : null;

  return { productType: productTypeSrc, fabricante: fabricanteSrc, categoria: categoriaSrc };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 border-b border-slate-50 py-1.5 last:border-b-0">
      <dt className="text-[11px] uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function RadioOpt({
  name,
  value,
  checked,
  onChange,
  label,
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-slate-700">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span>{label}</span>
    </label>
  );
}
