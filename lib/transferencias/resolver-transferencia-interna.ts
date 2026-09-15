/**
 * Validação PURA da resolução de farmácias para uma transferência
 * interna — sem I/O, sem `"use server"`, importável directamente por
 * testes (`scripts/tests/test-transferencia-por-id.ts`) sem precisar de
 * BD nem de mocks para `getPrisma()`/`requirePermission()`.
 *
 * Extraída de `app/encomendas/nova/actions.ts` (2026-09) por duas
 * razões:
 *   1. `actions.ts` tem `"use server"` no topo — o Next.js exige que
 *      TODOS os exports de função de um módulo "use server" sejam
 *      `async` (viram server actions); uma função pura síncrona
 *      exportada dali parte o build.
 *   2. Torna testável exaustivamente o cenário que motivou esta
 *      correcção: duas farmácias com o MESMO `nome` mas `id`s
 *      diferentes — `createInternalTransferAction` deixou de resolver
 *      a farmácia de origem por `findFirst({where:{nome}})` (que
 *      escolhia uma arbitrariamente quando o nome não era único) e
 *      passou a receber sempre farmácias JÁ RESOLVIDAS por id
 *      (`findUnique`). Esta função nunca olha para nomes, só
 *      compara/valida ids.
 */
export type ResolucaoTransferenciaInterna =
  | { ok: true; farmaciaOrigem: { id: string; nome: string }; farmaciaDestino: { id: string; nome: string } }
  | { ok: false; error: string };

export function resolverTransferenciaInterna(
  input: { sourceFarmaciaId: string; destinoFarmaciaId: string },
  farmaciaOrigem: { id: string; nome: string } | null,
  farmaciaDestino: { id: string; nome: string } | null,
): ResolucaoTransferenciaInterna {
  if (!input.destinoFarmaciaId) return { ok: false, error: "Farmácia destino em falta." };
  if (!input.sourceFarmaciaId) return { ok: false, error: "Farmácia de origem em falta." };
  if (input.sourceFarmaciaId === input.destinoFarmaciaId) {
    return { ok: false, error: "Origem e destino não podem ser a mesma farmácia." };
  }
  if (!farmaciaOrigem) return { ok: false, error: "Farmácia de origem não encontrada." };
  if (!farmaciaDestino) return { ok: false, error: "Farmácia de destino não encontrada." };
  return { ok: true, farmaciaOrigem, farmaciaDestino };
}
