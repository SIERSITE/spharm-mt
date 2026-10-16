/**
 * lib/catalogo/fabricante-ficha.ts
 *
 * Alterar / criar o FABRICANTE de um artigo a partir da ficha do artigo — serviço puro de BD (cliente Prisma do TENANT injetado):
 * as regras vivem aqui, a Server Action (`app/stock/artigo/fabricante-actions.ts`) só autentica e autoriza.
 *
 * ── Regras ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * · Normalização e criação reutilizam as funções que o catálogo/manutenção em massa já usam (`normalizeFabricanteCanonico`,
 *   `resolverOuCriarFabricante`) — nenhuma lógica nova de normalização.
 * · Criar «novo» fabricante recusa DUPLICADOS: um canónico igual a um `Fabricante.nomeNormalizado` existente, ou um nome que já é alias
 *   inequívoco de um fabricante, obriga a escolher o existente. Semelhantes (não idênticos) só são sugeridos.
 * · A alteração é AUTORITATIVA: marca `Produto.validadoManualmente = true` — a protecção que a sincronização diária (ERP,
 *   `applyErpCatalogFields` → `decidirFabricanteBaseline`/`decidirFabricanteSilveira`) e o enriquecimento automático
 *   (`catalog-persistence`) já respeitam em todos os tenants — e regista `camposManuais ∋ "fabricante"` como PROVENIÊNCIA (só serve para
 *   dizer que ESTE campo foi escrito à mão e para a ação «voltar a permitir atualização do ERP»; quem bloqueia é `validadoManualmente`).
 *   O snapshot do ERP (`ProdutoFarmacia.fabricanteErpAtual`) continua a ser atualizado em cada sincronização, protegido ou não.
 * · Criação do fabricante + associação ao produto + auditoria: UMA transação — se qualquer passo falha, não fica fabricante órfão
 *   nem auditoria sem alteração.
 * · Concorrência otimista: a alteração só se aplica se o fabricante atual ainda for o que o utilizador viu.
 * · Isolamento: tudo é feito no cliente Prisma do tenant corrente; nada toca no control plane nem noutros tenants.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { normalizeFabricanteCanonico } from "@/lib/catalog-normalizers";
import { resolverOuCriarFabricante } from "@/lib/catalogo/resolver-fabricante";

export const MARCADOR_FABRICANTE_MANUAL = "fabricante";
export const ORIGEM_AUDITORIA_FICHA = "FICHA_ARTIGO";
export const MAX_NOME_FABRICANTE = 60;

export type FabricanteOpcao = { id: string; nome: string };

// ─────────────────────────────────────────────────────────────────────────
// Semelhança (pura)
// ─────────────────────────────────────────────────────────────────────────

const SUFIXOS_EMPRESA = new Set(["LDA", "SA", "SL", "LTD", "LIMITED", "GMBH", "INC", "LLC", "AG", "BV", "NV", "SRL", "SARL", "PLC"]);

function nucleo(canonico: string): string {
  return canonico
    .split(/[ &-]+/)
    .filter((t) => t && !SUFIXOS_EMPRESA.has(t))
    .join(" ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Fabricantes existentes PARECIDOS (não idênticos) com o nome indicado — só sugestão para o utilizador decidir. */
export function sugerirSemelhantes(nomeCru: string, existentes: readonly FabricanteOpcao[], limite = 5): Array<FabricanteOpcao & { motivo: string }> {
  const canonico = normalizeFabricanteCanonico(nomeCru);
  if (!canonico) return [];
  const alvo = nucleo(canonico);
  if (alvo.length < 2) return [];
  const tokensAlvo = new Set(alvo.split(" "));
  const resultado: Array<FabricanteOpcao & { motivo: string; pontos: number }> = [];
  for (const f of existentes) {
    const cf = normalizeFabricanteCanonico(f.nome);
    if (!cf) continue;
    const nf = nucleo(cf);
    if (!nf) continue;
    if (cf === canonico) continue; // idêntico: é duplicado, não «semelhante»
    let motivo: string | null = null;
    let pontos = 0;
    if (nf === alvo) {
      motivo = "mesmo nome sem a forma jurídica";
      pontos = 100;
    } else if ((nf.length >= 4 && alvo.includes(nf)) || (alvo.length >= 4 && nf.includes(alvo))) {
      motivo = "um nome contém o outro";
      pontos = 80;
    } else {
      const tokensF = new Set(nf.split(" "));
      const inter = [...tokensAlvo].filter((t) => tokensF.has(t)).length;
      const uniao = new Set([...tokensAlvo, ...tokensF]).size;
      const jaccard = uniao > 0 ? inter / uniao : 0;
      const d = levenshtein(alvo, nf);
      if (jaccard >= 0.5) {
        motivo = "palavras em comum";
        pontos = 60 + jaccard * 20;
      } else if (d <= Math.max(1, Math.floor(Math.max(alvo.length, nf.length) * 0.15))) {
        motivo = "grafia muito parecida";
        pontos = 70 - d;
      }
    }
    if (motivo) resultado.push({ id: f.id, nome: f.nome, motivo, pontos });
  }
  return resultado.sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome, "pt-PT")).slice(0, limite).map(({ id, nome, motivo }) => ({ id, nome, motivo }));
}

// ─────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────

/** Pesquisa de fabricantes ATIVOS do tenant (autocomplete): por nome normalizado e por alias; sem distinguir acentos/maiúsculas. */
export async function pesquisarFabricantes(prisma: Prisma.TransactionClient, termo: string, limite = 15): Promise<FabricanteOpcao[]> {
  const canonico = normalizeFabricanteCanonico(termo) ?? termo.trim().toUpperCase();
  if (!canonico || canonico.length < 1) return [];
  const rows = await prisma.fabricante.findMany({
    where: {
      estado: "ATIVO",
      OR: [{ nomeNormalizado: { contains: canonico, mode: "insensitive" } }, { aliases: { some: { aliasNome: { contains: termo.trim(), mode: "insensitive" } } } }],
    },
    select: { id: true, nomeNormalizado: true },
    orderBy: { nomeNormalizado: "asc" },
    take: limite,
  });
  return rows.map((r) => ({ id: r.id, nome: r.nomeNormalizado }));
}

export type PreparacaoCriacao =
  | { ok: false; codigo: "invalido"; mensagem: string }
  | {
      ok: true;
      /** O nome com que o fabricante seria criado (normalização canónica do catálogo). */
      canonico: string;
      /** Já existe EXACTAMENTE este canónico — criar está bloqueado, usar o existente. */
      duplicado: FabricanteOpcao | null;
      /** O nome já é alias de um fabricante existente (inequívoco) — criar está bloqueado, usar esse. */
      viaAlias: FabricanteOpcao | null;
      semelhantes: Array<FabricanteOpcao & { motivo: string }>;
    };

export async function prepararCriacaoFabricante(prisma: Prisma.TransactionClient, nomeCru: string): Promise<PreparacaoCriacao> {
  const canonico = normalizeFabricanteCanonico(nomeCru);
  if (!canonico) return { ok: false, codigo: "invalido", mensagem: `Nome inválido (2 a ${MAX_NOME_FABRICANTE} caracteres, com letras ou números).` };

  const exato = await prisma.fabricante.findUnique({ where: { nomeNormalizado: canonico }, select: { id: true, nomeNormalizado: true } });
  let viaAlias: FabricanteOpcao | null = null;
  if (!exato) {
    const aliases = await prisma.fabricanteAlias.findMany({
      where: { OR: [{ aliasNome: nomeCru.trim() }, { aliasNome: canonico }] },
      select: { fabricante: { select: { id: true, nomeNormalizado: true } } },
    });
    const distintos = new Map(aliases.map((a) => [a.fabricante.id, a.fabricante.nomeNormalizado]));
    if (distintos.size === 1) {
      const [id, nome] = [...distintos.entries()][0];
      viaAlias = { id, nome };
    }
  }
  const todos = await prisma.fabricante.findMany({ where: { estado: "ATIVO" }, select: { id: true, nomeNormalizado: true } });
  const semelhantes = sugerirSemelhantes(nomeCru, todos.map((t) => ({ id: t.id, nome: t.nomeNormalizado })));
  return {
    ok: true,
    canonico,
    duplicado: exato ? { id: exato.id, nome: exato.nomeNormalizado } : null,
    viaAlias,
    semelhantes,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Escrita (transacional)
// ─────────────────────────────────────────────────────────────────────────

export type PedidoAplicar = {
  cnp: number;
  /** Fabricante que o utilizador VIU na ficha (`null` = sem fabricante): a alteração só se aplica se ainda for este. */
  fabricanteAnteriorId: string | null;
  destino: { tipo: "existente"; fabricanteId: string } | { tipo: "novo"; nome: string };
  /** O utilizador confirmou no diálogo. Sem isto nada é escrito. */
  confirmado: boolean;
  ator: { id: string };
  tenant: string;
};

export type ResultadoAplicar =
  | {
      ok: true;
      fabricante: FabricanteOpcao;
      criado: boolean;
      anterior: { id: string | null; nome: string | null };
      /** Protecção manual passou a estar ativa (sempre `true` depois de aplicar). */
      protegido: true;
      alterado: boolean;
    }
  | { ok: false; codigo: "nao_confirmado" | "sem_produto" | "invalido" | "duplicado" | "conflito" | "fabricante_inexistente" | "ambiguo"; mensagem: string; existente?: FabricanteOpcao };

function addMarcador(campos: string[]): string[] {
  return campos.includes(MARCADOR_FABRICANTE_MANUAL) ? campos : [...campos, MARCADOR_FABRICANTE_MANUAL];
}

class Recusa extends Error {
  constructor(public readonly resultado: Extract<ResultadoAplicar, { ok: false }>) {
    super(resultado.mensagem);
  }
}

export async function aplicarFabricanteFicha(prisma: PrismaClient, pedido: PedidoAplicar): Promise<ResultadoAplicar> {
  if (!pedido.confirmado) return { ok: false, codigo: "nao_confirmado", mensagem: "A alteração tem de ser confirmada." };
  try {
    return await prisma.$transaction(async (tx) => {
      const produto = await tx.produto.findUnique({
        where: { cnp: pedido.cnp },
        select: { id: true, cnp: true, fabricanteId: true, fabricante: { select: { nomeNormalizado: true } }, validadoManualmente: true, camposManuais: true },
      });
      if (!produto) throw new Recusa({ ok: false, codigo: "sem_produto", mensagem: "Artigo não encontrado." });
      if (produto.fabricanteId !== pedido.fabricanteAnteriorId) {
        throw new Recusa({ ok: false, codigo: "conflito", mensagem: "O fabricante deste artigo mudou entretanto. Reabra a ficha e tente de novo." });
      }

      // Destino
      let destino: FabricanteOpcao;
      let criado = false;
      if (pedido.destino.tipo === "existente") {
        const f = await tx.fabricante.findUnique({ where: { id: pedido.destino.fabricanteId }, select: { id: true, nomeNormalizado: true, estado: true } });
        if (!f || f.estado !== "ATIVO") throw new Recusa({ ok: false, codigo: "fabricante_inexistente", mensagem: "O fabricante escolhido não existe neste catálogo." });
        destino = { id: f.id, nome: f.nomeNormalizado };
      } else {
        const prep = await prepararCriacaoFabricante(tx, pedido.destino.nome);
        if (!prep.ok) throw new Recusa({ ok: false, codigo: "invalido", mensagem: prep.mensagem });
        if (prep.duplicado) throw new Recusa({ ok: false, codigo: "duplicado", mensagem: `Já existe o fabricante «${prep.duplicado.nome}». Selecione-o em vez de criar outro.`, existente: prep.duplicado });
        if (prep.viaAlias) throw new Recusa({ ok: false, codigo: "duplicado", mensagem: `«${pedido.destino.nome.trim()}» já é um nome alternativo de «${prep.viaAlias.nome}». Selecione-o em vez de criar outro.`, existente: prep.viaAlias });
        const r = await resolverOuCriarFabricante(tx, pedido.destino.nome, { criarSeInexistente: true });
        if (r.status === "ambiguo") throw new Recusa({ ok: false, codigo: "ambiguo", mensagem: "Nome de fabricante ambíguo (corresponde a vários existentes)." });
        if (r.status !== "resolvido") throw new Recusa({ ok: false, codigo: "invalido", mensagem: "Nome de fabricante inválido." });
        criado = r.criado;
        destino = { id: r.fabricanteId, nome: prep.canonico };
      }

      const alterado = produto.fabricanteId !== destino.id;
      const campos = addMarcador(produto.camposManuais);
      await tx.produto.update({
        where: { id: produto.id },
        data: {
          fabricanteId: destino.id,
          // Proteção que a sincronização diária (ERP) e o enriquecimento automático respeitam — ver o cabeçalho.
          validadoManualmente: true,
          camposManuais: campos,
          dataAtualizacao: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: pedido.ator.id,
          action: "produto.fabricante.alterado",
          entity: "Produto",
          entityId: produto.id,
          metaJson: JSON.stringify({
            origem: ORIGEM_AUDITORIA_FICHA,
            tenant: pedido.tenant,
            produtoId: produto.id,
            cnp: produto.cnp,
            fabricanteAnterior: { id: produto.fabricanteId, nome: produto.fabricante?.nomeNormalizado ?? null },
            fabricanteNovo: destino,
            fabricanteCriadoNoFluxo: criado,
            alterado,
            protecaoManual: { antes: produto.validadoManualmente, depois: true },
          }),
        },
      });
      return { ok: true as const, fabricante: destino, criado, anterior: { id: produto.fabricanteId, nome: produto.fabricante?.nomeNormalizado ?? null }, protegido: true as const, alterado };
    });
  } catch (err) {
    if (err instanceof Recusa) return err.resultado;
    throw err;
  }
}

export type PedidoPermitirErp = {
  cnp: number;
  /** Aplicar também, já, o valor atual do ERP (só se as farmácias concordam num único fabricante). Por omissão NÃO altera o fabricante. */
  aplicarValorErp: boolean;
  confirmado: boolean;
  ator: { id: string };
  tenant: string;
};

export type ResultadoPermitirErp =
  | { ok: true; fabricante: FabricanteOpcao | null; alterado: boolean }
  | { ok: false; codigo: "nao_confirmado" | "sem_produto" | "sem_protecao" | "erp_indisponivel"; mensagem: string };

/** «Voltar a permitir atualização automática pelo ERP»: retira a proteção; não toca no fabricante salvo `aplicarValorErp`. */
export async function permitirAtualizacaoErp(prisma: PrismaClient, pedido: PedidoPermitirErp): Promise<ResultadoPermitirErp> {
  if (!pedido.confirmado) return { ok: false, codigo: "nao_confirmado", mensagem: "A alteração tem de ser confirmada." };
  return prisma.$transaction(async (tx): Promise<ResultadoPermitirErp> => {
    const produto = await tx.produto.findUnique({
      where: { cnp: pedido.cnp },
      select: { id: true, cnp: true, fabricanteId: true, fabricante: { select: { nomeNormalizado: true } }, validadoManualmente: true, camposManuais: true },
    });
    if (!produto) return { ok: false, codigo: "sem_produto", mensagem: "Artigo não encontrado." };
    if (!produto.camposManuais.includes(MARCADOR_FABRICANTE_MANUAL)) {
      return { ok: false, codigo: "sem_protecao", mensagem: "O fabricante deste artigo não foi definido manualmente na ficha." };
    }

    let novo: FabricanteOpcao | null = produto.fabricanteId ? { id: produto.fabricanteId, nome: produto.fabricante?.nomeNormalizado ?? "" } : null;
    let alterado = false;
    if (pedido.aplicarValorErp) {
      const erp = await tx.produtoFarmacia.findMany({ where: { produtoId: produto.id, fabricanteErpAtual: { not: null } }, select: { fabricanteErpAtual: true } });
      const distintos = [...new Set(erp.map((e) => e.fabricanteErpAtual).filter((v): v is string => !!v))];
      if (distintos.length !== 1) return { ok: false, codigo: "erp_indisponivel", mensagem: distintos.length === 0 ? "Não há fabricante do ERP registado para este artigo." : "As farmácias reportam fabricantes diferentes no ERP — não é possível escolher um automaticamente." };
      const r = await resolverOuCriarFabricante(tx, distintos[0], { criarSeInexistente: true });
      if (r.status !== "resolvido") return { ok: false, codigo: "erp_indisponivel", mensagem: "Não foi possível resolver o fabricante do ERP." };
      novo = { id: r.fabricanteId, nome: distintos[0] };
      alterado = r.fabricanteId !== produto.fabricanteId;
    }

    await tx.produto.update({
      where: { id: produto.id },
      data: {
        validadoManualmente: false,
        camposManuais: produto.camposManuais.filter((c) => c !== MARCADOR_FABRICANTE_MANUAL),
        ...(alterado && novo ? { fabricanteId: novo.id } : {}),
        dataAtualizacao: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: pedido.ator.id,
        action: "produto.fabricante.protecao_removida",
        entity: "Produto",
        entityId: produto.id,
        metaJson: JSON.stringify({
          origem: ORIGEM_AUDITORIA_FICHA,
          tenant: pedido.tenant,
          produtoId: produto.id,
          cnp: produto.cnp,
          fabricanteAnterior: { id: produto.fabricanteId, nome: produto.fabricante?.nomeNormalizado ?? null },
          fabricanteNovo: novo,
          fabricanteCriadoNoFluxo: false,
          alterado,
          aplicouValorErp: pedido.aplicarValorErp,
          protecaoManual: { antes: produto.validadoManualmente, depois: false },
        }),
      },
    });
    return { ok: true, fabricante: novo, alterado };
  });
}
