/**
 * lib/catalog/forma-farmaceutica-filtro.ts
 *
 * Filtro de FORMA FARMACÊUTICA — o módulo ÚNICO (puro, sem Prisma, importável no browser).
 *
 * ── O problema ────────────────────────────────────────────────────────
 *
 * `Produto.formaFarmaceutica` é texto livre e a MESMA coluna carrega três convenções: o texto cru do INFARMED
 * («Comprimido revestido por película»), o Title case de `lib/catalog-normalizers.ts` e as minúsculas de
 * `lib/catalog/formas-farmaceuticas.ts`. Um `DISTINCT` cru daria `Comprimido`, `comprimido`, ` COMPRIMIDO ` como três
 * opções diferentes do mesmo filtro.
 *
 * ── A regra (e só esta) ───────────────────────────────────────────────
 *
 * CHAVE = aparar + colapsar espaços + passar a minúsculas + retirar acentos. Nada mais:
 *   · SEM fuzzy, SEM sinónimos, SEM taxonomia, SEM abreviaturas — «Comprimido», «Comprimido revestido» e «Comprimido
 *     de libertação prolongada» são formas DIFERENTES e continuam a ser três opções;
 *   · o valor guardado na BD nunca é alterado (nem a reconciliação do INFARMED) — a chave só existe ao filtrar.
 *
 * A mesma regra existe em SQL (`lib/catalog/forma-farmaceutica-sql.ts`); o teste de BD compara as duas sobre os
 * mesmos valores. Ambas usam a MESMA lista explícita de letras acentuadas (não `unaccent`, não NFD): assim TS e SQL
 * não divergem em caracteres raros nem dependem de extensões/locale da base.
 */

/** Chave sentinela do «produto sem forma» (NULL, vazio ou só espaços). Nunca colide com uma forma real. */
export const SEM_FORMA = "__sem_forma__";

/** Rótulo mostrado para `SEM_FORMA`. */
export const ROTULO_SEM_FORMA = "Sem forma farmacêutica";

/** Letras acentuadas tratadas (maiúsculas E minúsculas, para não depender do locale do `lower()` da base). */
export const ACENTOS_ORIGEM = "áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ";
export const ACENTOS_DESTINO = "aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn";

const MAPA_ACENTOS = new Map<string, string>(
  Array.from(ACENTOS_ORIGEM).map((c, i) => [c, ACENTOS_DESTINO[i]]),
);

/** Caracteres de espaço colapsados (a mesma classe é usada em SQL). */
const RE_ESPACOS = /[ \t\r\n\f\v]+/g;

/**
 * Forma normalizada de um valor cru (aparar, colapsar espaços, sem acentos, minúsculas). Devolve `""` para
 * vazio/nulo — quem quiser a chave de FILTRO (com a sentinela) usa `chaveFormaFarmaceutica`.
 */
export function normalizarTextoForma(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  const colapsado = valor.replace(RE_ESPACOS, " ").trim();
  let out = "";
  for (const c of colapsado) out += MAPA_ACENTOS.get(c) ?? c;
  return out.toLowerCase();
}

/**
 * A chave de FILTRO de um valor cru: a forma normalizada, ou `SEM_FORMA` se não houver forma.
 * É o que viaja em `formasFarmaceuticas` (estado, URL, contexto de rascunho) e o que o SQL compara.
 */
export function chaveFormaFarmaceutica(valor: string | null | undefined): string {
  return normalizarTextoForma(valor) || SEM_FORMA;
}

/** Uma opção do filtro: a chave (o que viaja), o rótulo (o que se mostra) e quantos produtos têm essa forma. */
export type OpcaoFormaFarmaceutica = { chave: string; label: string; count: number };

/** Um valor cru distinto da coluna, com o nº de produtos (o resultado de um `GROUP BY "formaFarmaceutica"`). */
export type ValorFormaComContagem = { valor: string | null | undefined; count: number };

/** «comprimido revestido» -> «Comprimido revestido»: minúsculas com a 1.ª letra maiúscula; espaços limpos; acentos mantidos. */
export function rotuloSentenceCase(valor: string): string {
  const limpo = valor.replace(RE_ESPACOS, " ").trim().toLowerCase();
  return limpo ? limpo.charAt(0).toUpperCase() + limpo.slice(1) : limpo;
}

const comparadorPt = new Intl.Collator("pt-PT", { sensitivity: "base", usage: "sort" });

/** Ordem alfabética pt, sem acentos, por rótulo. */
export function compararRotulos(a: string, b: string): number {
  return (
    comparadorPt.compare(normalizarTextoForma(a), normalizarTextoForma(b)) ||
    a.localeCompare(b, "pt-PT")
  );
}

/**
 * Agrupa os valores crus por CHAVE e devolve as opções do filtro.
 *
 *   · rótulo = a variante MAIS FREQUENTE do grupo (empate: a que tem acentos, depois a alfabética), em sentence-case;
 *   · contagem = soma das variantes;
 *   · ordem alfabética por rótulo (pt, sem acentos); «Sem forma farmacêutica» no FIM, só se houver produtos sem forma;
 *   · contagens <= 0 não geram opção (uma opção que nunca devolve linhas é ruído).
 */
export function opcoesFormaFarmaceutica(valores: readonly ValorFormaComContagem[]): OpcaoFormaFarmaceutica[] {
  type Grupo = { total: number; variantes: Map<string, number> };
  const grupos = new Map<string, Grupo>();
  for (const { valor, count } of valores) {
    if (!(count > 0)) continue;
    const chave = chaveFormaFarmaceutica(valor);
    const g = grupos.get(chave) ?? { total: 0, variantes: new Map<string, number>() };
    g.total += count;
    if (chave !== SEM_FORMA) {
      const limpo = (valor ?? "").replace(RE_ESPACOS, " ").trim();
      g.variantes.set(limpo, (g.variantes.get(limpo) ?? 0) + count);
    }
    grupos.set(chave, g);
  }

  const opcoes: OpcaoFormaFarmaceutica[] = [];
  let semForma: OpcaoFormaFarmaceutica | null = null;
  for (const [chave, g] of grupos) {
    if (chave === SEM_FORMA) {
      semForma = { chave, label: ROTULO_SEM_FORMA, count: g.total };
      continue;
    }
    const melhor = [...g.variantes.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const acentosA = /[^\x00-\x7f]/.test(a[0]) ? 1 : 0;
      const acentosB = /[^\x00-\x7f]/.test(b[0]) ? 1 : 0;
      if (acentosA !== acentosB) return acentosB - acentosA;
      return a[0].localeCompare(b[0], "pt-PT");
    })[0];
    opcoes.push({ chave, label: rotuloSentenceCase(melhor[0]), count: g.total });
  }
  opcoes.sort((a, b) => compararRotulos(a.label, b.label) || a.chave.localeCompare(b.chave));
  if (semForma) opcoes.push(semForma);
  return opcoes;
}

/** Rótulo de uma chave seleccionada — para chips e filtros aplicados dos relatórios. Chave desconhecida: reconstrói-o da chave. */
export function rotuloDaChaveForma(chave: string, opcoes: readonly OpcaoFormaFarmaceutica[]): string {
  if (chave === SEM_FORMA) return ROTULO_SEM_FORMA;
  return opcoes.find((o) => o.chave === chave)?.label ?? rotuloSentenceCase(chave);
}

/** Rótulos (por ordem de selecção) para o cabeçalho de filtros de PDF/Excel/email. */
export function rotulosFormasSelecionadas(
  chaves: readonly string[] | undefined | null,
  opcoes?: readonly OpcaoFormaFarmaceutica[],
): string[] {
  return (chaves ?? []).map((c) => rotuloDaChaveForma(c, opcoes ?? []));
}

/** A linha «Forma farmacêutica: A, B» dos filtros aplicados dos relatórios; `null` sem selecção. */
export function filtroFormaFarmaceuticaLinha(
  chaves: readonly string[] | undefined | null,
  opcoes?: readonly OpcaoFormaFarmaceutica[],
): { label: string; value: string } | null {
  const rotulos = rotulosFormasSelecionadas(chaves, opcoes);
  return rotulos.length > 0 ? { label: "Forma farmacêutica", value: rotulos.join(", ") } : null;
}

/** Quantas chaves a UI/URL aceita — travão contra um parâmetro de URL gigante. */
export const MAX_CHAVES_FORMA = 60;

/**
 * Lê uma lista de chaves de uma fonte NÃO fiável (sessionStorage antigo, URL, contexto de rascunho v1 sem o campo):
 * ausente/inválido -> `[]` (sem filtro = comportamento anterior); duplicados e vazios removidos; cada valor
 * RE-NORMALIZADO (uma chave gravada à mão com maiúsculas continua a funcionar). Aceita array ou UMA string. NÃO
 * separa por vírgulas: há formas com vírgula no nome («comprimido revestido, oral»); a URL usa parâmetros repetidos.
 */
export function lerChavesForma(bruto: unknown): string[] {
  const lista = Array.isArray(bruto) ? bruto : typeof bruto === "string" ? [bruto] : [];
  const out: string[] = [];
  for (const v of lista) {
    if (typeof v !== "string") continue;
    const chave = v.trim() === SEM_FORMA ? SEM_FORMA : normalizarTextoForma(v);
    if (chave && !out.includes(chave)) out.push(chave);
    if (out.length >= MAX_CHAVES_FORMA) break;
  }
  return out;
}

/** `true` se a linha (valor cru) passa o filtro. Vazio = passa tudo. Para refinamento client-side sobre campo da linha. */
export function passaFiltroForma(
  formaCrua: string | null | undefined,
  chaves: readonly string[] | undefined | null,
): boolean {
  if (!chaves || chaves.length === 0) return true;
  return chaves.includes(chaveFormaFarmaceutica(formaCrua));
}
