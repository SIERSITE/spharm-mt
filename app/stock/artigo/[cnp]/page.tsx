import Link from "next/link";
import { notFound } from "next/navigation";
import { MainShell } from "@/components/layout/main-shell";
import { ArtigoFicha } from "@/components/stock/artigo-ficha";
import { loadArtigoFicha } from "@/lib/stock/artigo-ficha-data";
import { ExtratoMovimentos } from "@/components/stock/extrato-movimentos";
import {
  getCoberturaMovimentos,
  getDefaultMovimentosWindow,
  getMovimentosProduto,
} from "@/lib/movimentos-data";
import { ArrowLeft } from "lucide-react";

type ArticlePageProps = {
  params: Promise<{ cnp: string }>;
};

/**
 * app/stock/artigo/[cnp]/page.tsx
 *
 * Página completa da ficha do artigo — acesso directo por URL continua
 * a mostrar esta página inteira (identidade, stock por farmácia E
 * extrato de movimentos), tal como sempre mostrou. A identidade+stock
 * agora vive em components/stock/artigo-ficha.tsx (lib/stock/
 * artigo-ficha-data.ts para os dados), reutilizada também pelo painel
 * lateral (components/stock/artigo-panel.tsx) — nunca duplicada.
 */
export default async function ArticlePage({ params }: ArticlePageProps) {
  const { cnp } = await params;
  const cnpNum = Number(cnp);
  const data = await loadArtigoFicha(cnpNum);
  if (!data) notFound();

  // Extrato de movimentos carregado server-side: o user já escolheu o
  // artigo, não faz sentido exigir um clique extra. O client component
  // recebe-o como initialRows e só volta ao server quando o user clica
  // "Atualizar" após mudar filtros.
  //
  // Decisão operacional: por defeito a ficha mostra apenas os ÚLTIMOS 30 DIAS,
  // e a mesma janela aplica-se a TODOS os tipos (vendas, compras, devoluções,
  // ajustes, inventário). Não se mistura histórico antigo por defeito — uma
  // receção de 2024 só aparece quando o utilizador alarga "Desde"/"Até".
  const { from: defaultFrom, to: defaultTo } = getDefaultMovimentosWindow();
  const [movimentosIniciais, cobertura] = await Promise.all([
    getMovimentosProduto(data.cnp, { from: defaultFrom, to: defaultTo }),
    getCoberturaMovimentos(),
  ]);

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

            <h1 className="mt-3 text-[20px] font-semibold text-slate-900">{data.designacao}</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              CNP {data.cnp} · {data.fabricante} · {data.principioAtivo} · {data.atc}
            </p>
          </div>

          <span className="rounded-full border border-cyan-100 bg-cyan-50 px-3 py-1 text-[11px] font-medium text-cyan-700">
            Ficha do artigo
          </span>
        </section>

        <ArtigoFicha data={data} />

        {/* Extrato de movimentos — carregado server-side; o botão
            "Atualizar" refresca em cima do dataset inicial. Não faz
            parte do painel lateral (Parte 4) — é o que "Manter como
            tarefa" abre esta página completa para ver. */}
        <ExtratoMovimentos
          cnp={data.cnp}
          farmacias={data.stockRows.map((r) => ({ id: r.farmaciaId, nome: r.farmaciaNome }))}
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
