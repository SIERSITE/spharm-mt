/**
 * app/produtos/criar/page.tsx
 *
 * Criação de ficha de produto a partir de Stocks.
 *
 * É o mesmo `CriarProdutoForm` que o ProductPicker abre em modal — o que
 * muda é o invólucro (página vs. modal) e o que acontece a seguir.
 *
 * ── Para onde navega, e porque NÃO é /stock ──────────────────────────
 *
 * `/stock` parte de `ProdutoFarmacia`. Uma ficha acabada de criar não
 * tem nenhuma, portanto voltar para lá mostrava uma lista onde o produto
 * não está — o utilizador criava algo e via o nada.
 *
 * `/catalogo/artigo/[cnp]` parte de `Produto` e mostra a ficha. É o
 * único sítio onde o resultado do que ele acabou de fazer é visível.
 */
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { requirePermission } from "@/lib/permissions";
import { CriarProdutoClient } from "@/components/produtos/criar-produto-client";

export const dynamic = "force-dynamic";

export default async function CriarProdutoPage() {
  // A mesma permissão que a acção exige. Aqui é para não mostrar um
  // formulário que vai ser recusado no fim; lá é a que garante.
  await requirePermission("catalog.write");

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-5">
        <section>
          <Link
            href="/stock"
            className="inline-flex items-center gap-1 text-[12px] text-slate-500 transition hover:text-slate-700"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Stock
          </Link>
          <h1 className="mt-2 text-[20px] font-semibold text-slate-900">
            Criar produto
          </h1>
          <p className="mt-1 text-[12px] text-slate-500">
            Uma ficha no catálogo do SPharm.MT. Fica disponível para pesquisa,
            encomendas, listas importadas e relatórios mesmo antes de alguma
            farmácia ter o artigo.
          </p>
        </section>

        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <CriarProdutoClient />
        </section>
      </div>
    </AppShell>
  );
}
