import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import {
  ArrowLeft,
  ArrowRightLeft,
  Package,
  Activity,
  Truck,
  Tag,
  Building2,
  Image as ImageIcon,
  Pill,
  Stethoscope,
} from "lucide-react";

type ArticlePageProps = {
  params: Promise<{
    cnp: string;
  }>;
};

function SmallMetric({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-semibold leading-tight text-slate-900">
        {value}
      </div>
      <div className="mt-1 text-[10px] text-slate-500">{helper}</div>
    </div>
  );
}

function PharmacyStockRow({
  pharmacy,
  stock,
  coverage,
  rotation,
  status,
}: {
  pharmacy: string;
  stock: string;
  coverage: string;
  rotation: string;
  status: string;
}) {
  return (
    <div className="grid grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_1fr] gap-4 border-b border-slate-100 py-3 text-[12px] text-slate-600 last:border-b-0">
      <div className="font-medium text-slate-800">{pharmacy}</div>
      <div>{stock}</div>
      <div>{coverage}</div>
      <div>{rotation}</div>
      <div>{status}</div>
    </div>
  );
}

function ProductIdentityCard() {
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-4 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="grid gap-5 lg:grid-cols-[180px_1fr]">
        <div className="flex items-center justify-center rounded-[14px] border border-slate-100 bg-slate-50/80 p-4">
          <div className="flex h-full min-h-[180px] w-full flex-col items-center justify-center rounded-[12px] border border-dashed border-slate-200 bg-white text-center">
            <ImageIcon className="h-8 w-8 text-slate-300" />
            <div className="mt-3 text-[12px] font-medium text-slate-500">
              Imagem do artigo
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              Substituir por foto real do produto
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Identificação
            </div>
            <h2 className="mt-1 text-[18px] font-semibold text-slate-900">
              Brufen 600 mg comp.
            </h2>
            <p className="mt-1 text-[12px] text-slate-500">
              Anti-inflamatório não esteroide em comprimidos revestidos
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-5">
            <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <Tag className="h-4 w-4 text-emerald-600" />
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Categoria
                </div>
              </div>
              <div className="text-[13px] font-medium text-slate-800">
                Analgésicos e anti-inflamatórios
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-cyan-600" />
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Fabricante
                </div>
              </div>
              <div className="text-[13px] font-medium text-slate-800">
                Viatris
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <Pill className="h-4 w-4 text-violet-600" />
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Princípio ativo
                </div>
              </div>
              <div className="text-[13px] font-medium text-slate-800">
                Ibuprofeno
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <Stethoscope className="h-4 w-4 text-rose-600" />
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  ATC / Terapêutica
                </div>
              </div>
              <div className="text-[13px] font-medium text-slate-800">
                M01AE01 · Anti-inflamatórios
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <Package className="h-4 w-4 text-amber-600" />
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Forma
                </div>
              </div>
              <div className="text-[13px] font-medium text-slate-800">
                Comprimidos
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-7">
            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                CNP
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                1234567
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                Fabricante
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                Viatris
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                Princípio ativo
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                Ibuprofeno
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                ATC
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                M01AE01
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                Dosagem
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                600 mg
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                Embalagem
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                20 un.
              </div>
            </div>

            <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                PVP
              </div>
              <div className="mt-1 text-[13px] font-medium text-slate-800">
                6,85 €
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { cnp } = await params;

  return (
    <AppShell>
      <div className="space-y-5">
        <section className="flex items-center justify-between gap-4">
          <div>
            <Link
              href="/stock"
              className="inline-flex items-center gap-2 text-[12px] font-medium text-slate-500 transition hover:text-slate-700"
            >
              <ArrowLeft className="h-4 w-4" />
              Voltar a Stock
            </Link>

            <h1 className="mt-3 text-[20px] font-semibold text-slate-900">
              Brufen 600 mg comp.
            </h1>
            <p className="mt-1 text-[12px] text-slate-500">
              CNP {cnp} · Fabricante Viatris · Ibuprofeno · M01AE01 · Grupo em análise
            </p>
          </div>

          <span className="rounded-full border border-cyan-100 bg-cyan-50 px-3 py-1 text-[11px] font-medium text-cyan-700">
            Ficha do artigo
          </span>
        </section>

        <ProductIdentityCard />

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SmallMetric
            label="Stock total"
            value="50 un."
            helper="Soma das farmácias"
          />
          <SmallMetric
            label="Cobertura média"
            value="7,5 dias"
            helper="Leitura consolidada"
          />
          <SmallMetric
            label="Rotação"
            value="Alta"
            helper="Procura consistente"
          />
          <SmallMetric
            label="Transferências"
            value="1 sugestão"
            helper="Entre farmácias"
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.3fr_0.9fr]">
          <div className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <div className="mb-3 flex items-center gap-2">
              <Package className="h-4 w-4 text-emerald-600" />
              <h2 className="text-[14px] font-semibold text-slate-900">
                Stock por farmácia
              </h2>
            </div>

            <div className="grid grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_1fr] gap-4 border-b border-slate-100 pb-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
              <div>Farmácia</div>
              <div>Stock</div>
              <div>Cobertura</div>
              <div>Rotação</div>
              <div>Estado</div>
            </div>

            <div>
              <PharmacyStockRow
                pharmacy="Farmácia A"
                stock="42 un."
                coverage="12 dias"
                rotation="Alta"
                status="Estável"
              />
              <PharmacyStockRow
                pharmacy="Farmácia B"
                stock="8 un."
                coverage="3 dias"
                rotation="Alta"
                status="Baixa cobertura"
              />
            </div>
          </div>

          <div className="space-y-5">
            <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
              <div className="mb-3 flex items-center gap-2">
                <ArrowRightLeft className="h-4 w-4 text-cyan-600" />
                <h2 className="text-[14px] font-semibold text-slate-900">
                  Transferência sugerida
                </h2>
              </div>

              <div className="rounded-[14px] border border-cyan-100 bg-cyan-50/70 px-3 py-3">
                <div className="text-[12px] font-medium text-slate-800">
                  Transferir 8 unidades
                </div>
                <div className="mt-1 text-[11px] text-slate-600">
                  Farmácia A → Farmácia B
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  Diferença de cobertura e procura justificam redistribuição.
                </div>
              </div>
            </section>

            <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
              <div className="mb-3 flex items-center gap-2">
                <Activity className="h-4 w-4 text-emerald-600" />
                <h2 className="text-[14px] font-semibold text-slate-900">
                  Comportamento recente
                </h2>
              </div>

              <div className="space-y-2 text-[12px] text-slate-600">
                <div className="flex items-center justify-between">
                  <span>Último movimento</span>
                  <span className="font-medium text-slate-800">Hoje</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Última venda</span>
                  <span className="font-medium text-slate-800">Hoje</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Tendência</span>
                  <span className="font-medium text-slate-800">
                    Procura estável
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
              <div className="mb-3 flex items-center gap-2">
                <Truck className="h-4 w-4 text-amber-600" />
                <h2 className="text-[14px] font-semibold text-slate-900">
                  Aprovisionamento
                </h2>
              </div>

              <div className="space-y-2 text-[12px] text-slate-600">
                <div className="flex items-center justify-between">
                  <span>Fornecedor principal</span>
                  <span className="font-medium text-slate-800">Plural</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Fabricante</span>
                  <span className="font-medium text-slate-800">Viatris</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Princípio ativo</span>
                  <span className="font-medium text-slate-800">Ibuprofeno</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>ATC</span>
                  <span className="font-medium text-slate-800">M01AE01</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Encomenda pendente</span>
                  <span className="font-medium text-slate-800">Não</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Estado atual</span>
                  <span className="font-medium text-slate-800">Regular</span>
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>
    </AppShell>
  );
}