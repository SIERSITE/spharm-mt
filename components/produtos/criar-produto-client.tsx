"use client";

/**
 * components/produtos/criar-produto-client.tsx
 *
 * O invólucro de cliente do formulário, para o caminho de Stocks.
 *
 * Existe porque `app/produtos/criar/page.tsx` é um server component e
 * não pode passar um callback. Aqui fica a única coisa que distingue
 * este hospedeiro do modal do picker: para onde navega depois de criar.
 */
import { useRouter } from "next/navigation";
import { CriarProdutoForm } from "./criar-produto-form";

export function CriarProdutoClient() {
  const router = useRouter();

  return (
    <CriarProdutoForm
      contexto="STOCK"
      onCriado={(p) => {
        // Para a FICHA, não para /stock. Ver o comentário em
        // `app/produtos/criar/page.tsx`: /stock parte de
        // ProdutoFarmacia e um produto acabado de criar não tem
        // nenhuma — voltar para lá mostrava uma lista sem ele.
        router.push(`/catalogo/artigo/${p.cnp}`);
      }}
      onCancelar={() => router.push("/stock")}
    />
  );
}
