/**
 * lib/catalog/grupo-laboratorial-normalizers.ts
 *
 * Normalização canónica DEDICADA aos grupos laboratoriais pesquisáveis
 * (tenant garantia) — nunca importada por nenhum fluxo fora deste
 * pipeline (candidatos-grupo-laboratorial.ts, propostas-fabricante-por-cnp.ts,
 * resolver-grupo-laboratorial.ts, scripts/simular-grupos-laboratoriais-garantia.ts,
 * scripts/classificar-grupos-laboratoriais-garantia.ts).
 *
 * ── Porque existe, em vez de reaproveitar normalizeFabricanteCanonico ────
 * `normalizeFabricanteCanonico` (lib/catalog-normalizers.ts) é a
 * identidade de `Fabricante` partilhada por TODOS os tenants e fluxos —
 * limite de 60 caracteres, histórico, nunca deve mudar por causa de um
 * problema de UM tenant. Mas a configuração de grupos laboratoriais
 * (scripts/data/grupos-laboratoriais-iniciais-garantia.json) guarda,
 * deliberadamente, designações sociais COMPLETAS de fabricantes como
 * evidência/proveniência (ex.: "Ratiopharm - Comércio E Indústria De
 * Produtos Farmacêuticos Lda", 63 caracteres canónicos; "Pentafarma
 * Genéricos - Sociedade Técnico Medicinal, Unipessoal Lda.", 65) — sem
 * um limite mais alto, `validarConfig` rejeitava-as com
 * `fabricante_integral_invalido`, mesmo sendo texto válido.
 *
 * As funções abaixo usam EXACTAMENTE o mesmo algoritmo de limpeza
 * (maiúsculas, sem acentos, pontuação vira espaço, colapsa espaços) —
 * só o limite de comprimento muda, de 60 para 120. `GrupoLaboratorial`
 * e `GrupoLaboratorialAlias` não têm `@db.VarChar` no schema (são
 * `String`/TEXT em Postgres, sem limite real) — 120 dá margem para
 * designações sociais longas sem aceitar lixo (blocos de texto
 * anormalmente longos, provável erro de leitura de coluna).
 *
 * ── Nomes longos que precisam bater com um Fabricante REAL ───────────────
 * IMPORTANTE: levantar o limite aqui NÃO faz uma designação de >60
 * caracteres canónicos passar a bater com nenhum `Fabricante.nomeNormalizado`
 * real — esse continua limitado a 60 pela função partilhada, sempre. Uma
 * string de config com forma canónica de, digamos, 63 caracteres nunca
 * vai encontrar um Fabricante real correspondente por comparação exacta,
 * INDEPENDENTEMENTE de qual normalizador a produziu — e está correcto que
 * seja assim: não existe (nem pode existir) nenhum Fabricante real com
 * esse nome exacto de 63 caracteres, dado que todo o fluxo de ingestão
 * grava `Fabricante.nomeNormalizado` através de `normalizeFabricanteCanonico`
 * (60). O que estas funções resolvem é a VALIDAÇÃO da configuração (deixar
 * de rejeitar o texto só pelo comprimento) e a normalização da IDENTIDADE
 * PRÓPRIA do grupo/alias (sempre curta na prática) — nunca inventam uma
 * correspondência que os dados reais não sustentam. A cobertura efectiva
 * de fabricantes reais continua a vir das variantes mais curtas,
 * realmente observadas em garantia (ex.: "RATIOPHARM - COMERCIO E
 * INDUSTRIA DE PRODUTOS FARM", 52 chars) — documentado em
 * scripts/data/grupos-laboratoriais-iniciais-garantia.json.
 *
 * Para COMPARAR um nome de config longo com um Fabricante real sem o
 * rejeitar só pelo comprimento, usar `compararNomesTolerandoComprimento`
 * abaixo — nunca `===` entre as duas formas canónicas quando uma delas
 * pode exceder 60: compara pelo prefixo comum até ao comprimento mais
 * curto, para não descartar em falso um nome real que a base guarda
 * truncado/abreviado em relação à designação social completa.
 */

function normalizarTexto(value: string | null | undefined, maxLen: number): string | null {
  if (!value) return null;
  const semAcentos = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const canonico = semAcentos
    .toUpperCase()
    .replace(/[^A-Z0-9 &-]/g, " ") // pontuação (incl. pontos de abreviatura) vira espaço
    .replace(/\s+/g, " ")
    .trim();
  return canonico.length >= 2 && canonico.length <= maxLen ? canonico : null;
}

/** GrupoLaboratorial.nome/nomeNormalizado — identidade do grupo em si (curta na prática: "Viatris", "Alfasigma"). */
export function normalizeGrupoLaboratorialCanonico(value: string | null | undefined): string | null {
  return normalizarTexto(value, 120);
}

/**
 * GrupoLaboratorialAlias.alias/aliasNormalizado — e também qualquer
 * string candidata a `fabricantesIntegrais` na configuração, ao validar
 * (nunca ao decidir identidade de Fabricante — ver o doc comment do
 * ficheiro). Tolerante a designações sociais completas longas.
 */
export function normalizeGrupoLaboratorialAlias(value: string | null | undefined): string | null {
  return normalizarTexto(value, 120);
}

/**
 * Compara um nome de config (potencialmente longo, forma canónica de
 * `normalizeGrupoLaboratorialAlias`) com o nome canónico REAL de um
 * Fabricante (sempre <=60, forma de `normalizeFabricanteCanonico`) sem
 * rejeitar por comprimento: verdadeiro sse um dos dois é um PREFIXO
 * EXACTO do outro, já em forma canónica (ex.: garantia guarda
 * "TECNIMEDE SOCIEDADE TECNICO MEDICINAL" enquanto o catálogo tem a
 * forma completa "TECNIMEDE SOCIEDADE TECNICO MEDICINAL S A" — o nome
 * real é um prefixo válido da designação social completa). Só usar para
 * SUGERIR candidatos a validação humana — nunca para uma associação
 * automática/integral (essa continua a exigir igualdade exacta contra
 * `Fabricante.nomeNormalizado`, em `construirMapasResolver`).
 */
export function compararNomesTolerandoComprimento(nomeConfig: string | null, nomeFabricanteReal: string | null): boolean {
  if (!nomeConfig || !nomeFabricanteReal) return false;
  if (nomeConfig === nomeFabricanteReal) return true;
  const [curto, longo] = nomeConfig.length <= nomeFabricanteReal.length ? [nomeConfig, nomeFabricanteReal] : [nomeFabricanteReal, nomeConfig];
  return curto.length >= 8 && longo.startsWith(curto);
}
