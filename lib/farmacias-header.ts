/**
 * lib/farmacias-header.ts
 *
 * Ficheiro CLIENT-SAFE: contém apenas tipos serializáveis e funções
 * puras. NUNCA importa prisma nem qualquer módulo que dependa de
 * `pg` / `dns` / outras APIs Node.
 *
 * Existe separado de lib/farmacias-info.ts (que faz o fetch via Prisma)
 * porque o bundler do Next puxa o módulo inteiro quando um Client
 * Component importa mesmo que só um símbolo. Misturar a função server
 * `getFarmaciasInfo()` com o helper puro `formatFarmaciaHeader()` no
 * mesmo ficheiro arrasta Prisma para o bundle client — build error
 * "Can't resolve 'dns'".
 *
 * Regra: qualquer página Server pode usar ambos os ficheiros; qualquer
 * Client Component SÓ pode importar deste ficheiro.
 */

/**
 * Metadados mínimos de uma farmácia. Plain object, totalmente
 * serializável através da fronteira server→client (Next passa props
 * de Server Components para Client Components como JSON).
 *
 * Nota sobre NIF: o schema Prisma `Farmacia` actual não tem campo
 * `nif`; temos `codigoANF` (código oficial Infarmed/ANF) que é o
 * identificador estável das farmácias portuguesas.
 */
export type FarmaciaInfo = {
  id: string;
  nome: string;
  codigoANF: string | null;
};

/**
 * Constrói o texto de cabeçalho do relatório com base nas farmácias
 * seleccionadas. Puro — não acede a BD.
 *
 * Regras:
 *   - 0 farmácias: "SPharm.MT · Grupo"
 *   - 1 farmácia: "<Nome> · ANF: <codigo>" (ou só o nome se sem codigoANF)
 *   - Todas: "SPharm.MT · Grupo (N farmácias)"
 *   - Subset > 1: "SPharm.MT · N farmácias seleccionadas"
 */
export function formatFarmaciaHeader(
  selectedNames: string[],
  all: FarmaciaInfo[]
): string {
  if (all.length === 0) return "SPharm.MT";
  if (selectedNames.length === 0) return "SPharm.MT · Grupo";

  if (selectedNames.length === 1) {
    const single = all.find((f) => f.nome === selectedNames[0]);
    if (!single) return selectedNames[0];
    return single.codigoANF
      ? `${single.nome} · ANF: ${single.codigoANF}`
      : single.nome;
  }

  if (selectedNames.length === all.length) {
    return `SPharm.MT · Grupo (${all.length} farmácias)`;
  }

  const n = selectedNames.length;
  return `SPharm.MT · ${n} farmácias seleccionadas`;
}
