/**
 * scripts/importar-grupos-laboratoriais-garantia.ts
 *
 * Popula `GrupoLaboratorial`, `GrupoLaboratorialAlias`,
 * `GrupoLaboratorialFabricante` e `RegraGrupoLaboratorialPorCnp` na base
 * do tenant garantia, a partir da configuração já aprovada:
 *   - scripts/data/grupos-laboratoriais-iniciais-garantia.json (grupos,
 *     aliases, associações integrais);
 *   - scripts/data/regras-cnp-grupos-laboratoriais-garantia.json (regras
 *     por CNP validadas manualmente — nível 2 da precedência).
 *
 * Existe porque NENHUM script de produção fazia isto antes: a única
 * escrita destas tabelas no repositório vivia em
 * `scripts/ensaio-volume-real-docker.ts`, que o próprio ficheiro
 * documenta como "nunca uma base real, nunca a VPS" — liga por
 * `DATABASE_URL` cru, sem `resolverAlvo`, sem `--tenant`, sem a segunda
 * trava. Este ficheiro é o caminho de produção que faltava.
 *
 * ── O que este script NUNCA faz ───────────────────────────────────────
 *   - nunca classifica produtos (não toca em `ProdutoGrupoLaboratorial`
 *     — isso é `scripts/classificar-grupos-laboratoriais-garantia.ts`,
 *     que corre DEPOIS, sobre os dados que este script cria);
 *   - nunca escreve `Produto` nem `Produto.fabricanteId` — o tipo do
 *     Prisma aceite (`PrismaParaImportacaoGrupos`) nem sequer inclui o
 *     delegate `produto`, é um erro de compilação tentar;
 *   - nunca escreve `Fabricante` — só lê (`findMany`), e só esse método:
 *     o tipo aceite restringe `fabricante` a `Pick<..., "findMany">`;
 *   - nunca lê `classificacao-pares-propostas-garantia.json`,
 *     `decomposicao-propostas-*.json` nem nenhuma outra fonte de
 *     PROPOSTAS/snapshot — só a configuração curada e as regras
 *     validadas (`validadoManualmente=true`, `estado=ATIVO`);
 *   - nunca reutiliza a lógica de `ensaio-volume-real-docker.ts`.
 *
 * ── Segurança: travado ao tenant garantia, em VÁRIAS camadas ──────────
 *   1. `--tenant=garantia` obrigatório, verificado ANTES de resolverAlvo
 *      (igual a todo o resto desta iniciativa);
 *   2. `confirmarAlvoGarantia`, DEPOIS da resolução via control plane;
 *   3. a própria CONFIGURAÇÃO tem de declarar `"tenant": "garantia"` —
 *      um ficheiro de configuração copiado/adaptado de outro tenant por
 *      engano é recusado antes de qualquer leitura da base;
 *   4. para ESCREVER, exige as DUAS flags em simultâneo: `--apply` e
 *      `--confirmar-tenant=garantia` — falta uma, fica em dry-run.
 *
 * ── Dry-run é o default, sempre ───────────────────────────────────────
 * Sem `--apply` (ou sem `--confirmar-tenant=garantia` a acompanhá-lo):
 * zero escritas, sessão Postgres aberta read-only
 * (`default_transaction_read_only=on`, mesma defesa dos outros scripts
 * desta iniciativa), relatório completo do que SERIA feito.
 *
 * ── Bloqueios impedem SEMPRE o apply ──────────────────────────────────
 * Um fabricante inexistente, ambíguo, um conflito (o mesmo fabricante
 * integral reclamado por dois grupos, o mesmo CNP com regras para dois
 * grupos diferentes, JANSSEN em KENVUE, qualquer PFIZER com associação
 * integral) bloqueia o apply inteiro — nunca escolhe automaticamente,
 * nunca escreve uma parte "seguro" e ignora o resto.
 *
 * ── Transação única ────────────────────────────────────────────────────
 * Ao contrário de `classificar-grupos-laboratoriais-garantia.ts` (que
 * usa lotes de 200 transações curtas — precisa disso para ~3400+
 * produtos), este script escreve um conjunto CURADO e pequeno (dezenas
 * de grupos/aliases, ~1 a 2 centenas de associações/regras) — cabe
 * confortavelmente numa única transação interactive do Prisma, dentro do
 * timeout default. Qualquer conflito durante a escrita (ex.: uma
 * violação de unicidade que os bloqueios prévios não apanharam) faz
 * `$transaction` rejeitar e o Prisma reverte tudo — nunca fica um
 * subconjunto escrito.
 *
 * ── Idempotência ────────────────────────────────────────────────────────
 * Cada entidade é resolvida contra o estado ATUAL da base (grupo por
 * `nomeNormalizado`, alias por `[grupoLaboratorialId, aliasNormalizado]`,
 * associação integral por `fabricanteId`, regra por `cnp`) e classificada
 * em CRIAR / ATUALIZAR (metadados configuráveis diferentes) / INALTERADO
 * (tudo igual — nenhuma escrita emitida, nem um upsert vazio). Correr
 * duas vezes com a MESMA configuração produz zero duplicados e tudo
 * "inalterado" na segunda corrida.
 *
 * Uso:
 *   npx tsx scripts/importar-grupos-laboratoriais-garantia.ts \
 *     --tenant=garantia \
 *     --relatorio=/relatorios/importar-grupos-garantia.json
 *
 *   npx tsx scripts/importar-grupos-laboratoriais-garantia.ts \
 *     --tenant=garantia \
 *     --relatorio=/relatorios/importar-grupos-garantia-apply.json \
 *     --apply --confirmar-tenant=garantia
 *
 * Opções:
 *   --tenant=<slug>          Obrigatório — resolvido via resolverAlvo (control plane), nunca DATABASE_URL genérico.
 *   --relatorio=<path>       Obrigatório.
 *   --config=<path>          Default: scripts/data/grupos-laboratoriais-iniciais-garantia.json
 *   --regras=<path>          Default: scripts/data/regras-cnp-grupos-laboratoriais-garantia.json
 *   --apply                  Escreve — só com --confirmar-tenant= a acompanhar.
 *   --confirmar-tenant=garantia  Segunda confirmação explícita, exigida junto com --apply.
 *   --permitir-externo       Necessário se o tenant não for a VPS de produção.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import { normalizeFabricanteCanonico } from "../lib/catalog-normalizers";
import { normalizeGrupoLaboratorialAlias } from "../lib/catalog/grupo-laboratorial-normalizers";

export const TENANT_TRAVADO = "garantia";
export const BASE_ESPERADA = "spharmmt_t_garantia";

const CONFIG_PATH_DEFAULT = "scripts/data/grupos-laboratoriais-iniciais-garantia.json";
const REGRAS_PATH_DEFAULT = "scripts/data/regras-cnp-grupos-laboratoriais-garantia.json";

// ── Forma dos ficheiros de configuração (só os campos usados) ──────────

export type AliasConfig = { alias: string; aliasNormalizado: string; origem?: string };

export type GrupoConfig = {
  nome: string;
  nomeNormalizado: string;
  aliases: AliasConfig[];
  fabricantesIntegrais: string[];
  naoIncluirAutomaticamente?: string[];
};

export type ConfigGruposIniciais = {
  /** Trava adicional: a própria config tem de se declarar do tenant garantia. */
  tenant: string;
  grupos: GrupoConfig[];
};

export type RegraCnpConfig = {
  cnp: number;
  grupoLaboratorialNomeNormalizado: string;
  fabricanteLegalEsperadoNormalizado?: string;
  evidencia?: string;
  estado: "ATIVO" | "INATIVO";
  validadoManualmente: boolean;
};

export type RegrasCnpFicheiro = {
  /** Opcional para não obrigar a reescrever ficheiros antigos de investigação — mas OBRIGATÓRIO quando presente, e sempre validado quando o ficheiro é o usado por --apply real. */
  tenant?: string;
  regras: RegraCnpConfig[];
};

// ── CLI ──────────────────────────────────────────────────────────────

export type Args = {
  relatorioPath: string;
  configPath: string;
  regrasPath: string;
  apply: boolean;
  confirmarTenant?: string;
};

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = { apply: false, configPath: CONFIG_PATH_DEFAULT, regrasPath: REGRAS_PATH_DEFAULT };
  for (const a of argv) {
    if (a.startsWith("--relatorio=")) out.relatorioPath = a.slice("--relatorio=".length);
    else if (a.startsWith("--config=")) out.configPath = a.slice("--config=".length);
    else if (a.startsWith("--regras=")) out.regrasPath = a.slice("--regras=".length);
    else if (a.startsWith("--confirmar-tenant=")) out.confirmarTenant = a.slice("--confirmar-tenant=".length);
    else if (a === "--apply") out.apply = true;
    else if (a.startsWith("--tenant=") || a === "--permitir-externo") {
      // Consumido por resolverAlvo.
    } else {
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.relatorioPath) throw new Error("--relatorio=<path> é obrigatório");
  if (out.apply && out.confirmarTenant !== TENANT_TRAVADO) {
    throw new Error(
      `--apply exige também --confirmar-tenant=${TENANT_TRAVADO} (dupla confirmação explícita).\n` +
        `Recebido --confirmar-tenant=${out.confirmarTenant ?? "(nenhum)"}. Sem as duas flags, não escreve.`,
    );
  }
  return out as Args;
}

/** Segunda trava, DEPOIS de resolverAlvo — mesmo padrão dos outros scripts desta iniciativa. */
export function confirmarAlvoGarantia(alvo: Pick<AlvoDb, "tenant" | "base">): void {
  if (alvo.tenant !== TENANT_TRAVADO) {
    throw new Error(`Alvo resolvido para tenant "${alvo.tenant}", não "${TENANT_TRAVADO}" — recusado.`);
  }
  if (alvo.base !== BASE_ESPERADA) {
    throw new Error(`Alvo resolvido para a base "${alvo.base}", não "${BASE_ESPERADA}" — recusado.`);
  }
}

/** Terceira trava: a própria configuração tem de se declarar do tenant garantia. */
export function confirmarConfigGarantia(config: Pick<ConfigGruposIniciais, "tenant">, regras: Pick<RegrasCnpFicheiro, "tenant">): void {
  if (config.tenant !== TENANT_TRAVADO) {
    throw new Error(`A configuração de grupos declara tenant "${config.tenant}", não "${TENANT_TRAVADO}" — recusado.`);
  }
  if (regras.tenant !== undefined && regras.tenant !== TENANT_TRAVADO) {
    throw new Error(`A configuração de regras por CNP declara tenant "${regras.tenant}", não "${TENANT_TRAVADO}" — recusado.`);
  }
}

export function escreverAtomico(caminhoFinal: string, conteudo: string): void {
  mkdirSync(dirname(caminhoFinal), { recursive: true });
  const tmp = `${caminhoFinal}.tmp-${process.pid}`;
  writeFileSync(tmp, conteudo, "utf8");
  try {
    renameSync(tmp, caminhoFinal);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ── Tipo do Prisma aceite — prova em tempo de compilação que este ──────
// script não pode escrever Produto nem Fabricante: "produto" não faz
// parte do tipo (nem para leitura), e "fabricante" só expõe "findMany".
export type PrismaParaImportacaoGrupos = {
  fabricante: Pick<PrismaClient["fabricante"], "findMany">;
  grupoLaboratorial: Pick<PrismaClient["grupoLaboratorial"], "findMany">;
  grupoLaboratorialAlias: Pick<PrismaClient["grupoLaboratorialAlias"], "findMany">;
  grupoLaboratorialFabricante: Pick<PrismaClient["grupoLaboratorialFabricante"], "findMany">;
  regraGrupoLaboratorialPorCnp: Pick<PrismaClient["regraGrupoLaboratorialPorCnp"], "findMany">;
  $transaction: PrismaClient["$transaction"];
};

// ── Bloqueios/conflitos ──────────────────────────────────────────────

export type Bloqueio = { tipo: string; detalhe: string };

// ── Passo 1: validação ESTRUTURAL da configuração (sem tocar na base) ──

/**
 * Verifica a configuração em si — sem nenhum dado real de garantia:
 *   - um fabricante integral reclamado por DOIS grupos ao mesmo tempo
 *     (contraditório: um fabricante legal só pode estar integralmente
 *     num grupo);
 *   - JANSSEN nunca em KENVUE (fabricantes integrais nem aliases);
 *   - PFIZER nunca com associação INTEGRAL em nenhum grupo (só pode
 *     entrar por RegraGrupoLaboratorialPorCnp);
 *   - cada regra por CNP aponta para um grupo que existe na config;
 *   - o mesmo CNP não tem duas regras para grupos diferentes dentro do
 *     próprio ficheiro de regras;
 *   - só regras ATIVAS e validadoManualmente=true são consideradas — as
 *     restantes ficam listadas em `regrasIgnoradas`, nunca aplicadas.
 */
export function validarConfigEstrutural(
  config: ConfigGruposIniciais,
  regras: RegrasCnpFicheiro,
): { bloqueios: Bloqueio[]; regrasValidas: RegraCnpConfig[]; regrasIgnoradas: RegraCnpConfig[] } {
  const bloqueios: Bloqueio[] = [];

  // Fabricante integral em dois grupos (nível de config, string normalizada).
  const fabricanteIntegralParaGrupo = new Map<string, string>();
  for (const g of config.grupos) {
    for (const nomeCru of g.fabricantesIntegrais) {
      const norm = normalizeGrupoLaboratorialAlias(nomeCru);
      if (!norm) {
        bloqueios.push({ tipo: "fabricante_integral_invalido", detalhe: `grupo "${g.nome}": "${nomeCru}" não normaliza (vazio ou inválido)` });
        continue;
      }
      const outroGrupo = fabricanteIntegralParaGrupo.get(norm);
      if (outroGrupo && outroGrupo !== g.nome) {
        bloqueios.push({
          tipo: "fabricante_integral_em_dois_grupos",
          detalhe: `"${nomeCru}" (normalizado "${norm}") está listado como integral tanto em "${outroGrupo}" como em "${g.nome}".`,
        });
      } else {
        fabricanteIntegralParaGrupo.set(norm, g.nome);
      }
    }
  }

  // JANSSEN nunca em KENVUE.
  const kenvue = config.grupos.find((g) => g.nomeNormalizado === "KENVUE");
  if (kenvue) {
    const contemJanssen = (s: string) => /JANSSEN/i.test(s);
    for (const v of kenvue.fabricantesIntegrais.filter(contemJanssen)) {
      bloqueios.push({ tipo: "janssen_em_kenvue", detalhe: `fabricante integral "${v}" no grupo Kenvue contém "JANSSEN"` });
    }
    for (const v of kenvue.aliases.filter((a) => contemJanssen(a.alias) || contemJanssen(a.aliasNormalizado))) {
      bloqueios.push({ tipo: "janssen_em_kenvue", detalhe: `alias "${v.alias}" no grupo Kenvue contém "JANSSEN"` });
    }
  }

  // PFIZER nunca com associação INTEGRAL, em nenhum grupo — só via RegraGrupoLaboratorialPorCnp.
  for (const g of config.grupos) {
    for (const v of g.fabricantesIntegrais.filter((s) => /PFIZER/i.test(s))) {
      bloqueios.push({
        tipo: "pfizer_integral_proibido",
        detalhe: `fabricante integral "${v}" no grupo "${g.nome}" contém "PFIZER" — Pfizer só pode entrar por RegraGrupoLaboratorialPorCnp (CNP a CNP), nunca por associação integral.`,
      });
    }
  }

  // Regras por CNP: só ATIVO + validadoManualmente=true; grupo tem de existir; CNP não duplicado para grupos diferentes.
  const nomesGrupoValidos = new Set(config.grupos.map((g) => g.nomeNormalizado));
  const regrasValidas: RegraCnpConfig[] = [];
  const regrasIgnoradas: RegraCnpConfig[] = [];
  const grupoPorCnp = new Map<number, string>();
  for (const r of regras.regras) {
    if (r.estado !== "ATIVO" || r.validadoManualmente !== true) {
      regrasIgnoradas.push(r);
      continue;
    }
    if (!nomesGrupoValidos.has(r.grupoLaboratorialNomeNormalizado)) {
      bloqueios.push({ tipo: "regra_cnp_sem_grupo_correspondente", detalhe: `CNP ${r.cnp}: grupo "${r.grupoLaboratorialNomeNormalizado}" não existe na configuração de grupos.` });
      continue;
    }
    const grupoAnterior = grupoPorCnp.get(r.cnp);
    if (grupoAnterior && grupoAnterior !== r.grupoLaboratorialNomeNormalizado) {
      bloqueios.push({
        tipo: "cnp_duas_regras_grupos_diferentes",
        detalhe: `CNP ${r.cnp} tem regras activas para grupos diferentes: "${grupoAnterior}" e "${r.grupoLaboratorialNomeNormalizado}".`,
      });
      continue;
    }
    grupoPorCnp.set(r.cnp, r.grupoLaboratorialNomeNormalizado);
    regrasValidas.push(r);
  }

  return { bloqueios, regrasValidas, regrasIgnoradas };
}

// ── Passo 2: resolução dos fabricantes integrais contra os REAIS de garantia ──

export type FabricanteReal = { id: string; nomeNormalizado: string };

export type ResolucaoFabricanteIntegral = {
  grupoNomeNormalizado: string;
  candidato: string;
  acao: "resolvido" | "inexistente" | "ambiguo";
  fabricanteId?: string;
  fabricanteNomeNormalizado?: string;
  correspondencias?: string[];
};

/**
 * Resolve cada string de `fabricantesIntegrais` contra os Fabricante
 * REAIS de garantia — sempre por igualdade EXACTA de
 * `normalizeFabricanteCanonico` (nunca `compararNomesTolerandoComprimento`,
 * que é só para sugerir candidatos a validação humana, nunca para
 * associação automática — ver lib/catalog/grupo-laboratorial-normalizers.ts).
 *
 * A busca é feita por `findMany` (nunca `findUnique`) deliberadamente:
 * mesmo com `Fabricante.nomeNormalizado` `@unique` no schema, este
 * código não ASSUME essa garantia — verifica-a, e trata mais de uma
 * correspondência como "ambíguo", bloqueando em vez de escolher.
 *
 * Depois de resolver, verifica também que NENHUM fabricante REAL
 * (post-resolução, por id) ficou reclamado por mais de um grupo — a
 * mesma verificação de `validarConfigEstrutural`, mas ao nível da
 * entidade resolvida, não da string crua.
 */
export function resolverFabricantesIntegrais(
  config: ConfigGruposIniciais,
  fabricantesReais: readonly FabricanteReal[],
): { resolucoes: ResolucaoFabricanteIntegral[]; bloqueios: Bloqueio[] } {
  const porNomeNormalizado = new Map<string, FabricanteReal[]>();
  for (const f of fabricantesReais) {
    const norm = normalizeFabricanteCanonico(f.nomeNormalizado);
    if (!norm) continue;
    const lista = porNomeNormalizado.get(norm) ?? [];
    lista.push(f);
    porNomeNormalizado.set(norm, lista);
  }

  const resolucoes: ResolucaoFabricanteIntegral[] = [];
  const bloqueios: Bloqueio[] = [];
  const fabricanteIdParaGrupo = new Map<string, string>();

  for (const g of config.grupos) {
    for (const nomeCru of g.fabricantesIntegrais) {
      // normalizeGrupoLaboratorialAlias (120 chars) só para não descartar
      // por comprimento ANTES de procurar — a procura em si só tem
      // chaves <=60 (identidade real de Fabricante), por isso um
      // candidato >60 caracteres canónicos nunca encontra correspondência,
      // cai correctamente em "inexistente", nunca inventa uma.
      const norm = normalizeGrupoLaboratorialAlias(nomeCru);
      const candidatos = norm ? (porNomeNormalizado.get(norm) ?? []) : [];

      if (candidatos.length === 0) {
        resolucoes.push({ grupoNomeNormalizado: g.nomeNormalizado, candidato: nomeCru, acao: "inexistente" });
        bloqueios.push({ tipo: "fabricante_inexistente", detalhe: `grupo "${g.nome}": "${nomeCru}" não corresponde a nenhum Fabricante real de garantia.` });
        continue;
      }
      if (candidatos.length > 1) {
        resolucoes.push({
          grupoNomeNormalizado: g.nomeNormalizado,
          candidato: nomeCru,
          acao: "ambiguo",
          correspondencias: candidatos.map((c) => c.id),
        });
        bloqueios.push({
          tipo: "fabricante_ambiguo",
          detalhe: `grupo "${g.nome}": "${nomeCru}" corresponde a ${candidatos.length} Fabricante reais distintos (${candidatos.map((c) => c.id).join(", ")}) — não escolhido automaticamente.`,
        });
        continue;
      }

      const fab = candidatos[0]!;
      resolucoes.push({
        grupoNomeNormalizado: g.nomeNormalizado,
        candidato: nomeCru,
        acao: "resolvido",
        fabricanteId: fab.id,
        fabricanteNomeNormalizado: fab.nomeNormalizado,
      });

      const grupoAnterior = fabricanteIdParaGrupo.get(fab.id);
      if (grupoAnterior && grupoAnterior !== g.nomeNormalizado) {
        bloqueios.push({
          tipo: "fabricante_resolvido_em_dois_grupos",
          detalhe: `Fabricante real "${fab.nomeNormalizado}" (${fab.id}) resolve, a partir de candidatos distintos, tanto para "${grupoAnterior}" como para "${g.nome}".`,
        });
      } else {
        fabricanteIdParaGrupo.set(fab.id, g.nomeNormalizado);
      }
    }
  }

  return { resolucoes, bloqueios };
}

// ── Passo 3: plano CRIAR/ATUALIZAR/INALTERADO contra o estado actual da base ──

export type AcaoPlano = "criar" | "atualizar" | "inalterado";
export type ItemPlano = { chave: string; acao: AcaoPlano; detalhe?: string };

export type PlanoGrupos = { itens: ItemPlano[]; idsPorNomeNormalizado: Map<string, string> };

export function planearGrupos(
  config: ConfigGruposIniciais,
  existentes: ReadonlyArray<{ id: string; nomeNormalizado: string; nome: string }>,
): PlanoGrupos {
  const existentePorNome = new Map(existentes.map((g) => [g.nomeNormalizado, g]));
  const itens: ItemPlano[] = [];
  // ids "pendentes" (cuid real só existe depois do create, na transação) —
  // para grupos NOVOS o plano usa um marcador `novo:<nomeNormalizado>`,
  // resolvido para o id real dentro da transação, antes de aliases/associações.
  const idsPorNomeNormalizado = new Map<string, string>();

  for (const g of config.grupos) {
    const atual = existentePorNome.get(g.nomeNormalizado);
    if (!atual) {
      itens.push({ chave: g.nomeNormalizado, acao: "criar" });
      idsPorNomeNormalizado.set(g.nomeNormalizado, `novo:${g.nomeNormalizado}`);
    } else {
      idsPorNomeNormalizado.set(g.nomeNormalizado, atual.id);
      if (atual.nome !== g.nome) {
        itens.push({ chave: g.nomeNormalizado, acao: "atualizar", detalhe: `nome: "${atual.nome}" → "${g.nome}"` });
      } else {
        itens.push({ chave: g.nomeNormalizado, acao: "inalterado" });
      }
    }
  }
  return { itens, idsPorNomeNormalizado };
}

export function planearAliases(
  config: ConfigGruposIniciais,
  existentes: ReadonlyArray<{ grupoLaboratorialId: string; aliasNormalizado: string; alias: string; origem: string | null }>,
  idsGrupoPorNomeNormalizado: ReadonlyMap<string, string>,
): ItemPlano[] {
  const existentePorChave = new Map(existentes.map((a) => [`${a.grupoLaboratorialId}::${a.aliasNormalizado}`, a]));
  const itens: ItemPlano[] = [];

  for (const g of config.grupos) {
    const grupoId = idsGrupoPorNomeNormalizado.get(g.nomeNormalizado)!;
    for (const a of g.aliases) {
      const aliasNormalizado = normalizeGrupoLaboratorialAlias(a.alias) ?? a.aliasNormalizado;
      const chave = `${grupoId}::${aliasNormalizado}`;
      const atual = existentePorChave.get(chave);
      if (!atual) {
        itens.push({ chave: `${g.nomeNormalizado}/${a.alias}`, acao: "criar" });
      } else {
        const origemConfig = a.origem ?? null;
        const diff = atual.alias !== a.alias || atual.origem !== origemConfig;
        itens.push({ chave: `${g.nomeNormalizado}/${a.alias}`, acao: diff ? "atualizar" : "inalterado", detalhe: diff ? "alias/origem diferentes" : undefined });
      }
    }
  }
  return itens;
}

export function planearFabricantesIntegrais(
  resolucoes: readonly ResolucaoFabricanteIntegral[],
  existentes: ReadonlyArray<{ fabricanteId: string; grupoLaboratorialId: string; evidencia: string | null }>,
  idsGrupoPorNomeNormalizado: ReadonlyMap<string, string>,
): ItemPlano[] {
  const existentePorFabricanteId = new Map(existentes.map((e) => [e.fabricanteId, e]));
  // Dedup: candidatos diferentes do MESMO grupo podem resolver para o
  // mesmo fabricanteId (ex.: "Mylan, Lda." e "MYLAN LDA" no mesmo grupo).
  const jaPlaneados = new Set<string>();
  const itens: ItemPlano[] = [];

  for (const r of resolucoes) {
    if (r.acao !== "resolvido" || !r.fabricanteId) continue;
    if (jaPlaneados.has(r.fabricanteId)) continue;
    jaPlaneados.add(r.fabricanteId);

    const grupoId = idsGrupoPorNomeNormalizado.get(r.grupoNomeNormalizado)!;
    const evidenciaNova = `Associação integral curada (scripts/data/grupos-laboratoriais-iniciais-garantia.json), candidato "${r.candidato}".`;
    const atual = existentePorFabricanteId.get(r.fabricanteId);
    if (!atual) {
      itens.push({ chave: `${r.grupoNomeNormalizado}/${r.fabricanteNomeNormalizado}`, acao: "criar" });
    } else if (atual.grupoLaboratorialId !== grupoId) {
      // Conflito com o ESTADO da base — não deveria acontecer se os
      // bloqueios de resolverFabricantesIntegrais já apanharam tudo, mas
      // é verificado de novo aqui como segunda camada (a base pode ter
      // sido curada manualmente antes deste script existir).
      itens.push({ chave: `${r.grupoNomeNormalizado}/${r.fabricanteNomeNormalizado}`, acao: "atualizar", detalhe: "CONFLITO: já associado a outro grupo na base — ver bloqueios" });
    } else {
      const diff = atual.evidencia !== evidenciaNova;
      itens.push({ chave: `${r.grupoNomeNormalizado}/${r.fabricanteNomeNormalizado}`, acao: diff ? "atualizar" : "inalterado", detalhe: diff ? "evidência diferente" : undefined });
    }
  }
  return itens;
}

export function planearRegrasCnp(
  regrasValidas: readonly RegraCnpConfig[],
  existentes: ReadonlyArray<{ cnp: number; grupoLaboratorialId: string; evidencia: string | null; estado: string; validadoManualmente: boolean; fabricanteLegalEsperadoId: string | null }>,
  idsGrupoPorNomeNormalizado: ReadonlyMap<string, string>,
  fabricanteEsperadoIdPorCnp: ReadonlyMap<number, string | null>,
): { itens: ItemPlano[]; bloqueios: Bloqueio[] } {
  const existentePorCnp = new Map(existentes.map((e) => [e.cnp, e]));
  const itens: ItemPlano[] = [];
  const bloqueios: Bloqueio[] = [];

  for (const r of regrasValidas) {
    const grupoId = idsGrupoPorNomeNormalizado.get(r.grupoLaboratorialNomeNormalizado)!;
    const fabricanteEsperadoId = fabricanteEsperadoIdPorCnp.get(r.cnp) ?? null;
    const atual = existentePorCnp.get(r.cnp);
    if (!atual) {
      itens.push({ chave: String(r.cnp), acao: "criar" });
    } else if (atual.grupoLaboratorialId !== grupoId) {
      bloqueios.push({
        tipo: "cnp_conflito_com_base",
        detalhe: `CNP ${r.cnp}: a base já tem uma regra para outro grupo (${atual.grupoLaboratorialId}) — configuração pede "${r.grupoLaboratorialNomeNormalizado}".`,
      });
      itens.push({ chave: String(r.cnp), acao: "atualizar", detalhe: "CONFLITO com a base — ver bloqueios" });
    } else {
      const diff =
        atual.evidencia !== (r.evidencia ?? null) ||
        atual.estado !== r.estado ||
        atual.validadoManualmente !== r.validadoManualmente ||
        atual.fabricanteLegalEsperadoId !== fabricanteEsperadoId;
      itens.push({ chave: String(r.cnp), acao: diff ? "atualizar" : "inalterado", detalhe: diff ? "metadados diferentes" : undefined });
    }
  }
  return { itens, bloqueios };
}

// ── Resultado ────────────────────────────────────────────────────────

export type ResultadoImportacao = {
  bloqueios: Bloqueio[];
  regrasIgnoradasNaoValidadas: number;
  grupos: PlanoGrupos["itens"];
  aliases: ItemPlano[];
  fabricantesIntegrais: { resolucoes: ResolucaoFabricanteIntegral[]; plano: ItemPlano[] };
  regrasCnp: ItemPlano[];
  totais: {
    grupos: { criar: number; atualizar: number; inalterados: number };
    aliases: { criar: number; atualizar: number; inalterados: number };
    fabricantesIntegrais: { resolvidos: number; inexistentes: number; ambiguos: number; criar: number; atualizar: number; inalterados: number };
    regrasCnp: { criar: number; atualizar: number; inalterados: number; ignoradasNaoValidadas: number };
    bloqueios: number;
  };
  escritas: number;
  zeroAlteracoesProdutoFabricante: true;
};

function contarAcoes(itens: readonly ItemPlano[]): { criar: number; atualizar: number; inalterados: number } {
  return {
    criar: itens.filter((i) => i.acao === "criar").length,
    atualizar: itens.filter((i) => i.acao === "atualizar").length,
    inalterados: itens.filter((i) => i.acao === "inalterado").length,
  };
}

/**
 * Núcleo — extraído de `main()` para ser chamável directamente com um
 * `PrismaClient` já ligado (testes), sem passar por
 * `resolverAlvo`/`confirmarAlvoGarantia`/`confirmarConfigGarantia` (essas
 * são especificamente para o caminho de produção). `main()` continua a
 * ser o único caminho que escreve na VPS real, e só depois das TRÊS
 * camadas de confirmação.
 */
export async function importarGruposLaboratoriais(
  prisma: PrismaParaImportacaoGrupos,
  input: { config: ConfigGruposIniciais; regras: RegrasCnpFicheiro; apply: boolean },
): Promise<ResultadoImportacao> {
  const { config, regras, apply } = input;

  const { bloqueios: bloqueiosEstruturais, regrasValidas, regrasIgnoradas } = validarConfigEstrutural(config, regras);

  const fabricantesReais = await prisma.fabricante.findMany({ select: { id: true, nomeNormalizado: true } });
  const { resolucoes, bloqueios: bloqueiosResolucao } = resolverFabricantesIntegrais(config, fabricantesReais);

  const [gruposExistentes, aliasesExistentes, gruposFabricanteExistentes, regrasExistentes] = await Promise.all([
    prisma.grupoLaboratorial.findMany({ select: { id: true, nomeNormalizado: true, nome: true } }),
    prisma.grupoLaboratorialAlias.findMany({ select: { grupoLaboratorialId: true, aliasNormalizado: true, alias: true, origem: true } }),
    prisma.grupoLaboratorialFabricante.findMany({ select: { fabricanteId: true, grupoLaboratorialId: true, evidencia: true } }),
    prisma.regraGrupoLaboratorialPorCnp.findMany({
      select: { cnp: true, grupoLaboratorialId: true, evidencia: true, estado: true, validadoManualmente: true, fabricanteLegalEsperadoId: true },
    }),
  ]);

  const planoGrupos = planearGrupos(config, gruposExistentes);
  const planoAliases = planearAliases(config, aliasesExistentes, planoGrupos.idsPorNomeNormalizado);
  const planoFabricantesIntegrais = planearFabricantesIntegrais(resolucoes, gruposFabricanteExistentes, planoGrupos.idsPorNomeNormalizado);

  const fabricantesPorNomeNormalizado = new Map<string, FabricanteReal>();
  for (const f of fabricantesReais) {
    const norm = normalizeFabricanteCanonico(f.nomeNormalizado);
    if (norm) fabricantesPorNomeNormalizado.set(norm, f);
  }
  const fabricanteEsperadoIdPorCnp = new Map<number, string | null>();
  for (const r of regrasValidas) {
    const norm = r.fabricanteLegalEsperadoNormalizado ? normalizeFabricanteCanonico(r.fabricanteLegalEsperadoNormalizado) : null;
    fabricanteEsperadoIdPorCnp.set(r.cnp, norm ? (fabricantesPorNomeNormalizado.get(norm)?.id ?? null) : null);
  }
  const { itens: planoRegrasCnp, bloqueios: bloqueiosRegras } = planearRegrasCnp(
    regrasValidas,
    regrasExistentes,
    planoGrupos.idsPorNomeNormalizado,
    fabricanteEsperadoIdPorCnp,
  );

  const bloqueios = [...bloqueiosEstruturais, ...bloqueiosResolucao, ...bloqueiosRegras];

  let escritas = 0;
  if (apply && bloqueios.length === 0) {
    await prisma.$transaction(async (tx) => {
      const idsReaisPorNomeNormalizado = new Map(planoGrupos.idsPorNomeNormalizado);

      // 1. Grupos — primeiro, porque tudo o resto tem FK para GrupoLaboratorial.
      for (const g of config.grupos) {
        const item = planoGrupos.itens.find((i) => i.chave === g.nomeNormalizado)!;
        if (item.acao === "inalterado") continue;
        const grupo = await tx.grupoLaboratorial.upsert({
          where: { nomeNormalizado: g.nomeNormalizado },
          create: { nome: g.nome, nomeNormalizado: g.nomeNormalizado },
          update: { nome: g.nome },
        });
        idsReaisPorNomeNormalizado.set(g.nomeNormalizado, grupo.id);
        escritas++;
      }

      // 2. Aliases.
      for (const g of config.grupos) {
        const grupoId = idsReaisPorNomeNormalizado.get(g.nomeNormalizado)!;
        for (const a of g.aliases) {
          const item = planoAliases.find((i) => i.chave === `${g.nomeNormalizado}/${a.alias}`)!;
          if (item.acao === "inalterado") continue;
          const aliasNormalizado = normalizeGrupoLaboratorialAlias(a.alias) ?? a.aliasNormalizado;
          await tx.grupoLaboratorialAlias.upsert({
            where: { grupoLaboratorialId_aliasNormalizado: { grupoLaboratorialId: grupoId, aliasNormalizado } },
            create: { grupoLaboratorialId: grupoId, alias: a.alias, aliasNormalizado, origem: a.origem ?? null },
            update: { alias: a.alias, origem: a.origem ?? null },
          });
          escritas++;
        }
      }

      // 3. Associações integrais.
      const jaEscritos = new Set<string>();
      for (const r of resolucoes) {
        if (r.acao !== "resolvido" || !r.fabricanteId) continue;
        if (jaEscritos.has(r.fabricanteId)) continue;
        jaEscritos.add(r.fabricanteId);
        const item = planoFabricantesIntegrais.find((i) => i.chave === `${r.grupoNomeNormalizado}/${r.fabricanteNomeNormalizado}`)!;
        if (item.acao === "inalterado") continue;
        const grupoId = idsReaisPorNomeNormalizado.get(r.grupoNomeNormalizado)!;
        const evidencia = `Associação integral curada (scripts/data/grupos-laboratoriais-iniciais-garantia.json), candidato "${r.candidato}".`;
        await tx.grupoLaboratorialFabricante.upsert({
          where: { fabricanteId: r.fabricanteId },
          create: { fabricanteId: r.fabricanteId, grupoLaboratorialId: grupoId, tipoAssociacao: "INEQUIVOCA", evidencia, validadoManualmente: true },
          update: { grupoLaboratorialId: grupoId, evidencia, validadoManualmente: true },
        });
        escritas++;
      }

      // 4. Regras por CNP.
      for (const r of regrasValidas) {
        const item = planoRegrasCnp.find((i) => i.chave === String(r.cnp))!;
        if (item.acao === "inalterado") continue;
        const grupoId = idsReaisPorNomeNormalizado.get(r.grupoLaboratorialNomeNormalizado)!;
        const fabricanteLegalEsperadoId = fabricanteEsperadoIdPorCnp.get(r.cnp) ?? null;
        await tx.regraGrupoLaboratorialPorCnp.upsert({
          where: { cnp: r.cnp },
          create: {
            cnp: r.cnp,
            grupoLaboratorialId: grupoId,
            fabricanteLegalEsperadoId,
            evidencia: r.evidencia ?? null,
            estado: r.estado,
            validadoManualmente: r.validadoManualmente,
          },
          update: {
            grupoLaboratorialId: grupoId,
            fabricanteLegalEsperadoId,
            evidencia: r.evidencia ?? null,
            estado: r.estado,
            validadoManualmente: r.validadoManualmente,
          },
        });
        escritas++;
      }
    });
  }

  return {
    bloqueios,
    regrasIgnoradasNaoValidadas: regrasIgnoradas.length,
    grupos: planoGrupos.itens,
    aliases: planoAliases,
    fabricantesIntegrais: { resolucoes, plano: planoFabricantesIntegrais },
    regrasCnp: planoRegrasCnp,
    totais: {
      grupos: contarAcoes(planoGrupos.itens),
      aliases: contarAcoes(planoAliases),
      fabricantesIntegrais: {
        resolvidos: resolucoes.filter((r) => r.acao === "resolvido").length,
        inexistentes: resolucoes.filter((r) => r.acao === "inexistente").length,
        ambiguos: resolucoes.filter((r) => r.acao === "ambiguo").length,
        ...contarAcoes(planoFabricantesIntegrais),
      },
      regrasCnp: { ...contarAcoes(planoRegrasCnp), ignoradasNaoValidadas: regrasIgnoradas.length },
      bloqueios: bloqueios.length,
    },
    escritas: apply && bloqueios.length === 0 ? escritas : 0,
    zeroAlteracoesProdutoFabricante: true,
  };
}

// ── main ─────────────────────────────────────────────────────────────

function hashFicheiro(conteudo: string): string {
  return createHash("sha256").update(conteudo, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const slugPedido = argv.find((a) => a.startsWith("--tenant="))?.slice("--tenant=".length);
  if (slugPedido !== TENANT_TRAVADO) {
    console.error(
      `\n[fatal] Este script está travado ao tenant "${TENANT_TRAVADO}" — recebeu --tenant=${slugPedido ?? "(nenhum)"}.\n` +
        `A importação de grupos laboratoriais é exclusiva do tenant garantia.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(argv);

  let alvo: AlvoDb;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n[fatal] ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  confirmarAlvoGarantia(alvo);

  const configTexto = readFileSync(args.configPath, "utf8");
  const regrasTexto = readFileSync(args.regrasPath, "utf8");
  const config = JSON.parse(configTexto) as ConfigGruposIniciais;
  const regras = JSON.parse(regrasTexto) as RegrasCnpFicheiro;
  confirmarConfigGarantia(config, regras);

  const dryRun = !args.apply;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = ${dryRun ? "on" : "off"}`);

    console.log("═".repeat(78));
    console.log("Importação de grupos laboratoriais — tenant garantia");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  Modo: ${dryRun ? "DRY-RUN" : "APPLY"}`);
    console.log(`  config: ${args.configPath}`);
    console.log(`  regras: ${args.regrasPath}`);

    const resultado = await importarGruposLaboratoriais(prisma, { config, regras, apply: args.apply });

    if (resultado.bloqueios.length > 0) {
      console.log(`\n⚠ ${resultado.bloqueios.length} bloqueio(s) — apply recusado independentemente da flag:`);
      for (const b of resultado.bloqueios) console.log(`  [${b.tipo}] ${b.detalhe}`);
    }

    console.log(`\nGrupos:              criar ${resultado.totais.grupos.criar}, atualizar ${resultado.totais.grupos.atualizar}, inalterados ${resultado.totais.grupos.inalterados}`);
    console.log(`Aliases:              criar ${resultado.totais.aliases.criar}, atualizar ${resultado.totais.aliases.atualizar}, inalterados ${resultado.totais.aliases.inalterados}`);
    console.log(
      `Fabricantes integrais: resolvidos ${resultado.totais.fabricantesIntegrais.resolvidos}, inexistentes ${resultado.totais.fabricantesIntegrais.inexistentes}, ambíguos ${resultado.totais.fabricantesIntegrais.ambiguos} — criar ${resultado.totais.fabricantesIntegrais.criar}, atualizar ${resultado.totais.fabricantesIntegrais.atualizar}, inalterados ${resultado.totais.fabricantesIntegrais.inalterados}`,
    );
    console.log(
      `Regras CNP:           criar ${resultado.totais.regrasCnp.criar}, atualizar ${resultado.totais.regrasCnp.atualizar}, inalteradas ${resultado.totais.regrasCnp.inalterados}, ignoradas (não validadas) ${resultado.totais.regrasCnp.ignoradasNaoValidadas}`,
    );
    console.log(`\nEscritas: ${resultado.escritas}`);

    const relatorioParaDisco = {
      geradoEm: new Date().toISOString(),
      tenant: alvo.tenant,
      base: alvo.base,
      modo: dryRun ? "DRY-RUN" : "APPLY",
      configHash: hashFicheiro(configTexto),
      regrasHash: hashFicheiro(regrasTexto),
      ...resultado,
      fabricantesInexistentes: resultado.fabricantesIntegrais.resolucoes.filter((r) => r.acao === "inexistente"),
      fabricantesAmbiguos: resultado.fabricantesIntegrais.resolucoes.filter((r) => r.acao === "ambiguo"),
      conflitos: resultado.bloqueios.filter((b) => b.tipo.includes("conflito") || b.tipo.includes("dois_grupos")),
    };
    escreverAtomico(args.relatorioPath, JSON.stringify(relatorioParaDisco, null, 2));
    console.log(`\nRelatório gravado em: ${args.relatorioPath}`);

    if (args.apply && resultado.bloqueios.length > 0) {
      console.error(`\n[fatal] --apply pedido, mas ${resultado.bloqueios.length} bloqueio(s) impediram qualquer escrita. Ver relatório.`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]importar-grupos-laboratoriais-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
