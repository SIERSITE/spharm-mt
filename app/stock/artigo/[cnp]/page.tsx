import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MainShell } from "@/components/layout/main-shell";
import { getPrisma } from "@/lib/prisma";
import { resolveCategoria, resolverPar } from "@/lib/categoria-resolver";
import {
  calcularPvpReferencia,
  descreverPvpReferencia,
  desvioFaceAReferencia,
} from "@/lib/pvp-referencia";
import {
  calcularPrecoReferencia,
  descreverPrecoReferencia,
} from "@/lib/produtos/preco-referencia";
import {
  custoDaFarmacia,
  descreverFonteCusto,
} from "@/lib/produtos/custo-farmacia";
import { rotuloProductType } from "@/lib/catalog/product-type-labels";
import { ExtratoMovimentos } from "@/components/stock/extrato-movimentos";
import {
  getCoberturaMovimentos,
  getDefaultMovimentosWindow,
  getMovimentosProduto,
} from "@/lib/movimentos-data";
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

/**
 * O desvio face à referência, com sinal explícito.
 *
 * Sinal sempre visível — sem ele, "0,24" e "-0,24" distinguem-se por um
 * caracter fácil de perder numa coluna estreita. O menos é U+2212, que
 * tem a largura de um dígito nas fontes tabulares; o hífen não tem, e
 * desalinha a coluna.
 */
function fmtDelta(delta: number): string {
  const abs = Math.abs(delta).toLocaleString("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${delta > 0 ? "+" : "\u2212"}${abs}`;
}

/**
 * Uma definição só das colunas: o cabeçalho e as linhas têm de andar
 * juntos, e duas listas de larguras acabam por divergir na primeira vez
 * que alguém acrescenta uma coluna a uma delas.
 */
const COLUNAS_STOCK =
  "grid-cols-[1.2fr_0.85fr_0.85fr_0.55fr_0.55fr_0.8fr_0.8fr]";

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
      utilizacoes: {
        select: { utilizacao: { select: { nome: true, estado: true } } },
      },
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
  //
  // Decisão operacional: por defeito a ficha mostra apenas os ÚLTIMOS 30 DIAS,
  // e a mesma janela aplica-se a TODOS os tipos (vendas, compras, devoluções,
  // ajustes, inventário). Não se mistura histórico antigo por defeito — uma
  // receção de 2024 só aparece quando o utilizador alarga "Desde"/"Até".
  // A janela é calculada por um helper do loader (fonte única) e passada quer
  // ao loader quer ao componente, para os inputs reflectirem exactamente o que
  // está a ser mostrado.
  const { from: defaultFrom, to: defaultTo } = getDefaultMovimentosWindow();
  // Cobertura por pipeline foi MOVIDA para /admin/pipeline — não pertence
  // à ficha operacional do artigo. A ficha é per-produto; freshness é
  // tenant-wide e só faz sentido na área técnica/admin.
  // A cobertura vem com o extrato porque uma tabela vazia tem duas
  // leituras — "este artigo não se mexeu" e "esta farmácia não tem
  // ledger ingerido" — e só uma delas é uma resposta.
  const [movimentosIniciais, cobertura] = await Promise.all([
    getMovimentosProduto(produto.cnp, { from: defaultFrom, to: defaultTo }),
    getCoberturaMovimentos(),
  ]);

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
  const resolvedCat = resolveCategoria({
    classificacaoNivel1: produto.classificacaoNivel1,
    classificacaoNivel2: produto.classificacaoNivel2,
  });
  const par = resolverPar({
    classificacaoNivel1: produto.classificacaoNivel1,
    classificacaoNivel2: produto.classificacaoNivel2,
  });
  const categoria = fmt(par.categoria);
  const subcategoria = fmt(par.subcategoria || null);
  const tipoProduto = rotuloProductType(produto.productType, PLACEHOLDER);
  // Utilizações clínicas. Escritas pelo enriquecimento e, até aqui, sem
  // leitura nenhuma na aplicação.
  const utilizacoes =
    produto.utilizacoes
      .filter((u) => u.utilizacao.estado === "ATIVO")
      .map((u) => u.utilizacao.nome)
      .sort((a, b) => a.localeCompare(b, "pt-PT"))
      .join(" · ") || PLACEHOLDER;

  const pfsActive = produto.produtosFarmacia.filter(
    (pf) => pf.farmacia.estado === "ATIVO" && pf.farmacia.nome !== "Farmácia Teste"
  );

  // O PVP de cada farmácia é `ProdutoFarmacia.pvp`: o
  // `Stocks.[Preco Venda Publico_EUR]` do ERP dessa farmácia, reescrito
  // em cada corrida diária. Não é o preço de uma venda — esse vive em
  // `IngestVendaLinhaRaw.pvpUnitario` e não é lido aqui.
  const precos = pfsActive.map((pf) => ({
    pvp: pf.pvp !== null ? Number(pf.pvp) : null,
  }));
  // A referência era "o primeiro PF com preço", numa consulta sem
  // `orderBy` — instável entre carregamentos. Ver `lib/pvp-referencia.ts`.
  const referencia = calcularPvpReferencia(precos);
  const pvp = referencia.valor;

  // O CUSTO de cada farmácia: `ProdutoFarmacia.pmc`, com `.puc` quando o
  // médio não existe. A regra é a de `lib/produtos/custo-farmacia.ts`, a
  // mesma do Inventário e dos Excessos — e é lá que está escrito porque
  // um zero não conta como custo.
  //
  // A referência usa o MESMO motor do PVP. O custo de um artigo não é
  // igual em todas as farmácias por regra nenhuma: cada uma compra ao
  // seu grossista, nas suas condições. É precisamente por isso que a
  // pergunta «quem destoa» faz aqui mais sentido do que no PVP, onde a
  // margem legal já aperta a dispersão.
  const custosPorFarmacia = pfsActive.map((pf) =>
    custoDaFarmacia(
      pf.pmc !== null ? Number(pf.pmc) : null,
      pf.puc !== null ? Number(pf.puc) : null,
    ),
  );
  const custoReferencia = calcularPrecoReferencia(custosPorFarmacia.map((c) => c.valor));

  const stockRows = pfsActive
    .map((pf) => ({
      farmaciaId: pf.farmacia.id,
      farmaciaNome: pf.farmacia.nome,
      stock: pf.stockAtual !== null ? Number(pf.stockAtual) : null,
      pvp: pf.pvp !== null ? Number(pf.pvp) : null,
      ...(() => {
        const c = custoDaFarmacia(
          pf.pmc !== null ? Number(pf.pmc) : null,
          pf.puc !== null ? Number(pf.puc) : null,
        );
        return { custo: c.valor, fonteCusto: c.fonte };
      })(),
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
    <MainShell>
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
                <MetaCell label="Tipo de produto" value={tipoProduto} />
                <MetaCell label="Dosagem" value={dosagem} />
                <MetaCell label="Embalagem" value={embalagem} />
                <MetaCell label="PVP" value={fmtCurrency(pvp)} />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <MetaCell label="Utilizações" value={utilizacoes} />
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
            helper={descreverPvpReferencia(referencia)}
          />
          {/* O custo ao lado do PVP e com o mesmo tratamento: é a
              pergunta económica que faltava à ficha, e quem a faz tem o
              PVP à frente dos olhos na mesma linha. */}
          <SmallMetric
            label="Custo de referência"
            value={fmtCurrency(custoReferencia.valor)}
            helper={descreverPrecoReferencia(custoReferencia, "pago")}
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
              <div className={`grid ${COLUNAS_STOCK} gap-4 border-b border-slate-100 pb-2 text-[10px] uppercase tracking-[0.14em] text-slate-400`}>
                <div>Farmácia</div>
                <div className="text-right">PVP</div>
                <div className="text-right">Custo</div>
                <div>Stock</div>
                <div>Mínimo</div>
                <div>Última venda</div>
                <div>Validade + antiga</div>
              </div>
              {stockRows.map((row) => {
                // Só há desvio a mostrar quando o preço difere mesmo. Um
                // "+0,00" em todas as linhas seria ruído a fingir sinal.
                const desvio = desvioFaceAReferencia(row.pvp, referencia.valor);
                const desvioCusto = desvioFaceAReferencia(row.custo, custoReferencia.valor);
                return (
                  <div
                    key={row.farmaciaId}
                    className={`grid ${COLUNAS_STOCK} gap-4 border-b border-slate-100 py-3 text-[12px] text-slate-600 last:border-b-0`}
                  >
                    <div className="font-medium text-slate-800">{row.farmaciaNome}</div>
                    <div className="text-right tabular-nums">
                      <span className={desvio !== null ? "text-slate-800" : undefined}>
                        {fmtCurrency(row.pvp)}
                      </span>
                      {desvio !== null && (
                        <span
                          className="ml-1.5 text-[10px] font-medium tabular-nums text-amber-700"
                          title={`Difere do PVP de referência (${fmtCurrency(referencia.valor)})`}
                        >
                          {fmtDelta(desvio)}
                        </span>
                      )}
                    </div>
                    {/* Mesmo tratamento do PVP: o desvio só aparece
                        quando há diferença real face à referência. */}
                    <div
                      className="text-right tabular-nums"
                      title={descreverFonteCusto(row.fonteCusto)}
                    >
                      <span className="text-slate-800">{fmtCurrency(row.custo)}</span>
                      {row.fonteCusto === "PUC" && (
                        // Um custo vindo da última compra não é o mesmo
                        // dado que um preço médio, e a coluna não pode
                        // fingir que é. O asterisco é o aviso mínimo.
                        <span className="ml-0.5 text-[10px] text-slate-400">*</span>
                      )}
                      {desvioCusto !== null && (
                        <span
                          className="ml-1.5 text-[10px] font-medium tabular-nums text-amber-700"
                          title={`Difere do custo de referência (${fmtCurrency(custoReferencia.valor)})`}
                        >
                          {fmtDelta(desvioCusto)}
                        </span>
                      )}
                    </div>
                    <div>{fmtNumber(row.stock, " un.")}</div>
                    <div>{fmtNumber(row.stockMinimo)}</div>
                    <div>{fmtDate(row.ultimaVenda)}</div>
                    <div>{fmtDate(row.validadeMaisAntiga)}</div>
                  </div>
                );
              })}
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
          initialRows={movimentosIniciais}
          defaultFrom={defaultFrom}
          defaultTo={defaultTo}
          cobertura={cobertura}
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
    </MainShell>
  );
}
