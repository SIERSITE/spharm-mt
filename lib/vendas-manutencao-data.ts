/**
 * lib/vendas-manutencao-data.ts
 *
 * Camada de dados da Manutenção de Vendas — a ÚNICA peça deste módulo
 * que fala com o Prisma. A lógica de peso/distribuição/validação vive
 * em `lib/vendas-manutencao/*.ts`, pura e sem BD (ver
 * scripts/tests/test-vendas-manutencao.ts).
 *
 * ── Isolamento do ledger real ─────────────────────────────────────────
 *
 * `VendaManutencao`/`VendaManutencaoCelula` nunca são lidas por
 * `lib/vendas-data.ts` nem por qualquer cálculo de peso histórico — a
 * única leitura de `VendaMensal` feita aqui é a de `pesoHistoricoPorFarmacia`,
 * e essa nunca toca nas tabelas de manutenção. É a garantia estrutural
 * da secção 1.2 do pedido ("as próprias vendas introduzidas através
 * desta manutenção nunca podem entrar no cálculo de peso histórico de
 * futuras manutenções").
 *
 * A integração no MAPA de Vendas (ler estas tabelas a partir de
 * `lib/vendas-data.ts`) está deliberadamente FORA deste ficheiro —
 * pendente da decisão sobre valorização monetária (ver a análise à
 * parte). Este módulo só cobre a criação/edição/consulta da manutenção
 * em si.
 */
import "server-only";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import {
  calcularPesosFarmacia,
  janelaHistoricaDozeMeses,
  type ResultadoPesos,
} from "./vendas-manutencao/peso";
import { distribuirPorMaiorResto, distribuirPorMeses } from "./vendas-manutencao/distribuicao";
import type {
  AvisoSemHistorico,
  CelulaManutencao,
  EstadoManutencao,
  ManutencaoDetalhe,
  ManutencaoResumo,
  OrigemDistribuicao,
  PropostaDistribuicao,
} from "./vendas-manutencao/tipos";

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── Peso histórico (leitura de VendaMensal — NUNCA de manutenção) ─────

type LinhaPesoBruta = { farmaciaId: string; qty: unknown };

async function pesoHistoricoPorFarmacia(
  prisma: PrismaClient,
  produtoId: string,
  farmaciaIds: readonly string[],
  anoRef: number,
  mesRef: number,
): Promise<ResultadoPesos> {
  const janela = janelaHistoricaDozeMeses(anoRef, mesRef);
  const startYM = janela.inicio.ano * 100 + janela.inicio.mes;
  const endYM = janela.fim.ano * 100 + janela.fim.mes;

  // Só "NORMAL" — vendas reais ao cliente (ver a nota grande em
  // lib/vendas-manutencao/peso.ts sobre porque excluir CREDITO/TRANSFERENCIA).
  const linhas = await prisma.$queryRaw<LinhaPesoBruta[]>`
    SELECT vm."farmaciaId" AS "farmaciaId",
           GREATEST(SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade)), 0)::float AS qty
    FROM "VendaMensal" vm
    WHERE vm."produtoId" = ${produtoId}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
      AND vm."naturezaVenda" = 'NORMAL'
      AND (vm.ano * 100 + vm.mes) BETWEEN ${startYM} AND ${endYM}
    GROUP BY vm."farmaciaId"
  `;

  return calcularPesosFarmacia(
    linhas.map((l) => ({ farmaciaId: l.farmaciaId, qty: toF(l.qty) })),
    farmaciaIds,
  );
}

// ─── Proposta automática (peso + distribuição pelos meses) ─────────────

export type FarmaciaRef = { id: string; nome: string };

export async function gerarPropostaAutomatica(
  prisma: PrismaClient,
  input: {
    produtoId: string;
    farmacias: readonly FarmaciaRef[];
    quantidadeTotal: number;
    numMeses: number;
    mesInicialAno: number;
    mesInicialMes: number;
  },
): Promise<PropostaDistribuicao> {
  const farmaciaIds = input.farmacias.map((f) => f.id);
  const { pesos, semHistoricoNenhum } = await pesoHistoricoPorFarmacia(
    prisma,
    input.produtoId,
    farmaciaIds,
    input.mesInicialAno,
    input.mesInicialMes,
  );

  const nomeById = new Map(input.farmacias.map((f) => [f.id, f.nome]));
  const farmaciasSemHistorico = pesos.filter((p) => !p.temHistorico).map((p) => p.farmaciaId);

  // Secção 1.7 — sem histórico nenhum: não inventar peso. A distribuição
  // por farmácia fica em partes IGUAIS só como PONTO DE PARTIDA editável
  // — nunca gravada sem o utilizador confirmar — e o aviso identifica
  // exactamente este caso para a UI bloquear a confirmação automática.
  const porFarmacia = semHistoricoNenhum
    ? distribuirPorMaiorResto(input.quantidadeTotal, pesos.map((p) => ({ chave: p.farmaciaId, peso: 1 })))
    : distribuirPorMaiorResto(input.quantidadeTotal, pesos.map((p) => ({ chave: p.farmaciaId, peso: p.peso })));

  const celulas: CelulaManutencao[] = porFarmacia.flatMap((parte) => {
    const porMes = distribuirPorMeses(
      parte.quantidade,
      input.mesInicialAno,
      input.mesInicialMes,
      input.numMeses,
    );
    return porMes.map((m) => ({
      farmaciaId: parte.chave,
      farmaciaNome: nomeById.get(parte.chave) ?? "—",
      ano: m.ano,
      mes: m.mes,
      quantidade: m.quantidade,
    }));
  });

  const aviso: AvisoSemHistorico | null = semHistoricoNenhum
    ? { tipo: "SEM_HISTORICO_NENHUM", farmaciasSemHistorico }
    : farmaciasSemHistorico.length > 0
      ? { tipo: "SEM_HISTORICO_PARCIAL", farmaciasSemHistorico }
      : null;

  return { celulas, aviso };
}

// ─── Mapeamento Prisma → tipos de domínio ──────────────────────────────

type ManutencaoComRelacoes = Prisma.VendaManutencaoGetPayload<{
  include: {
    produto: { select: { cnp: true; designacao: true } };
    criadoPor: { select: { nome: true } };
    atualizadoPor: { select: { nome: true } };
    celulas: { include: { farmacia: { select: { nome: true } } } };
  };
}>;

function paraResumo(m: ManutencaoComRelacoes): ManutencaoResumo {
  return {
    id: m.id,
    cnp: m.cnp,
    designacao: m.produto.designacao,
    quantidadeTotal: toF(m.quantidadeTotal),
    numMeses: m.numMeses,
    mesInicialAno: m.mesInicialAno,
    mesInicialMes: m.mesInicialMes,
    origemDistribuicao: m.origemDistribuicao as OrigemDistribuicao,
    estado: m.estado as EstadoManutencao,
    criadoPorNome: m.criadoPor.nome,
    atualizadoPorNome: m.atualizadoPor?.nome ?? null,
    dataCriacao: m.dataCriacao.toISOString(),
    dataAtualizacao: m.dataAtualizacao.toISOString(),
  };
}

function paraDetalhe(m: ManutencaoComRelacoes): ManutencaoDetalhe {
  return {
    ...paraResumo(m),
    produtoId: m.produtoId,
    celulas: m.celulas
      .map((c) => ({
        farmaciaId: c.farmaciaId,
        farmaciaNome: c.farmacia.nome,
        ano: c.ano,
        mes: c.mes,
        quantidade: toF(c.quantidade),
      }))
      .sort((a, b) => a.ano * 12 + a.mes - (b.ano * 12 + b.mes) || a.farmaciaNome.localeCompare(b.farmaciaNome, "pt-PT")),
  };
}

const INCLUDE_COMPLETO = {
  produto: { select: { cnp: true, designacao: true } },
  criadoPor: { select: { nome: true } },
  atualizadoPor: { select: { nome: true } },
  celulas: { include: { farmacia: { select: { nome: true as const } } } },
} as const;

// ─── CRUD ───────────────────────────────────────────────────────────────

export async function listarManutencoes(
  prisma: PrismaClient,
  opts?: { estado?: EstadoManutencao },
): Promise<ManutencaoResumo[]> {
  const rows = await prisma.vendaManutencao.findMany({
    where: opts?.estado ? { estado: opts.estado } : undefined,
    include: INCLUDE_COMPLETO,
    orderBy: { dataCriacao: "desc" },
  });
  return rows.map(paraResumo);
}

export async function obterManutencao(
  prisma: PrismaClient,
  id: string,
): Promise<ManutencaoDetalhe | null> {
  const row = await prisma.vendaManutencao.findUnique({
    where: { id },
    include: INCLUDE_COMPLETO,
  });
  return row ? paraDetalhe(row) : null;
}

/** Cria uma manutenção nova, com a distribuição já calculada (automática ou ajustada antes de confirmar). */
export async function criarManutencao(
  prisma: PrismaClient,
  input: {
    produtoId: string;
    cnp: number;
    quantidadeTotal: number;
    numMeses: number;
    mesInicialAno: number;
    mesInicialMes: number;
    origemDistribuicao: OrigemDistribuicao;
    celulas: readonly { farmaciaId: string; ano: number; mes: number; quantidade: number }[];
    criadoPorId: string;
  },
): Promise<string> {
  const criada = await prisma.vendaManutencao.create({
    data: {
      produtoId: input.produtoId,
      cnp: input.cnp,
      quantidadeTotal: input.quantidadeTotal,
      numMeses: input.numMeses,
      mesInicialAno: input.mesInicialAno,
      mesInicialMes: input.mesInicialMes,
      origemDistribuicao: input.origemDistribuicao,
      criadoPorId: input.criadoPorId,
      celulas: {
        create: input.celulas.map((c) => ({
          farmaciaId: c.farmaciaId,
          ano: c.ano,
          mes: c.mes,
          quantidade: c.quantidade,
        })),
      },
    },
    select: { id: true },
  });
  return criada.id;
}

/**
 * Substitui INTEIRAMENTE a distribuição de uma manutenção existente —
 * usado depois de um "Recalcular" explícito (secção 1.10: alterar
 * quantidade/nº meses/período inicial pode exigir uma nova proposta,
 * mas o recálculo é sempre um passo explícito dentro da manutenção,
 * nunca implícito na emissão do relatório). Volta a `origemDistribuicao:
 * "AUTOMATICA"` — é um cálculo fresco, não um ajuste manual.
 */
export async function substituirDistribuicao(
  prisma: PrismaClient,
  input: {
    id: string;
    quantidadeTotal: number;
    numMeses: number;
    mesInicialAno: number;
    mesInicialMes: number;
    celulas: readonly { farmaciaId: string; ano: number; mes: number; quantidade: number }[];
    atualizadoPorId: string;
  },
): Promise<void> {
  await prisma.$transaction([
    prisma.vendaManutencaoCelula.deleteMany({ where: { manutencaoId: input.id } }),
    prisma.vendaManutencao.update({
      where: { id: input.id },
      data: {
        quantidadeTotal: input.quantidadeTotal,
        numMeses: input.numMeses,
        mesInicialAno: input.mesInicialAno,
        mesInicialMes: input.mesInicialMes,
        origemDistribuicao: "AUTOMATICA",
        atualizadoPorId: input.atualizadoPorId,
        celulas: {
          create: input.celulas.map((c) => ({
            farmaciaId: c.farmaciaId,
            ano: c.ano,
            mes: c.mes,
            quantidade: c.quantidade,
          })),
        },
      },
    }),
  ]);
}

/**
 * Grava a matriz inteira tal como o utilizador a deixou depois de
 * ajustar células à mão (sem alterar quantidade/nº meses/período
 * inicial) — o chamador já validou a soma com `validarSomaTotal` antes
 * de chegar aqui. Marca `MANUAL_AJUSTADA`: a partir daqui, um cálculo
 * automático novo só volta a substituir isto com um "Recalcular"
 * explícito.
 */
export async function guardarCelulasAjustadas(
  prisma: PrismaClient,
  input: {
    id: string;
    celulas: readonly { farmaciaId: string; ano: number; mes: number; quantidade: number }[];
    atualizadoPorId: string;
  },
): Promise<void> {
  await prisma.$transaction([
    prisma.vendaManutencaoCelula.deleteMany({ where: { manutencaoId: input.id } }),
    prisma.vendaManutencao.update({
      where: { id: input.id },
      data: {
        origemDistribuicao: "MANUAL_AJUSTADA",
        atualizadoPorId: input.atualizadoPorId,
        celulas: {
          create: input.celulas.map((c) => ({
            farmaciaId: c.farmaciaId,
            ano: c.ano,
            mes: c.mes,
            quantidade: c.quantidade,
          })),
        },
      },
    }),
  ]);
}

/**
 * Anula uma manutenção — nunca DELETE físico. A partir do momento em
 * que `estado` deixa de ser `"ATIVA"`, deixa IMEDIATAMENTE de
 * contribuir para o mapa de Vendas (o filtro `estado: "ATIVA"` na
 * futura leitura do loader é suficiente; não há passo extra a fazer
 * aqui além de mudar o estado).
 */
export async function anularManutencao(
  prisma: PrismaClient,
  input: { id: string; atualizadoPorId: string },
): Promise<void> {
  await prisma.vendaManutencao.update({
    where: { id: input.id },
    data: { estado: "ANULADA", atualizadoPorId: input.atualizadoPorId },
  });
}
