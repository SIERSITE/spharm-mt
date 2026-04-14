import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getPrisma } from "@/lib/prisma";
import { resolveCategoria } from "@/lib/categoria-resolver";
import { ExtratoMovimentos } from "@/components/stock/extrato-movimentos";
import { getMovimentosProduto, getTiposDisponiveis } from "@/lib/movimentos-data";
import {
  ArrowLeft,
  Package,
  Tag,
  Building2,
  Image as ImageIcon,
  Pill,
  Stethoscope,
} from "lucide-react";

type ArticlePageProps = {
  params: Promise<{ cnp: string }>;
};

const PLACEHOLDER = "—";

function fmt(value: string | null | undefined): string {
  const s = (value ?? "").trim();
  return s.length > 0 ? s : PLACEHOLDER;
}

function fmtNumber(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return `${value.toLocaleString("pt-PT")}${suffix}`;
}

function fmtCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function fmtDate(value: Date | null | undefined): string {
  if (!value) return PLACEHOLDER;
  return new Date(value).toLocaleDateString("pt-PT");
}

async function loadArticle(cnpParam: string) {
  const cnp = Number(cnpParam);
  if (!Number.isFinite(cnp) || cnp <= 0) return null;

  const prisma = await getPrisma();
  const produto = await prisma.produto.findUnique({
    where: { cnp },
    include: {
      fabricante: { select: { nomeNormalizado: true } },
      classificacaoNivel1: { select: { nome: true } },
      classificacaoNivel2: { select: { nome: true } },
      produtosFarmacia: {
        where: { flagRetirado: false },
        include: {
          farmacia: { select: { id: true, nome: true, estado: true } },
        },
        // categoriaOrigem/subcategoriaOrigem já vêm por defeito no findMany
        // quando não há select; include adiciona apenas a relação farmacia.
      },
    },
  });

  return produto;
}

function SmallMetric({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-tight text-slate-900">{value}</div>
      <div className="mt-1 text-[10px] text-slate-500">{helper}</div>
    </div>
  );
}

function IdentityField({
  icon,
  label,
  value,
  iconClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  iconClass: string;
}) {
  return (
    <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={iconClass}>{icon}</span>
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {label}
        </div>
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

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { cnp } = await params;
  const produto = await loadArticle(cnp);
  if (!produto) notFound();

  // Extrato de movimentos carregado server-side: o user já escolheu o
  // artigo, não faz sentido exigir um clique extra. O client component
  // recebe-o como initialRows e só volta ao server quando o user clica
  // "Atualizar" após mudar filtros.
  const movimentosIniciais = await getMovimentosProduto(produto.cnp);

  const fabricante = fmt(produto.fabricante?.nomeNormalizado);
  const principioAtivo = fmt(produto.dci);
  const atc = fmt(produto.codigoATC);
  const forma = fmt(produto.formaFarmaceutica);
  const dosagem = fmt(produto.dosagem);
  const embalagem = fmt(produto.embalagem);
  // Categoria/subcategoria via resolver canónico partilhado. Mostramos
  // AMBOS os níveis explicitamente — antes a ficha só mostrava o nível
  // mais específico, o que criava inconsistência com Vendas (que
  // filtra pelo pai). Regra agora:
  //   · Categoria    = nível pai     (Sexualidade)
  //   · Subcategoria = nível filho   (Preservativos)
  // Se só houver um dos dois, o outro aparece como —.
  const pfWithCategoria = produto.produtosFarmacia.find(
    (pf) => (pf.categoriaOrigem ?? "").trim() || (pf.subcategoriaOrigem ?? "").trim()
  );
  const resolvedCat = resolveCategoria({
    classificacaoNivel1: produto.classificacaoNivel1,
    classificacaoNivel2: produto.classificacaoNivel2,
    categoriaOrigem: pfWithCategoria?.categoriaOrigem,
    subcategoriaOrigem: pfWithCategoria?.subcategoriaOrigem,
  });
  const categoria = fmt(resolvedCat.categoria);
  const subcategoria = fmt(
    resolvedCat.grupo && resolvedCat.grupo !== resolvedCat.categoria
      ? resolvedCat.grupo
      : null
  );

  // PVP: usa o primeiro PF com pvp definido (mesmo critério do importer);
  // se quiseres "PVP da farmácia activa", troca quando houver sessão.
  const pfsActive = produto.produtosFarmacia.filter(
    (pf) => pf.farmacia.estado === "ATIVO" && pf.farmacia.nome !== "Farmácia Teste"
  );
  const pvpRow = pfsActive.find((pf) => pf.pvp !== null);
  const pvp = pvpRow?.pvp ? Number(pvpRow.pvp) : null;

  const stockRows = pfsActive
    .map((pf) => ({
      farmaciaId: pf.farmacia.id,
      farmaciaNome: pf.farmacia.nome,
      stock: pf.stockAtual !== null ? Number(pf.stockAtual) : null,
      ultimaVenda: pf.dataUltimaVenda,
      ultimaCompra: pf.dataUltimaCompra,
      validadeMaisAntiga: pf.validadeMaisAntiga,
      stockMinimo: pf.stockMinimo !== null ? Number(pf.stockMinimo) : null,
    }))
    .sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0));

  const stockTotal = stockRows.reduce((s, r) => s + (r.stock ?? 0), 0);
  const farmaciasComStock = stockRows.filter((r) => (r.stock ?? 0) > 0).length;
  const ultimaVenda = stockRows
    .map((r) => r.ultimaVenda)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

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

            <h1 className="mt-3 text-[20px] font-semibold text-slate-900">{produto.designacao}</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              CNP {produto.cnp} · {fabricante} · {principioAtivo} · {atc}
            </p>
          </div>

          <span className="rounded-full border border-cyan-100 bg-cyan-50 px-3 py-1 text-[11px] font-medium text-cyan-700">
            Ficha do artigo
          </span>
        </section>

        {/* Identidade */}
        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-4 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid gap-5 lg:grid-cols-[180px_1fr]">
            <div className="flex items-center justify-center rounded-[14px] border border-slate-100 bg-slate-50/80 p-4">
              {produto.imagemUrl ? (
                <Image
                  src={produto.imagemUrl}
                  alt={produto.designacao}
                  width={160}
                  height={180}
                  className="h-auto max-h-[180px] w-auto object-contain"
                  unoptimized
                />
              ) : (
                <div className="flex h-full min-h-[180px] w-full flex-col items-center justify-center rounded-[12px] border border-dashed border-slate-200 bg-white text-center">
                  <ImageIcon className="h-8 w-8 text-slate-300" />
                  <div className="mt-3 text-[12px] font-medium text-slate-500">Sem imagem</div>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Identificação
                </div>
                <h2 className="mt-1 text-[18px] font-semibold text-slate-900">
                  {produto.designacao}
                </h2>
                {(resolvedCat.categoria || resolvedCat.grupo) && (
                  <p className="mt-1 text-[12px] text-slate-500">
                    {resolvedCat.categoria}
                    {resolvedCat.grupo && resolvedCat.grupo !== resolvedCat.categoria
                      ? ` · ${resolvedCat.grupo}`
                      : ""}
                  </p>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-5">
                <IdentityField
                  icon={<Tag className="h-4 w-4" />}
                  iconClass="text-emerald-600"
                  label="Categoria"
                  value={categoria}
                />
                <IdentityField
                  icon={<Building2 className="h-4 w-4" />}
                  iconClass="text-cyan-600"
                  label="Fabricante"
                  value={fabricante}
                />
                <IdentityField
                  icon={<Pill className="h-4 w-4" />}
                  iconClass="text-violet-600"
                  label="Princípio ativo"
                  value={principioAtivo}
                />
                <IdentityField
                  icon={<Stethoscope className="h-4 w-4" />}
                  iconClass="text-rose-600"
                  label="ATC"
                  value={atc}
                />
                <IdentityField
                  icon={<Package className="h-4 w-4" />}
                  iconClass="text-amber-600"
                  label="Forma"
                  value={forma}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-6">
                <MetaCell label="CNP" value={String(produto.cnp)} />
                <MetaCell label="Subcategoria" value={subcategoria} />
                <MetaCell label="Dosagem" value={dosagem} />
                <MetaCell label="Embalagem" value={embalagem} />
                <MetaCell label="PVP" value={fmtCurrency(pvp)} />
                <MetaCell
                  label="Genérico"
                  value={produto.flagGenerico ? "Sim" : produto.flagGenerico === false ? "Não" : PLACEHOLDER}
                />
              </div>
            </div>
          </div>
        </section>

        {/* Métricas agregadas reais */}
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SmallMetric
            label="Stock total"
            value={fmtNumber(stockTotal, " un.")}
            helper={`${farmaciasComStock} farmácia(s) com stock`}
          />
          <SmallMetric
            label="Farmácias"
            value={fmtNumber(stockRows.length)}
            helper="Activas com este artigo"
          />
          <SmallMetric
            label="Última venda"
            value={fmtDate(ultimaVenda)}
            helper="Mais recente entre farmácias"
          />
          <SmallMetric
            label="PVP de referência"
            value={fmtCurrency(pvp)}
            helper={pvpRow ? `via ${pvpRow.farmacia.nome}` : "sem registo"}
          />
        </section>

        {/* Stock por farmácia (real) */}
        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="mb-3 flex items-center gap-2">
            <Package className="h-4 w-4 text-emerald-600" />
            <h2 className="text-[14px] font-semibold text-slate-900">Stock por farmácia</h2>
          </div>

          {stockRows.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-slate-500">
              Sem registos de ProdutoFarmacia para este artigo.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.9fr_0.9fr] gap-4 border-b border-slate-100 pb-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                <div>Farmácia</div>
                <div>Stock</div>
                <div>Mínimo</div>
                <div>Última venda</div>
                <div>Validade + antiga</div>
              </div>
              {stockRows.map((row) => (
                <div
                  key={row.farmaciaId}
                  className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.9fr_0.9fr] gap-4 border-b border-slate-100 py-3 text-[12px] text-slate-600 last:border-b-0"
                >
                  <div className="font-medium text-slate-800">{row.farmaciaNome}</div>
                  <div>{fmtNumber(row.stock, " un.")}</div>
                  <div>{fmtNumber(row.stockMinimo)}</div>
                  <div>{fmtDate(row.ultimaVenda)}</div>
                  <div>{fmtDate(row.validadeMaisAntiga)}</div>
                </div>
              ))}
            </>
          )}
        </section>

        {/* Extrato de movimentos — carregado server-side; o botão
            "Atualizar" refresca em cima do dataset inicial. */}
        <ExtratoMovimentos
          cnp={produto.cnp}
          farmacias={pfsActive
            .map((pf) => ({ id: pf.farmacia.id, nome: pf.farmacia.nome }))
            .filter(
              (v, i, a) => a.findIndex((x) => x.id === v.id) === i
            )}
          tiposDisponiveis={getTiposDisponiveis()}
          initialRows={movimentosIniciais}
        />

        {/*
          Blocos dependentes de lógica futura — intencionalmente removidos
          desta passagem (não há ainda cálculo real):
            · Cobertura / dias de stock por farmácia
            · Rotação / tendência
            · Transferência sugerida (precisa do motor de balanceamento)
            · Aprovisionamento / encomenda pendente

          Quando essas pipelines existirem, reactivar aqui consumindo os
          módulos correspondentes — não voltar a hardcoded.
        */}
      </div>
    </AppShell>
  );
}
