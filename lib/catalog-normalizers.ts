/**
 * lib/catalog-normalizers.ts
 *
 * Funções de normalização para o pipeline de enriquecimento do catálogo.
 *
 * Regras gerais:
 *  - Nunca devolver strings vazias — preferir null.
 *  - Aceitar null/undefined como input e devolver null nesses casos.
 *  - Funções puras: sem side-effects, sem acesso à BD.
 */

// ── Fabricante ───────────────────────────────────────────────────────────────

/**
 * Normalização CANÓNICA de fabricante — é esta que decide se duas grafias
 * são "o mesmo fabricante". Maiúsculas, sem acentos, sem pontuação
 * (INCLUINDO pontos de abreviatura — "Lda." e "Lda" têm de convergir para o
 * mesmo valor, senão nunca se reconhecem como o mesmo fabricante).
 *
 * ── Porque existe ────────────────────────────────────────────────────────
 * Havia duas normalizações de fabricante incompatíveis no repositório:
 * `lib/ingest/catalog-from-erp.ts` tinha a sua própria cópia (maiúsculas,
 * mantendo pontos), e o pipeline de enriquecimento genérico usava
 * `normalizeManufacturerName` (Title Case, abaixo) como se fosse a mesma
 * coisa. O resultado: `Fabricante.nomeNormalizado` escrito por um caminho
 * ("BAYER PORTUGAL LDA") nunca batia certo com o mesmo fabricante escrito
 * ou comparado pelo outro ("Bayer Portugal, Lda."/"Bayer Portugal Lda") —
 * um dry-run de correcção via listagem regulatória via a marcar 100% dos
 * produtos como "a actualizar", mesmo quando o fabricante já estava certo.
 *
 * Esta função é agora a ÚNICA usada para decidir identidade de fabricante:
 * `lib/ingest/catalog-from-erp.ts` (ingest ERP), `getOrCreateFabricante`
 * (upsert/criação, abaixo em catalog-persistence.ts) e
 * `applyAuthoritativeManufacturerCorrections` (comparação da correcção
 * regulatória) importam-na, em vez de manter cada uma a sua versão.
 *
 * NUNCA usar para apresentação — é só a chave de identidade. Para mostrar
 * ao utilizador, usar o nome tal como veio da fonte (guardado em
 * `FabricanteAlias.aliasNome` quando difere do canónico).
 *
 * "BAYER PORTUGAL LDA", "Bayer Portugal, Lda." e "Bayer Portugal Lda"
 * convergem todas para "BAYER PORTUGAL LDA".
 *
 * ── Limite de comprimento (60) — NÃO ALTERAR aqui ────────────────────────
 * Uma tentativa em 2026-09-22 de levantar este limite para 120 (para
 * aceitar designações sociais completas como "Ratiopharm - Comércio E
 * Indústria De Produtos Farmacêuticos Lda", 63 chars canónicos) foi
 * revertida no dia seguinte: esta função é a identidade de Fabricante
 * partilhada por TODOS os tenants e fluxos (ingest ERP, upsert, correcções
 * regulatórias) — alterá-la aqui arriscava mudar silenciosamente o
 * comportamento de ingestão fora de garantia. O limite mais alto,
 * especificamente para o problema de grupos laboratoriais pesquisáveis
 * (garantia), vive agora em `lib/catalog/grupo-laboratorial-normalizers.ts`
 * (`normalizeGrupoLaboratorialCanonico`/`normalizeGrupoLaboratorialAlias`,
 * 120 chars) — nunca aqui. Ver o comentário desse ficheiro para o porquê
 * de precisarem de um limite diferente e como resolvem nomes longos sem
 * comprometer esta função.
 */
export function normalizeFabricanteCanonico(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const semAcentos = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const canonico = semAcentos
    .toUpperCase()
    .replace(/[^A-Z0-9 &-]/g, " ") // pontuação (incl. pontos de abreviatura) vira espaço
    .replace(/\s+/g, " ")
    .trim();
  return canonico.length >= 2 && canonico.length <= 60 ? canonico : null;
}

/** Sufixos empresariais que devem ficar em maiúsculas. */
const CORPORATE_SUFFIXES =
  /^(S\.A\.?|Lda\.?|S\.L\.?|GmbH|Ltd\.?|Inc\.?|LLC|PLC|SRL|NV|BV|SARL|AG)$/i;

/**
 * Normaliza o nome de um fabricante para capitalização consistente.
 *
 * - "BAYER S.A."   → "Bayer S.A."
 * - "   pfizer   " → "Pfizer"
 * - null           → null
 *
 * SÓ para apresentação. NÃO usar para decidir identidade/igualdade de
 * fabricante nem como chave de `Fabricante.nomeNormalizado` — para isso é
 * `normalizeFabricanteCanonico` (acima), que colapsa maiúsculas/acentos/
 * pontuação de forma determinística. Usar esta função como chave foi
 * precisamente o que causou a divergência entre o ingest do ERP e o
 * pipeline de enriquecimento — ver o comentário de
 * `normalizeFabricanteCanonico`.
 */
export function normalizeManufacturerName(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const result = trimmed
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      if (CORPORATE_SUFFIXES.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");

  return result || null;
}

// ── Princípio Ativo / DCI ────────────────────────────────────────────────────

/**
 * Normaliza o princípio ativo (DCI / INN) para minúsculas sem ruído.
 *
 * - "AMOXICILINA"          → "amoxicilina"
 * - "Paracetamol 500 mg"   → "paracetamol"  (remove dosagem inline)
 * - null                   → null
 */
export function normalizePrincipioAtivo(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    // Remove dosagemem inline: "500mg", "10 mg/ml", "0.5%", etc.
    .replace(
      /\b\d+[\.,]?\d*\s*(mg|g|ml|mcg|µg|ui|iu|%|mmol)(\s*\/\s*(ml|g|mg|l))?\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

// ── Código ATC ───────────────────────────────────────────────────────────────

/**
 * Validação ATC por nível:
 *  L1: A          (1 char)
 *  L2: A10        (3 chars)
 *  L3: A10B       (4 chars)
 *  L4: A10BA      (5 chars)
 *  L5: A10BA02    (7 chars)
 */
const ATC_VALID_PATTERN = /^[A-Z](\d{2}([A-Z]([A-Z](\d{2})?)?)?)?$/;

/**
 * Normaliza o código ATC para maiúsculas sem espaços.
 * Devolve null se o valor não corresponder ao padrão ATC.
 *
 * - "a10ba02"   → "A10BA02"
 * - "A10 BA 02" → "A10BA02"
 * - "bla bla"   → null  (inválido)
 */
export function normalizeATC(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = value.toUpperCase().replace(/\s+/g, "").trim();
  if (!upper) return null;
  if (!ATC_VALID_PATTERN.test(upper)) return null;
  return upper;
}

// ── Dosagem ──────────────────────────────────────────────────────────────────

/**
 * Normaliza a string de dosagem em formato padronizado.
 *
 * - "  500 mg  "  → "500 mg"
 * - "10mg/5ml"    → "10 mg/5 ml"
 * - null          → null
 */
export function normalizeDosagem(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .toLowerCase()
    // Garantir espaço entre número e unidade
    .replace(/(\d)(mg|g|ml|mcg|µg|ui|iu|%|mmol)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || null;
}

// ── Embalagem ────────────────────────────────────────────────────────────────

/**
 * Normaliza a descrição de embalagem (trim + colapso de espaços).
 *
 * Não faz transformações semânticas: o formato de embalagem é muito
 * variável entre fontes e não há vocabulário controlado fiável.
 */
export function normalizeEmbalagem(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || null;
}

// ── Forma Farmacêutica ───────────────────────────────────────────────────────

/**
 * Vocabulário controlado para forma farmacêutica (PT).
 * Chave: valor normalizado em minúsculas (sem acentos não preservados).
 * Valor: forma canónica a usar na BD.
 */
const FORMA_MAP: Record<string, string> = {
  // Sólidos orais
  comprimido: "Comprimido",
  comprimidos: "Comprimido",
  comp: "Comprimido",
  cp: "Comprimido",
  "comprimido revestido": "Comprimido revestido",
  "comprimido revestido por película": "Comprimido revestido",
  "comprimido revestido por pelicula": "Comprimido revestido",
  "comprimido de libertação modificada": "Comprimido de libertação modificada",
  "comprimido efervescente": "Comprimido efervescente",
  "cápsula": "Cápsula",
  "cápsulas": "Cápsula",
  capsula: "Cápsula",
  capsulas: "Cápsula",
  "cápsula dura": "Cápsula dura",
  "cápsula mole": "Cápsula mole",
  "cápsulas duras": "Cápsula dura",
  "cápsulas moles": "Cápsula mole",
  granulado: "Granulado",
  "granulado efervescente": "Granulado efervescente",
  pastilha: "Pastilha",
  "pó oral": "Pó para solução oral",
  "pó para solução oral": "Pó para solução oral",
  "po para solucao oral": "Pó para solução oral",
  "pó para suspensão oral": "Pó para suspensão oral",
  // Líquidos orais
  xarope: "Xarope",
  "solução oral": "Solução oral",
  "solucao oral": "Solução oral",
  "sol oral": "Solução oral",
  "suspensão oral": "Suspensão oral",
  "suspensao oral": "Suspensão oral",
  "susp oral": "Suspensão oral",
  "emulsão oral": "Emulsão oral",
  "gotas orais": "Gotas orais",
  gotas: "Gotas orais",
  elixir: "Elixir",
  // Injectáveis / parenterais
  "solução injetável": "Solução injetável",
  "solucao injetavel": "Solução injetável",
  "sol inj": "Solução injetável",
  "pó para solução injetável": "Pó para solução injetável",
  "po para solucao injetavel": "Pó para solução injetável",
  "pó injetável": "Pó para solução injetável",
  "solução para perfusão": "Solução para perfusão",
  "solucao para perfusao": "Solução para perfusão",
  "pó para solução para perfusão": "Pó para solução para perfusão",
  "solução para injeção": "Solução injetável",
  // Tópicos
  gel: "Gel",
  "gel oral": "Gel oral",
  "gel vaginal": "Gel vaginal",
  creme: "Creme",
  "creme vaginal": "Creme vaginal",
  pomada: "Pomada",
  "loção": "Loção",
  locao: "Loção",
  pasta: "Pasta",
  "solução cutânea": "Solução cutânea",
  "solucao cutanea": "Solução cutânea",
  "emulsão cutânea": "Emulsão cutânea",
  "emulsao cutanea": "Emulsão cutânea",
  "espuma cutânea": "Espuma cutânea",
  espuma: "Espuma cutânea",
  "champô": "Champô",
  champo: "Champô",
  // Outros
  "supositório": "Supositório",
  supositorio: "Supositório",
  "supositórios": "Supositório",
  "óvulo": "Óvulo",
  ovulo: "Óvulo",
  "óvulos": "Óvulo",
  "colírio": "Colírio",
  colirio: "Colírio",
  "colírios": "Colírio",
  "spray nasal": "Spray nasal",
  "solução nasal": "Solução nasal",
  "solucao nasal": "Solução nasal",
  "gotas nasais": "Gotas nasais",
  spray: "Spray",
  inalador: "Inalador",
  "pó para inalação": "Pó para inalação",
  "po para inalacao": "Pó para inalação",
  aerossol: "Aerossol para inalação",
  "aerossol para inalação": "Aerossol para inalação",
  "adesivo transdérmico": "Adesivo transdérmico",
  "adesivo transdermico": "Adesivo transdérmico",
  adesivo: "Adesivo transdérmico",
  implante: "Implante",
  penso: "Penso",
  "dispositivo intrauterino": "Dispositivo intrauterino",
  diu: "Dispositivo intrauterino",
};

/**
 * Normaliza a forma farmacêutica para vocabulário controlado (PT).
 * Devolve null se o valor não for reconhecido — nunca inventa.
 */
export function normalizeFormaFarmaceutica(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return FORMA_MAP[key] ?? null;
}

// ── Categoria ────────────────────────────────────────────────────────────────

/**
 * Normaliza o nome de categoria para title-case sem ruído.
 *
 * - "MEDICAMENTOS"   → "Medicamentos"
 * - "  vitaminas c " → "Vitaminas C"
 */
export function normalizeCategoria(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const result = trimmed
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

  return result || null;
}

// ── Imagem URL ───────────────────────────────────────────────────────────────

const IMAGE_EXT_PATTERN = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?$/i;
const HTTP_URL_PATTERN = /^https?:\/\/.+/i;

/**
 * Valida e normaliza uma URL de imagem.
 * Devolve null se não parecer uma URL de imagem HTTP válida.
 *
 * - URLs sem extensão de imagem reconhecida → null
 * - Caminhos relativos / data URIs → null
 */
export function normalizeImageUrl(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!HTTP_URL_PATTERN.test(trimmed)) return null;
  if (!IMAGE_EXT_PATTERN.test(trimmed)) return null;
  return trimmed;
}

// ── Designação ───────────────────────────────────────────────────────────────

/**
 * Normaliza a designação do produto: trim + colapso de espaços internos.
 * Não aplica title-case — a capitalização original da designação é preservada.
 */
export function normalizeDesignacao(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
