/**
 * lib/farmacias-info.ts
 *
 * SERVER-ONLY: importa prisma e lê a tabela Farmacia. NUNCA pode ser
 * importado por Client Components — o bundler do Next vai puxar este
 * módulo inteiro e arrastar `pg`/`dns` para o bundle do browser.
 *
 * Para helpers puros + tipos que o client precisa de usar, ver
 * `lib/farmacias-header.ts` (client-safe, sem dependências de Prisma).
 *
 * Uso correcto:
 *   - Server Component / Server Action: importa `getFarmaciasInfo` daqui
 *   - Client Component: importa SÓ `FarmaciaInfo` e `formatFarmaciaHeader`
 *     de `lib/farmacias-header.ts`
 */

import { getPrisma } from "@/lib/prisma";
import type { FarmaciaInfo } from "./farmacias-header";

// Re-export do tipo para quem importa do ficheiro server — mantém
// compatibilidade com consumers existentes, mas o tipo "vive" em
// farmacias-header.ts (client-safe).
export type { FarmaciaInfo };

export async function getFarmaciasInfo(): Promise<FarmaciaInfo[]> {
  const prisma = await getPrisma();
  const rows = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true, codigoANF: true },
    orderBy: { nome: "asc" },
  });
  return rows;
}
