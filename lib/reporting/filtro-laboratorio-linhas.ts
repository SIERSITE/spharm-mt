/**
 * lib/reporting/filtro-laboratorio-linhas.ts
 *
 * Filtro "Laboratório ou grupo" aplicado, no CLIENTE, às linhas de Excessos / Transferências / Devoluções / Encomendas.
 *
 * Em garantia o filtro de fabricante oferece GRUPOS (`grupo:<id>`) e fabricantes (`fabricante:<id>`), mas a linha só
 * traz o nome do fabricante e o CNP do produto. O critério de pertença NUNCA é o CNP: é o GRUPO do produto
 * (`ProdutoGrupoLaboratorial`), o mesmo de Vendas/Margens/Inventário. O CNP é só a chave da linha.
 *
 * Duas formas de obter o estado do filtro (ambas alimentam `passaFiltroLaboratorioLinha`):
 *   · LOCAL (normal) — `construirEstadoFiltroLaboratorio`: a página já trouxe, num só SELECT, a pertença
 *     grupo -> CNP (`carregarPertencaGruposPorCnp`) e as opções com id -> nome do fabricante. Seleccionar/limpar é
 *     síncrono: sem pedidos, sem estado «a resolver», sem corridas.
 *     · `grupo:<id>`       -> CNP do grupo (pertença por produto, inclui regra CNP / prova manual);
 *     · `fabricante:<id>`  -> `Fabricante.nomeNormalizado` (único) == fabricante da linha (que vem desse mesmo campo);
 *     · nome solto antigo  -> nome de grupo (pertença do grupo) senão nome de fabricante, como no resolvedor.
 *   · SERVIDOR (reserva) — `useFiltroLaboratorio` sem pertença: `cnps` vem de `resolverCnpsLaboratoriosAction`;
 *     enquanto resolve, `cnps=null` e nenhuma linha passa.
 * Nos outros tenants (`modoGrupos=false`) a comparação por nome é EXACTAMENTE a de sempre. Pura (sem React/Prisma).
 */
import { parseValorLaboratorio, type CatalogoFilterOptionLaboratorio } from "@/lib/catalog/laboratorio-filtro";

export type EstadoFiltroLaboratorio = {
  /** true só quando o tenant tem grupos laboratoriais (`options.laboratorios` povoado). */
  modoGrupos: boolean;
  /** CNP resolvidos para a selecção actual; `null` enquanto o servidor ainda não respondeu (só no caminho de reserva). */
  cnps: ReadonlySet<string> | null;
  /** Nomes de fabricante (`Fabricante.nomeNormalizado`) seleccionados — só no caminho local. */
  nomesFabricante?: ReadonlySet<string>;
};

export function passaFiltroLaboratorioLinha(
  linha: { cnp: string | number; fabricante: string },
  selecionados: readonly string[],
  estado: EstadoFiltroLaboratorio,
): boolean {
  if (selecionados.length === 0) return true;
  if (!estado.modoGrupos) return selecionados.includes(linha.fabricante);
  // Selecção feita mas resolução (caminho de reserva) ainda em curso: não mostra linhas "erradas" entretanto.
  if (estado.cnps === null) return false;
  if (estado.cnps.has(String(linha.cnp))) return true;
  return !!estado.nomesFabricante && estado.nomesFabricante.has(linha.fabricante);
}

/**
 * Estado do filtro calculado LOCALMENTE (síncrono, sem servidor). `pertencaGrupos`: grupoId -> CNP (um SELECT no
 * servidor, ver `carregarPertencaGruposPorCnp`). União (OR) entre todos os valores seleccionados.
 */
export function construirEstadoFiltroLaboratorio(
  selecionados: readonly string[],
  laboratorios: readonly CatalogoFilterOptionLaboratorio[],
  pertencaGrupos: Readonly<Record<string, readonly string[]>>,
): EstadoFiltroLaboratorio {
  const cnps = new Set<string>();
  const nomes = new Set<string>();
  const nomesDeGrupo = new Map<string, string>(); // nome do grupo -> id (valores soltos antigos)
  const nomeDoFabricante = new Map<string, string>(); // id -> nomeNormalizado
  for (const o of laboratorios) {
    if (o.tipo === "grupo") nomesDeGrupo.set(o.nome, o.id);
    else nomeDoFabricante.set(o.id, o.nomeNormalizado);
  }
  const juntarGrupo = (grupoId: string) => {
    for (const c of pertencaGrupos[grupoId] ?? []) cnps.add(c);
  };
  for (const valor of selecionados) {
    const parsed = parseValorLaboratorio(valor);
    if (parsed?.tipo === "grupo") juntarGrupo(parsed.id);
    else if (parsed?.tipo === "fabricante") {
      const nome = nomeDoFabricante.get(parsed.id);
      if (nome) nomes.add(nome);
    } else {
      const grupoId = nomesDeGrupo.get(valor);
      if (grupoId) juntarGrupo(grupoId);
      else nomes.add(valor);
    }
  }
  return { modoGrupos: true, cnps, nomesFabricante: nomes };
}
