"use client";

import { CreateInternalTransferButton } from "@/components/transferencias/create-internal-transfer-button";

type SameCnpItem = {
  produtoId: string;
  cnp: string;
  designacao: string;
  destinoFarmaciaId: string;
  destinoFarmaciaNome: string;
  destinoCoverage: number | null;
  sourceFarmaciaNome: string;
  sourceCoverage: number;
  transferableQty: number;
  avoidedPurchaseEstimate: number;
};

type DciItem = {
  destinoProdutoId: string;
  destinoCnp: string;
  destinoDesignacao: string;
  destinoFarmaciaId: string;
  destinoFarmaciaNome: string;
  destinoCoverage: number | null;
  sourceProdutoId: string;
  sourceCnp: string;
  sourceDesignacao: string;
  sourceFarmaciaNome: string;
  sourceCoverage: number;
  transferableQty: number;
  avoidedPurchaseEstimate: number;
  dci: string;
  dosagem: string;
  forma: string;
  atc5: string;
};

type IpfFresh = {
  healthy: boolean;
  ageHours: number | null;
  coverage: number;
  reasons: string[];
  totalRows: number;
};

type Props = {
  sameCnp: SameCnpItem[];
  dciEquivalent: DciItem[];
  ipfFreshness: IpfFresh | null;
};

function eur(n: number): string {
  return n.toLocaleString("pt-PT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function OportunidadesInbox({ sameCnp, dciEquivalent, ipfFreshness }: Props) {
  const totalAvoidedSame = sameCnp.reduce((s, x) => s + x.avoidedPurchaseEstimate, 0);
  const totalAvoidedDci = dciEquivalent.reduce((s, x) => s + x.avoidedPurchaseEstimate, 0);

  return (
    <div className="space-y-4">
      {/* KPIs compactos */}
      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-cyan-700/80">Same-CNP</div>
          <div className="mt-1 text-[22px] font-semibold text-cyan-800">{sameCnp.length}</div>
          <div className="text-[12px] text-cyan-700">{eur(totalAvoidedSame)} evitáveis</div>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-amber-700/80">DCI-equivalente (cautelar)</div>
          <div className="mt-1 text-[22px] font-semibold text-amber-800">{dciEquivalent.length}</div>
          <div className="text-[12px] text-amber-700">~{eur(totalAvoidedDci)} (a validar)</div>
        </div>
        <div
          className={[
            "rounded-2xl border px-4 py-3",
            ipfFreshness === null
              ? "border-slate-200 bg-slate-50"
              : ipfFreshness.healthy
                ? "border-emerald-200 bg-emerald-50"
                : "border-rose-200 bg-rose-50",
          ].join(" ")}
        >
          <div className="text-[11px] uppercase tracking-wider opacity-70">IPF read-model</div>
          <div className="mt-1 text-[22px] font-semibold">
            {ipfFreshness === null
              ? "—"
              : ipfFreshness.healthy
                ? "saudável"
                : "atenção"}
          </div>
          <div className="text-[12px] opacity-70">
            {ipfFreshness === null
              ? "indisponível"
              : `${ipfFreshness.totalRows.toLocaleString("pt-PT")} rows · ${(ipfFreshness.coverage * 100).toFixed(0)}% · ${ipfFreshness.ageHours === null ? "—" : `${ipfFreshness.ageHours.toFixed(1)}h`}`}
          </div>
          {ipfFreshness && !ipfFreshness.healthy && (
            <ul className="mt-1 ml-3 list-disc text-[11px] text-rose-800">
              {ipfFreshness.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Same-CNP feed */}
      <section className="rounded-2xl border border-cyan-200 bg-white">
        <div className="border-b border-cyan-100 px-4 py-2 text-[13px] font-semibold text-cyan-800">
          ↻ Same-CNP · rotura iminente + excesso interno
        </div>
        {sameCnp.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-slate-500">
            Sem oportunidades same-CNP detectadas.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sameCnp.map((s) => (
              <li
                key={`${s.produtoId}:${s.destinoFarmaciaId}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[12px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900">
                    {s.designacao}{" "}
                    <span className="font-mono text-[10px] text-slate-500">CNP {s.cnp}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Destino:{" "}
                    <span className="font-medium text-slate-700">{s.destinoFarmaciaNome}</span>{" "}
                    (cov{" "}
                    <span className="text-rose-600">
                      {s.destinoCoverage?.toFixed(0) ?? "—"}d
                    </span>
                    ) · Origem:{" "}
                    <span className="font-medium text-slate-700">{s.sourceFarmaciaNome}</span> (cov{" "}
                    {s.sourceCoverage.toFixed(0)}d)
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-semibold text-cyan-700">
                      {s.transferableQty} un.
                    </div>
                    <div className="text-[11px] text-cyan-600">
                      −{eur(s.avoidedPurchaseEstimate)}
                    </div>
                  </div>
                  <CreateInternalTransferButton
                    kind="same-cnp"
                    variant="cyan"
                    label="Criar transferência"
                    input={{
                      destinoFarmaciaId: s.destinoFarmaciaId,
                      sourceFarmaciaNome: s.sourceFarmaciaNome,
                      produtoId: s.produtoId,
                      cnp: s.cnp,
                      designacao: s.designacao,
                      quantidade: s.transferableQty,
                      kind: "same-cnp",
                      motivo: "rotura iminente · excesso interno",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* DCI-equivalent feed */}
      <section className="rounded-2xl border border-amber-200 bg-white">
        <div className="border-b border-amber-100 px-4 py-2 text-[13px] font-semibold text-amber-800">
          ⚠ DCI-equivalente · validar antes de transferir
        </div>
        {dciEquivalent.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-slate-500">
            Sem oportunidades DCI-equivalente detectadas.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {dciEquivalent.map((d) => (
              <li
                key={`${d.destinoProdutoId}:${d.destinoFarmaciaId}:${d.sourceProdutoId}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[12px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900">
                    {d.destinoDesignacao}{" "}
                    <span className="font-mono text-[10px] text-slate-500">
                      CNP {d.destinoCnp}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Destino:{" "}
                    <span className="font-medium text-slate-700">{d.destinoFarmaciaNome}</span>{" "}
                    (cov{" "}
                    <span className="text-rose-600">
                      {d.destinoCoverage?.toFixed(0) ?? "—"}d
                    </span>
                    )
                  </div>
                  <div className="mt-0.5 text-[11px] text-amber-800">
                    ↳ Equivalente:{" "}
                    <span className="font-medium">{d.sourceDesignacao}</span>{" "}
                    <span className="font-mono text-[10px] text-amber-700">
                      CNP {d.sourceCnp}
                    </span>{" "}
                    em <span className="font-medium">{d.sourceFarmaciaNome}</span>
                  </div>
                  <div className="text-[10px] text-amber-700/80">
                    {d.dci} · {d.dosagem} · {d.forma} · ATC {d.atc5}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-semibold text-amber-700">{d.transferableQty} un.</div>
                    <div className="text-[11px] text-amber-600">~{eur(d.avoidedPurchaseEstimate)}</div>
                  </div>
                  <CreateInternalTransferButton
                    kind="dci-equivalent"
                    variant="amber"
                    label="Criar transferência"
                    input={{
                      destinoFarmaciaId: d.destinoFarmaciaId,
                      sourceFarmaciaNome: d.sourceFarmaciaNome,
                      produtoId: d.sourceProdutoId,
                      cnp: d.sourceCnp,
                      designacao: d.sourceDesignacao,
                      quantidade: d.transferableQty,
                      kind: "dci-equivalent",
                      motivo: `${d.dci} ${d.dosagem} ${d.forma} · ATC ${d.atc5}`,
                      dciSourceProductName: d.sourceDesignacao,
                      dciSourceCnp: d.sourceCnp,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
