/**
 * lib/catalog/fabricante-normalizacao-garantia.ts
 *
 * Normalização canónica de fabricante, ALARGADA — exclusiva do fluxo de
 * reconciliação de fabricantes por CNP (tenant garantia,
 * `reconciliar-fabricantes-por-cnp-garantia.ts`). NUNCA reutilizada fora
 * deste fluxo, e NUNCA substitui `normalizeFabricanteCanonico`
 * (lib/catalog-normalizers.ts) — que continua a ser a única função usada
 * pelo ingest ERP, `getOrCreateFabricante` e as correcções regulatórias
 * genéricas, para TODOS os tenants.
 *
 * ── Porquê uma cópia, e não alargar a função partilhada ──────────────
 * Já se tentou levantar o limite de 60 para 120 caracteres NA PRÓPRIA
 * `normalizeFabricanteCanonico`, em 2026-09-22 — e foi revertido no dia
 * seguinte (ver o comentário "Limite de comprimento (60) — NÃO ALTERAR
 * aqui" em lib/catalog-normalizers.ts): essa função decide identidade de
 * Fabricante para TODOS os tenants e caminhos de ingest, e mudar o
 * limite ali mudaria silenciosamente o comportamento de ingestão fora de
 * garantia — exactamente o que este serviço, sendo exclusivo de
 * garantia (ver `lib/tenant-context.ts::TENANT_FABRICANTES_POR_CNP`),
 * nunca pode fazer.
 *
 * `RegulatoryRecord.titularAim` (a denominação social oficial do INFARMED)
 * é tipicamente mais longo do que o nome comercial habitual — o exemplo
 * que motivou este ficheiro, "Pharmakern Portugal, Produtos
 * Farmacêuticos, Sociedade Unipessoal Lda.", normaliza para 67
 * caracteres, acima do limite de 60 da função partilhada. Um titular
 * assim NUNCA deve ser truncado/rejeitado — é a identidade legal
 * correcta, exactamente o que `Fabricante.nomeNormalizado` (uma coluna
 * `TEXT` sem restrição real no Postgres) existe para guardar.
 *
 * Mesma limpeza determinística de `normalizeFabricanteCanonico`
 * (maiúsculas, sem acentos, pontuação — incluindo pontos de abreviatura —
 * vira espaço) — só o limite de comprimento difere. Duas strings que
 * convergiriam na função partilhada continuam a convergir aqui.
 */

/**
 * Generoso o suficiente para qualquer denominação social real (a maior
 * conhecida no catálogo INFARMED ronda os 90-100 caracteres) sem abrir
 * mão de uma salvaguarda contra lixo/loop de regex.
 */
const LIMITE_GARANTIA = 200;

export function normalizarTitularAimGarantia(value: string | null | undefined): string | null {
  if (!value) return null;
  const semAcentos = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const canonico = semAcentos
    .toUpperCase()
    .replace(/[^A-Z0-9 &-]/g, " ") // pontuação (incl. pontos de abreviatura) vira espaço
    .replace(/\s+/g, " ")
    .trim();
  return canonico.length >= 2 && canonico.length <= LIMITE_GARANTIA ? canonico : null;
}
