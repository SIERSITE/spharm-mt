import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";

type ArticlePageProps = {
  params: Promise<{
    cnp: string;
  }>;
};

type CatalogArticle = {
  cnp: string;
  produto: string;
  fabricante: string;
  principioAtivo: string;
  atc: string;
  categoria: string;
  formaFarmaceutica: string;
  dosagem: string;
  embalagem: string;
  pvp: number;
  estado: "ativo" | "inativo";
  laboratorio: string;
  codigoBarras: string;
  tipoProduto: string;
  taxaIva: string;
  receitaMedica: boolean;
  generico: boolean;
  conservacao: string;
  observacoes: string;
};

const mockCatalogArticles: CatalogArticle[] = [
  {
    cnp: "5440987",
    produto: "BEN-U-RON COMP 1 G X 18",
    fabricante: "Bene",
    principioAtivo: "Paracetamol",
    atc: "N02BE01",
    categoria: "Analgésicos",
    formaFarmaceutica: "Comprimido",
    dosagem: "1 g",
    embalagem: "18 un.",
    pvp: 3.09,
    estado: "ativo",
    laboratorio: "Bene Farmacêutica",
    codigoBarras: "5601234567890",
    tipoProduto: "Medicamento não sujeito a receita médica",
    taxaIva: "6%",
    receitaMedica: false,
    generico: false,
    conservacao: "Temperatura ambiente",
    observacoes:
      "Artigo ativo no catálogo mestre. Informação comercial e classificativa disponível para normalização.",
  },
  {
    cnp: "2401180",
    produto: "Nebilet Comp 5 mg x 28",
    fabricante: "Menarini",
    principioAtivo: "Nebivolol",
    atc: "C07AB12",
    categoria: "Cardiovascular",
    formaFarmaceutica: "Comprimido",
    dosagem: "5 mg",
    embalagem: "28 un.",
    pvp: 11.7,
    estado: "ativo",
    laboratorio: "Menarini",
    codigoBarras: "5602234567891",
    tipoProduto: "Medicamento sujeito a receita médica",
    taxaIva: "6%",
    receitaMedica: true,
    generico: false,
    conservacao: "Temperatura ambiente",
    observacoes:
      "Artigo com enquadramento terapêutico cardiovascular e identificação normalizada no catálogo.",
  },
  {
    cnp: "5674239",
    produto: "Skudexa 75 mg + 25 mg x 20",
    fabricante: "Menarini",
    principioAtivo: "Dexketoprofeno + Tramadol",
    atc: "N02AJ14",
    categoria: "Analgésicos",
    formaFarmaceutica: "Comprimido revestido",
    dosagem: "75 mg + 25 mg",
    embalagem: "20 un.",
    pvp: 18.5,
    estado: "ativo",
    laboratorio: "Menarini",
    codigoBarras: "5603234567892",
    tipoProduto: "Medicamento sujeito a receita médica",
    taxaIva: "6%",
    receitaMedica: true,
    generico: false,
    conservacao: "Temperatura ambiente",
    observacoes:
      "Combinação analgésica classificada e estruturada para consulta mestre.",
  },
  {
    cnp: "1124509",
    produto: "Brufen 600 mg x 20",
    fabricante: "Abbott",
    principioAtivo: "Ibuprofeno",
    atc: "M01AE01",
    categoria: "Anti-inflamatórios",
    formaFarmaceutica: "Comprimido",
    dosagem: "600 mg",
    embalagem: "20 un.",
    pvp: 6.85,
    estado: "ativo",
    laboratorio: "Abbott",
    codigoBarras: "5604234567893",
    tipoProduto: "Medicamento sujeito a receita médica",
    taxaIva: "6%",
    receitaMedica: true,
    generico: false,
    conservacao: "Temperatura ambiente",
    observacoes:
      "Artigo farmacêutico com classificação ATC e apresentação comercial definidas.",
  },
  {
    cnp: "9988123",
    produto: "Zyrtec 10 mg x 20",
    fabricante: "UCB",
    principioAtivo: "Cetirizina",
    atc: "R06AE07",
    categoria: "Alergias",
    formaFarmaceutica: "Comprimido revestido",
    dosagem: "10 mg",
    embalagem: "20 un.",
    pvp: 8.4,
    estado: "ativo",
    laboratorio: "UCB",
    codigoBarras: "5605234567894",
    tipoProduto: "Medicamento não sujeito a receita médica",
    taxaIva: "6%",
    receitaMedica: false,
    generico: false,
    conservacao: "Temperatura ambiente",
    observacoes:
      "Artigo de alergias com atributos mestre completos para consulta.",
  },
  {
    cnp: "7788001",
    produto: "Daflon 500 mg x 60",
    fabricante: "Servier",
    principioAtivo: "Diosmina + Hesperidina",
    atc: "C05CA53",
    categoria: "Circulação",
    formaFarmaceutica: "Comprimido revestido",
    dosagem: "500 mg",
    embalagem: "60 un.",
    pvp: 14.9,
    estado: "inativo",
    laboratorio: "Servier",
    codigoBarras: "5606234567895",
    tipoProduto: "Medicamento não sujeito a receita médica",
    taxaIva: "6%",
    receitaMedica: false,
    generico: false,
    conservacao: "Temperatura ambiente",
    observacoes:
      "Artigo inativo no catálogo mestre, mantido para histórico e referência.",
  },
];

export default async function CatalogArticlePage({
  params,
}: ArticlePageProps) {
  const { cnp } = await params;

  const article =
    mockCatalogArticles.find((item) => item.cnp === cnp) ?? {
      cnp,
      produto: "Artigo não encontrado",
      fabricante: "—",
      principioAtivo: "—",
      atc: "—",
      categoria: "—",
      formaFarmaceutica: "—",
      dosagem: "—",
      embalagem: "—",
      pvp: 0,
      estado: "inativo" as const,
      laboratorio: "—",
      codigoBarras: "—",
      tipoProduto: "—",
      taxaIva: "—",
      receitaMedica: false,
      generico: false,
      conservacao: "—",
      observacoes:
        "Não foi possível localizar este artigo no mock atual do catálogo.",
    };

  return (
    <AppShell>
      <div className="space-y-4">
        <section className="space-y-2">
          <Link
            href="/catalogo"
            className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
          >
            Voltar ao catálogo
          </Link>

          <div className="rounded-[24px] border border-white/70 bg-white/84 px-5 py-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Ficha mestre do artigo
                </div>

                <div>
                  <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
                    {article.produto}
                  </h1>
                  <p className="mt-1 text-[13px] text-slate-600">
                    CNP {article.cnp} · {article.fabricante} · {article.categoria}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <StatusBadge estado={article.estado} />
                <FlagBadge
                  label={article.receitaMedica ? "Com receita" : "Sem receita"}
                  active={article.receitaMedica}
                />
                <FlagBadge
                  label={article.generico ? "Genérico" : "Não genérico"}
                  active={article.generico}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-4">
          <MetricCard label="PVP" value={formatMoney(article.pvp)} suffix="€" />
          <MetricCard label="ATC" value={article.atc} />
          <MetricCard label="Forma" value={article.formaFarmaceutica} />
          <MetricCard label="Dosagem" value={article.dosagem} />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <InfoCard
            title="Identificação"
            items={[
              { label: "CNP", value: article.cnp },
              { label: "Produto", value: article.produto },
              { label: "Fabricante", value: article.fabricante },
              { label: "Laboratório", value: article.laboratorio },
              { label: "Código de barras", value: article.codigoBarras },
              { label: "Estado", value: humanizeEstado(article.estado) },
            ]}
          />

          <InfoCard
            title="Classificação"
            items={[
              { label: "Princípio ativo", value: article.principioAtivo },
              { label: "ATC", value: article.atc },
              { label: "Categoria", value: article.categoria },
              { label: "Tipo de produto", value: article.tipoProduto },
              {
                label: "Receita médica",
                value: article.receitaMedica ? "Sim" : "Não",
              },
              { label: "Genérico", value: article.generico ? "Sim" : "Não" },
            ]}
          />

          <InfoCard
            title="Apresentação comercial"
            items={[
              { label: "Forma farmacêutica", value: article.formaFarmaceutica },
              { label: "Dosagem", value: article.dosagem },
              { label: "Embalagem", value: article.embalagem },
              { label: "PVP", value: `${formatMoney(article.pvp)} €` },
              { label: "IVA", value: article.taxaIva },
              { label: "Conservação", value: article.conservacao },
            ]}
          />

          <section className="rounded-[24px] border border-white/70 bg-white/84 p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
            <div className="border-b border-dashed border-slate-200 pb-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Observações de catálogo
              </h2>
              <p className="mt-1 text-[12px] text-slate-500">
                Enquadramento mestre e notas de normalização do artigo.
              </p>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-[13px] leading-6 text-slate-700">
                {article.observacoes}
              </p>
            </div>
          </section>
        </section>
      </div>
    </AppShell>
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
    <section className="rounded-[24px] border border-white/70 bg-white/84 p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div className="border-b border-dashed border-slate-200 pb-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      </div>

      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div
            key={`${title}-${item.label}`}
            className="flex items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3"
          >
            <div className="text-[12px] font-medium text-slate-500">
              {item.label}
            </div>
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
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/70 bg-white/84 px-5 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-slate-900">
        {value} {suffix ? <span className="text-base">{suffix}</span> : null}
      </div>
    </div>
  );
}

function StatusBadge({ estado }: { estado: "ativo" | "inativo" }) {
  const styles =
    estado === "ativo"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-semibold",
        styles,
      ].join(" ")}
    >
      {humanizeEstado(estado)}
    </span>
  );
}

function FlagBadge({
  label,
  active,
}: {
  label: string;
  active: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-semibold",
        active
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : "border-slate-200 bg-slate-50 text-slate-600",
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function formatMoney(value: number) {
  return value.toLocaleString("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function humanizeEstado(estado: "ativo" | "inativo") {
  return estado === "ativo" ? "Ativo" : "Inativo";
}