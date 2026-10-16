/**
 * lib/workspace/rotas.ts
 *
 * Que rotas são «separadores» do workspace e como se identifica cada um. Fonte ÚNICA, partilhada pela barra de
 * separadores (components/layout/task-bar.tsx), pelo estado por separador (lib/workspace/estado-separador.tsx) e pela
 * navegação contextual — antes cada um tinha a sua cópia da tabela.
 *
 * ── Identidade de um separador ─────────────────────────────────────────
 *   · módulos de relatório (`workspace: true`: Vendas, Margens, Inventário, Transferências, Excessos): `pathname` +
 *     `?workspace=<id>` — duas análises do mesmo módulo são separadores DISTINTOS, cada uma com o seu estado;
 *   · todas as outras rotas: o `pathname` (cada encomenda/ficha tem o seu).
 * O `?workspace=` é gerado uma vez por análise (ver `gerarWorkspaceId`) e nunca é reutilizado por outra.
 */
export type RotaWorkspace = { prefixo: string; tipo: string; titulo: string; workspace?: boolean };

export const ROTAS: RotaWorkspace[] = [
  { prefixo: "/dashboard", tipo: "dashboard", titulo: "Dashboard" },
  { prefixo: "/stock/artigo", tipo: "artigo", titulo: "Ficha de artigo" },
  { prefixo: "/stock", tipo: "stock", titulo: "Stock" },
  { prefixo: "/devolucoes", tipo: "devolucoes", titulo: "Devoluções" },
  { prefixo: "/vendas/manutencao", tipo: "vendas-manutencao", titulo: "Manutenção de vendas" },
  { prefixo: "/vendas", tipo: "vendas", titulo: "Vendas", workspace: true },
  { prefixo: "/relatorios/inventario", tipo: "inventario", titulo: "Inventário", workspace: true },
  { prefixo: "/relatorios/margens", tipo: "margens", titulo: "Margens", workspace: true },
  { prefixo: "/encomendas/nova", tipo: "encomenda-nova", titulo: "Nova encomenda" },
  { prefixo: "/encomendas", tipo: "encomenda", titulo: "Encomendas" },
  { prefixo: "/transferencias", tipo: "transferencias", titulo: "Transferências", workspace: true },
  { prefixo: "/excessos", tipo: "excessos", titulo: "Excessos", workspace: true },
  { prefixo: "/catalogo/manutencao", tipo: "catalogo-manutencao", titulo: "Manutenção do catálogo" },
  { prefixo: "/catalogo/artigo", tipo: "artigo-catalogo", titulo: "Ficha de artigo (catálogo)" },
  { prefixo: "/catalogo", tipo: "catalogo", titulo: "Catálogo" },
];

export type RotaResolvida = { tipo: string; titulo: string; workspace: boolean };

export function resolverRota(pathname: string): RotaResolvida | null {
  for (const r of ROTAS) {
    if (pathname === r.prefixo || pathname.startsWith(`${r.prefixo}/`)) {
      return { tipo: r.tipo, titulo: r.titulo, workspace: r.workspace ?? false };
    }
  }
  return null;
}

/**
 * Identidade estável do separador para esta localização, ou `null` se a rota não é um separador (login, admin…) ou
 * se é um módulo de relatório ainda sem `?workspace=` (a barra gera-o e substitui o URL).
 */
export function identidadeDoSeparador(pathname: string | null, workspaceParam: string | null): string | null {
  if (!pathname) return null;
  const rota = resolverRota(pathname);
  if (!rota) return null;
  if (rota.workspace) return workspaceParam ? `${pathname}?workspace=${workspaceParam}` : null;
  return pathname;
}

/**
 * URL COMPLETO a que um separador regressa (pathname + pesquisa/ordenação/página na query), sem o parâmetro do painel
 * lateral `ficha` (o painel é estado transitório da página, não localização). Mantém `workspace`.
 */
export function hrefDoSeparador(pathname: string, search: URLSearchParams): string {
  const p = new URLSearchParams(search.toString());
  p.delete("ficha");
  const q = p.toString();
  return q ? `${pathname}?${q}` : pathname;
}
