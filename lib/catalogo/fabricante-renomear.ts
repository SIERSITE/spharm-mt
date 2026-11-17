/**
 * lib/catalogo/fabricante-renomear.ts
 *
 * Corrigir o NOME de um fabricante existente (Stock › Artigo) — renomeação
 * ou consolidação num fabricante já existente — dentro de UM tenant.
 *
 * Sem `server-only` e com o Prisma INJECTADO, para os testes poderem correr
 * a lógica real contra uma base descartável. Quem decide permissão/tenant e
 * quem fornece o Prisma é a server action
 * (`app/stock/artigo/renomear-fabricante-actions.ts`); este módulo não lê
 * sessão nem headers.
 *
 * ── Isolamento entre tenants ──────────────────────────────────────────
 * Cada tenant tem a sua própria base de dados (ver `lib/tenant-registry.ts`)
 * e o `PrismaClient` recebido já é o do tenant do pedido. Nada aqui
 * atravessa bases: todas as leituras/escritas vão ao mesmo cliente, e o
 * fabricante a alterar é SEMPRE derivado do artigo (CNP) desse tenant —
 * nunca de um id vindo do browser.
 *
 * ── Semântica ─────────────────────────────────────────────────────────
 * `Fabricante.nomeNormalizado` é a chave canónica (única). O nome novo é
 * normalizado com `normalizeFabricanteCanonico` (a mesma função do ingest
 * do ERP e do enriquecimento), para que um nome escrito à mão e o mesmo
 * nome vindo do ERP convirjam.
 *
 *   RENOMEAR     o registo mantém o `id`; só muda `nomeNormalizado`. Todos
 *                os artigos ligados acompanham (nenhum `Produto` é tocado).
 *   CONSOLIDAR   o nome pretendido já existe noutro fabricante do tenant:
 *                os artigos passam para esse fabricante e o de origem fica
 *                INATIVO (nunca apagado — mesmo critério das unificações
 *                de fabricantes feitas por script).
 *
 * ── Protecção contra sincronizações ───────────────────────────────────
 * Reutiliza o que já existe, sem mexer nas regras do ERP:
 *   · RENOMEAR não muda `Produto.fabricanteId`: a Silveira nunca reescreve
 *     um fabricante já definido (`decidirFabricanteSilveira`) e a Garantia
 *     usa o baseline por farmácia+CNP (`decidirFabricanteBaseline`) — o ERP
 *     a repetir o nome antigo não é «mudança» e não escreve.
 *   · O NOME ANTIGO fica como `FabricanteAlias` do fabricante que fica.
 *     Só falta cobrir um caso: um CNP NOVO (sem fabricante) vindo do ERP com
 *     o nome antigo recriaria o fabricante antigo. Por isso o ingest resolve
 *     nomes por alias — SÓ nos tenants desta funcionalidade (opção
 *     `resolverFabricantePorAlias` de `applyErpCatalogFields`, ligada pelo
 *     endpoint com o tenant autenticado do agent). Os outros tenants
 *     mantêm exactamente o comportamento anterior.
 *   · NÃO se usa `validadoManualmente` em massa: essa marca congela a
 *     classificação, o enriquecimento e o catálogo global desses artigos
 *     (ver `escrita-classificacao.ts`, `knowledge-enrichment-runner.ts`),
 *     o que numa renomeação de centenas de artigos (Garantia está a
 *     classificar) seria um efeito colateral desproporcionado. A edição de
 *     UM artigo (`fabricante-ficha.ts`) continua a usá-la, como sempre.
 *
 * ── Atomicidade e auditoria ───────────────────────────────────────────
 * Tudo numa única transacção, INCLUINDO o registo em AuditLog: ou fica
 * tudo (alteração + auditoria) ou nada.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { normalizeFabricanteCanonico } from "@/lib/catalog-normalizers";

export const ACAO_AUDIT_RENOMEADO = "fabricante.renomeado";
export const ACAO_AUDIT_CONSOLIDADO = "fabricante.consolidado";
export const ORIGEM_AUDITORIA_RENOMEAR = "FICHA_ARTIGO_RENOMEAR_FABRICANTE";

export type ModoEdicaoFabricante = "RENOMEACAO" | "CONSOLIDACAO";

export type DestinoConsolidacao = {
  id: string;
  nome: string;
  estado: string;
  artigos: number;
};

export type AvaliacaoNome =
  | { estado: "invalido"; motivo: string }
  | { estado: "igual" }
  | { estado: "renomear"; novoNome: string }
  | { estado: "conflito"; novoNome: string; destino: DestinoConsolidacao };

export type PreviewEdicaoFabricante =
  | { ok: false; erro: string }
  | {
      ok: true;
      nomeAtual: string;
      novoNome: string | null;
      artigosAfetados: number;
      avaliacao: AvaliacaoNome;
    };

/**
 * Aliases a criar no fabricante que FICA quando outro é absorvido: o nome
 * do absorvido + os aliases que ele já tinha, sem repetições, sem o nome
 * do próprio vencedor e sem os que o vencedor já tem. Puro.
 */
export function aliasesParaConsolidar(input: {
  nomeVencedor: string;
  nomeAbsorvido: string;
  aliasesAbsorvido: readonly string[];
  aliasesVencedor: readonly string[];
}): string[] {
  const jaTem = new Set(input.aliasesVencedor);
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const nome of [input.nomeAbsorvido, ...input.aliasesAbsorvido]) {
    if (nome === input.nomeVencedor || jaTem.has(nome) || vistos.has(nome)) continue;
    vistos.add(nome);
    out.push(nome);
  }
  return out;
}

/** Cliente mínimo: aceita o PrismaClient inteiro e o cliente de transacção. */
type Db = Pick<
  PrismaClient,
  "fabricante" | "fabricanteAlias" | "produto" | "auditLog" | "grupoLaboratorialFabricante"
>;

/** Regras de nome, puras: vazio / ilegível → inválido; senão o canónico. */
export function normalizarNovoNome(
  nomeBruto: string | null | undefined,
): { ok: true; canonico: string } | { ok: false; motivo: string } {
  const aparado = (nomeBruto ?? "").trim();
  if (!aparado) return { ok: false, motivo: "O nome do fabricante não pode estar vazio." };
  const canonico = normalizeFabricanteCanonico(aparado);
  if (!canonico) {
    return {
      ok: false,
      motivo: "Nome inválido: use entre 2 e 120 caracteres, com letras ou números.",
    };
  }
  return { ok: true, canonico };
}

/**
 * Compara o nome pretendido com o fabricante actual e com o resto do
 * catálogo DO MESMO TENANT. Não escreve nada.
 */
export async function avaliarNovoNome(
  db: Db,
  fabricante: { id: string; nomeNormalizado: string },
  nomeBruto: string,
): Promise<AvaliacaoNome> {
  const n = normalizarNovoNome(nomeBruto);
  if (!n.ok) return { estado: "invalido", motivo: n.motivo };
  const novo = n.canonico;

  // Igual ao actual após aparar espaços/maiúsculas/acentos/pontuação.
  if (novo === fabricante.nomeNormalizado) return { estado: "igual" };

  // 1) Outro fabricante com exactamente esse nome canónico.
  const porNome = await db.fabricante.findUnique({
    where: { nomeNormalizado: novo },
    select: { id: true, nomeNormalizado: true, estado: true },
  });
  if (porNome && porNome.id !== fabricante.id) {
    return {
      estado: "conflito",
      novoNome: novo,
      destino: await resumoDestino(db, porNome),
    };
  }

  // 2) Outro fabricante que já tenha esse nome como alias (grafia
  //    equivalente registada: ex. um fabricante anteriormente consolidado).
  const porAlias = await db.fabricanteAlias.findFirst({
    where: { aliasNome: { in: [novo, nomeBruto.trim()] }, fabricanteId: { not: fabricante.id } },
    select: { fabricanteId: true },
  });
  if (porAlias) {
    const dono = await db.fabricante.findUnique({
      where: { id: porAlias.fabricanteId },
      select: { id: true, nomeNormalizado: true, estado: true },
    });
    if (dono) {
      return { estado: "conflito", novoNome: novo, destino: await resumoDestino(db, dono) };
    }
  }

  return { estado: "renomear", novoNome: novo };
}

async function resumoDestino(
  db: Db,
  f: { id: string; nomeNormalizado: string; estado: string },
): Promise<DestinoConsolidacao> {
  const artigos = await db.produto.count({ where: { fabricanteId: f.id } });
  return { id: f.id, nome: f.nomeNormalizado, estado: f.estado, artigos };
}

type FabricanteDoArtigo =
  | { ok: true; fabricante: { id: string; nomeNormalizado: string } }
  | { ok: false; erro: string };

async function fabricanteDoArtigo(db: Db, cnp: number): Promise<FabricanteDoArtigo> {
  const produto = await db.produto.findUnique({
    where: { cnp },
    select: {
      fabricanteId: true,
      fabricante: { select: { id: true, nomeNormalizado: true } },
    },
  });
  if (!produto) return { ok: false, erro: "Artigo não encontrado." };
  if (!produto.fabricante) return { ok: false, erro: "Este artigo não tem fabricante associado." };
  return { ok: true, fabricante: produto.fabricante };
}

/**
 * 1.º passo (sem escrita): o que vai acontecer se o utilizador confirmar.
 * Devolve nome actual, nome novo e nº de artigos afectados.
 */
export async function previsualizarEdicaoFabricante(
  db: Db,
  input: { cnp: number; novoNome: string },
): Promise<PreviewEdicaoFabricante> {
  const base = await fabricanteDoArtigo(db, input.cnp);
  if (!base.ok) return { ok: false, erro: base.erro };
  const { fabricante } = base;

  const avaliacao = await avaliarNovoNome(db, fabricante, input.novoNome);
  const artigosAfetados = await db.produto.count({ where: { fabricanteId: fabricante.id } });
  return {
    ok: true,
    nomeAtual: fabricante.nomeNormalizado,
    novoNome: "novoNome" in avaliacao ? avaliacao.novoNome : null,
    artigosAfetados,
    avaliacao,
  };
}

export type ResultadoEdicaoFabricante =
  | {
      ok: true;
      modo: ModoEdicaoFabricante;
      nomeAnterior: string;
      nomeNovo: string;
      artigosAfetados: number;
      fabricanteId: string;
    }
  | { ok: false; codigo: "ARTIGO" | "GRUPO" | "INVALIDO" | "IGUAL" | "CONFLITO" | "SEM_CONFLITO" | "DESATUALIZADO"; erro: string };

/**
 * 2.º passo: aplica. REVALIDA tudo no servidor (nunca confia no que o
 * browser mostrou) e exige `artigosConfirmados` igual ao número real de
 * artigos no momento de gravar — se entretanto mudou (sincronização,
 * outro utilizador) recusa e pede nova confirmação.
 *
 * `modo` é o que o utilizador confirmou: uma consolidação nunca acontece
 * sem `CONSOLIDACAO` explícito, e um pedido `RENOMEACAO` contra um nome que
 * já existe é recusado (não cria duplicado, não consolida sozinho).
 */
export async function aplicarEdicaoFabricante(
  prisma: PrismaClient,
  input: {
    cnp: number;
    novoNome: string;
    modo: ModoEdicaoFabricante;
    artigosConfirmados: number;
    actorId: string | null;
    tenantSlug: string;
  },
): Promise<ResultadoEdicaoFabricante> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const db = tx as unknown as Db;
        const base = await fabricanteDoArtigo(db, input.cnp);
        if (!base.ok) return { ok: false, codigo: "ARTIGO", erro: base.erro } as const;
        const { fabricante } = base;

        const avaliacao = await avaliarNovoNome(db, fabricante, input.novoNome);
        if (avaliacao.estado === "invalido") {
          return { ok: false, codigo: "INVALIDO", erro: avaliacao.motivo } as const;
        }
        if (avaliacao.estado === "igual") {
          return {
            ok: false,
            codigo: "IGUAL",
            erro: "O novo nome é igual ao atual (ignorando espaços e maiúsculas/minúsculas).",
          } as const;
        }
        if (input.modo === "RENOMEACAO" && avaliacao.estado === "conflito") {
          return {
            ok: false,
            codigo: "CONFLITO",
            erro: `Já existe o fabricante "${avaliacao.destino.nome}" neste tenant. Confirme a consolidação para juntar os artigos nele.`,
          } as const;
        }
        if (input.modo === "CONSOLIDACAO" && avaliacao.estado !== "conflito") {
          return {
            ok: false,
            codigo: "SEM_CONFLITO",
            erro: "Não existe nenhum fabricante com esse nome para consolidar.",
          } as const;
        }

        if (avaliacao.estado === "conflito") {
          // Garantia: a pertença a um grupo laboratorial é por fabricante.
          // Juntar dois fabricantes de grupos diferentes (ou um com grupo e
          // outro sem) mudaria o grupo dos artigos movidos — isso é uma
          // decisão da manutenção de grupos, não de uma correção de nome.
          const [gOrigem, gDestino] = await Promise.all([
            db.grupoLaboratorialFabricante.findUnique({ where: { fabricanteId: fabricante.id }, select: { grupoLaboratorialId: true } }),
            db.grupoLaboratorialFabricante.findUnique({ where: { fabricanteId: avaliacao.destino.id }, select: { grupoLaboratorialId: true } }),
          ]);
          if ((gOrigem?.grupoLaboratorialId ?? null) !== (gDestino?.grupoLaboratorialId ?? null)) {
            return {
              ok: false,
              codigo: "GRUPO",
              erro: "Os dois fabricantes pertencem a grupos laboratoriais diferentes (ou só um tem grupo). Resolva primeiro a pertença a grupos; a consolidação foi recusada para não alterar a classificação.",
            } as const;
          }
        }

        const artigos = await db.produto.count({ where: { fabricanteId: fabricante.id } });
        if (artigos !== input.artigosConfirmados) {
          return {
            ok: false,
            codigo: "DESATUALIZADO",
            erro: `O número de artigos mudou entretanto (${input.artigosConfirmados} → ${artigos}). Reveja e confirme novamente.`,
          } as const;
        }

        const nomeAnterior = fabricante.nomeNormalizado;
        const quando = new Date();

        if (avaliacao.estado === "renomear") {
          await db.fabricante.update({
            where: { id: fabricante.id },
            data: { nomeNormalizado: avaliacao.novoNome },
          });
          // O nome novo não pode continuar também como alias do próprio.
          await db.fabricanteAlias.deleteMany({
            where: { fabricanteId: fabricante.id, aliasNome: avaliacao.novoNome },
          });
          // O nome antigo fica como alias: sincronizações que o repitam
          // resolvem para este fabricante em vez de recriarem o antigo.
          await db.fabricanteAlias.upsert({
            where: {
              fabricanteId_aliasNome: { fabricanteId: fabricante.id, aliasNome: nomeAnterior },
            },
            create: { fabricanteId: fabricante.id, aliasNome: nomeAnterior },
            update: {},
          });
          await escreverAuditoria(db, {
            action: ACAO_AUDIT_RENOMEADO,
            actorId: input.actorId,
            fabricanteId: fabricante.id,
            meta: {
              tenant: input.tenantSlug,
              origem: ORIGEM_AUDITORIA_RENOMEAR,
              modo: "RENOMEACAO",
              fabricanteAnterior: nomeAnterior,
              fabricanteNovo: avaliacao.novoNome,
              artigosAfetados: artigos,
              cnpOrigem: input.cnp,
              em: quando.toISOString(),
            },
          });
          return {
            ok: true,
            modo: "RENOMEACAO",
            nomeAnterior,
            nomeNovo: avaliacao.novoNome,
            artigosAfetados: artigos,
            fabricanteId: fabricante.id,
          } as const;
        }

        // ── Consolidação ──────────────────────────────────────────────
        const destino = avaliacao.destino;
        const [aliasesOrigem, aliasesDestino] = await Promise.all([
          db.fabricanteAlias.findMany({
            where: { fabricanteId: fabricante.id },
            select: { aliasNome: true },
          }),
          db.fabricanteAlias.findMany({
            where: { fabricanteId: destino.id },
            select: { aliasNome: true },
          }),
        ]);
        const aliasesACriar = aliasesParaConsolidar({
          nomeVencedor: destino.nome,
          nomeAbsorvido: nomeAnterior,
          aliasesAbsorvido: aliasesOrigem.map((a) => a.aliasNome),
          aliasesVencedor: aliasesDestino.map((a) => a.aliasNome),
        });

        // Por fabricanteId (e não por lista de ids): é o conjunto exacto
        // que foi contado e confirmado, sem listas gigantes num IN(...).
        // Inclui validados manualmente — a confirmação do utilizador cobre-os.
        // Ids movidos, para o AuditLog permitir reverter com exactidão.
        const idsMovidos = (
          await db.produto.findMany({ where: { fabricanteId: fabricante.id }, select: { id: true } })
        ).map((p) => p.id);
        const mover = await db.produto.updateMany({
          where: { fabricanteId: fabricante.id },
          data: { fabricanteId: destino.id },
        });
        for (const aliasNome of aliasesACriar) {
          await db.fabricanteAlias.upsert({
            where: { fabricanteId_aliasNome: { fabricanteId: destino.id, aliasNome } },
            create: { fabricanteId: destino.id, aliasNome },
            update: {},
          });
        }
        await db.fabricanteAlias.deleteMany({ where: { fabricanteId: fabricante.id } });
        await db.fabricante.update({
          where: { id: fabricante.id },
          data: { estado: "INATIVO" },
        });
        if (destino.estado !== "ATIVO") {
          await db.fabricante.update({ where: { id: destino.id }, data: { estado: "ATIVO" } });
        }
        await escreverAuditoria(db, {
          action: ACAO_AUDIT_CONSOLIDADO,
          actorId: input.actorId,
          fabricanteId: fabricante.id,
          meta: {
            tenant: input.tenantSlug,
            origem: ORIGEM_AUDITORIA_RENOMEAR,
            modo: "CONSOLIDACAO",
            fabricanteAnterior: nomeAnterior,
            fabricanteNovo: destino.nome,
            fabricanteOrigemId: fabricante.id,
            fabricanteDestinoId: destino.id,
            artigosAfetados: mover.count,
            produtoIdsMovidos: idsMovidos,
            cnpOrigem: input.cnp,
            em: quando.toISOString(),
          },
        });
        return {
          ok: true,
          modo: "CONSOLIDACAO",
          nomeAnterior,
          nomeNovo: destino.nome,
          artigosAfetados: mover.count,
          fabricanteId: destino.id,
        } as const;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    // Corrida: alguém criou o mesmo nome entre a avaliação e o UPDATE.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false,
        codigo: "CONFLITO",
        erro: "Entretanto passou a existir um fabricante com esse nome. Reveja e tente novamente.",
      };
    }
    throw err;
  }
}

async function escreverAuditoria(
  db: Db,
  a: { action: string; actorId: string | null; fabricanteId: string; meta: Record<string, unknown> },
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: a.actorId,
      action: a.action,
      entity: "Fabricante",
      entityId: a.fabricanteId,
      metaJson: JSON.stringify(a.meta),
    },
  });
}
