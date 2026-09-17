/**
 * lib/vendas-manutencao-data.ts
 *
 * Camada de dados da Manutenção de Vendas — a ÚNICA peça deste módulo
 * que fala com o Prisma. A lógica de peso/distribuição/validação/
 * valorização vive em `lib/vendas-manutencao/*.ts`, pura e sem BD (ver
 * scripts/tests/test-vendas-manutencao.ts).
 *
 * ── Isolamento do ledger real ─────────────────────────────────────────
 *
 * `VendaManutencao*` nunca são lidas por nenhum cálculo de peso
 * histórico — a única leitura de `VendaMensal` feita aqui é a de
 * `pesoHistoricoPorFarmacia`, e essa nunca toca nas tabelas de
 * manutenção. É a garantia estrutural da secção 1.2 do pedido ("as
 * próprias vendas introduzidas através desta manutenção nunca podem
 * entrar no cálculo de peso histórico de futuras manutenções").
 *
 * ── PVP de referência: capturado UMA vez, nunca no recálculo ─────────
 *
 * `obterPvpReferenciaAtual` (lê `ProdutoFarmacia.pvp` de HOJE) só é
 * chamada por `gerarPropostaCompleta` — o caminho de CRIAÇÃO. O
 * caminho de RECÁLCULO (`calcularDistribuicaoQuantidades`) nunca lê
 * `ProdutoFarmacia`: recebe os `VendaManutencaoFarmacia.pvpReferencia`
 * já persistidos como dado de entrada e não os toca. É a garantia
 * estrutural da secção 5 do pedido ("recalcular apenas a distribuição
 * → manter o PVP de referência original... nunca acontecer
 * silenciosamente").
 *
 * ── Testabilidade ─────────────────────────────────────────────────────
 *
 * Sem `import "server-only"` de propósito — mesma convenção de
 * `lib/vendas-data.ts`/`lib/margens-data.ts`: um `*-data.ts` cujo único
 * IO é Prisma fica testável via `tsx` com um Prisma falso (ver
 * scripts/tests/test-vendas-manutencao.ts), sem depender do shim que só
 * o pipeline do Next resolve. As guardas reais (sessão, permissão)
 * vivem nas server actions que chamam isto (app/vendas/manutencao/actions.ts),
 * nunca aqui.
 */
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
  FarmaciaComPvpReferencia,
  ManutencaoDetalhe,
  ManutencaoResumo,
  OrigemDistribuicao,
  PropostaCompleta,
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

// ─── PVP de referência (leitura de ProdutoFarmacia — SÓ na criação) ────

/**
 * O PVP de HOJE de `ProdutoFarmacia`, por farmácia — snapshot a
 * capturar na criação. `null` quando a farmácia não tem PVP válido
 * (nunca 0 substituído em silêncio — secção 6 do pedido).
 */
export async function obterPvpReferenciaAtual(
  prisma: PrismaClient,
  produtoId: string,
  farmacias: readonly FarmaciaRef[],
): Promise<FarmaciaComPvpReferencia[]> {
  const rows = await prisma.produtoFarmacia.findMany({
    where: { produtoId, farmaciaId: { in: farmacias.map((f) => f.id) } },
    select: { farmaciaId: true, pvp: true },
  });
  const pvpPorFarmacia = new Map(rows.map((r) => [r.farmaciaId, r.pvp]));
  return farmacias.map((f) => {
    const bruto = pvpPorFarmacia.get(f.id);
    // Nunca 0 (nem negativo) como PVP de referência — a mesma regra de
    // "ausente" que `custoDaFarmacia`/`utilizavel` já aplicam a PMC/PUC
    // noutros relatórios: um 0 do ERP normalmente significa "não sei",
    // nunca "grátis".
    const pvp = bruto === null || bruto === undefined ? null : toF(bruto);
    return {
      farmaciaId: f.id,
      farmaciaNome: f.nome,
      pvpReferencia: pvp !== null && pvp > 0 ? pvp : null,
    };
  });
}

// ─── Distribuição (peso + meses) — usada na criação E no recálculo ─────

export type FarmaciaRef = { id: string; nome: string };

/**
 * Calcula SÓ a distribuição de quantidades (peso por farmácia +
 * repartição pelos meses) — nunca toca em PVP. Usada tanto na criação
 * (seguida de `obterPvpReferenciaAtual`, ver `gerarPropostaCompleta`)
 * como no recálculo de uma manutenção existente (onde o PVP de
 * referência já persistido tem de ficar exactamente como estava).
 */
export async function calcularDistribuicaoQuantidades(
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

/**
 * A proposta COMPLETA para uma manutenção NOVA — distribuição +
 * captura fresca do PVP de referência. Nunca usada para recalcular uma
 * manutenção existente (aí, `calcularDistribuicaoQuantidades` sozinha
 * — ver a nota no topo do ficheiro).
 */
export async function gerarPropostaCompleta(
  prisma: PrismaClient,
  input: {
    produtoId: string;
    farmacias: readonly FarmaciaRef[];
    quantidadeTotal: number;
    numMeses: number;
    mesInicialAno: number;
    mesInicialMes: number;
  },
): Promise<PropostaCompleta> {
  const [distribuicao, farmaciasPvp] = await Promise.all([
    calcularDistribuicaoQuantidades(prisma, input),
    obterPvpReferenciaAtual(prisma, input.produtoId, input.farmacias),
  ]);
  return { ...distribuicao, farmaciasPvp };
}

// ─── Mapeamento Prisma → tipos de domínio ──────────────────────────────

type ManutencaoComRelacoes = Prisma.VendaManutencaoGetPayload<{
  include: {
    produto: { select: { cnp: true; designacao: true } };
    criadoPor: { select: { nome: true } };
    atualizadoPor: { select: { nome: true } };
    celulas: { include: { farmacia: { select: { nome: true } } } };
    farmaciasPvp: { include: { farmacia: { select: { nome: true } } } };
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
    farmaciasPvp: m.farmaciasPvp
      .map((f) => ({
        farmaciaId: f.farmaciaId,
        farmaciaNome: f.farmacia.nome,
        pvpReferencia: f.pvpReferencia === null ? null : toF(f.pvpReferencia),
      }))
      .sort((a, b) => a.farmaciaNome.localeCompare(b.farmaciaNome, "pt-PT")),
  };
}

const INCLUDE_COMPLETO = {
  produto: { select: { cnp: true, designacao: true } },
  criadoPor: { select: { nome: true } },
  atualizadoPor: { select: { nome: true } },
  celulas: { include: { farmacia: { select: { nome: true as const } } } },
  farmaciasPvp: { include: { farmacia: { select: { nome: true as const } } } },
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

/**
 * Cria uma manutenção nova — distribuição + PVP de referência gravados
 * juntos, na mesma transacção. É a ÚNICA operação que escreve
 * `VendaManutencaoFarmacia`; depois de criada, esses valores nunca mais
 * são tocados por um recálculo (só uma futura acção explícita de
 * "actualizar preços", fora desta entrega).
 */
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
    farmaciasPvp: readonly { farmaciaId: string; pvpReferencia: number | null }[];
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
      farmaciasPvp: {
        create: input.farmaciasPvp.map((f) => ({
          farmaciaId: f.farmaciaId,
          pvpReferencia: f.pvpReferencia,
        })),
      },
    },
    select: { id: true },
  });
  return criada.id;
}

/**
 * Substitui a DISTRIBUIÇÃO de uma manutenção existente — usado depois
 * de um "Recalcular" explícito (secção 1.10/5: alterar quantidade/nº
 * meses/período inicial pode exigir uma nova proposta, mas o recálculo
 * é sempre um passo explícito, nunca implícito na emissão do
 * relatório). Volta a `origemDistribuicao: "AUTOMATICA"` — é um
 * cálculo fresco, não um ajuste manual.
 *
 * NUNCA toca em `VendaManutencaoFarmacia` — o PVP de referência
 * original fica exactamente como estava (secção 5: "recalcular apenas
 * a distribuição → manter o PVP de referência original").
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
 *
 * NUNCA toca em `VendaManutencaoFarmacia` — o PVP de referência da
 * célula editada continua o mesmo (secção 4: "o valor bruto dessa
 * célula deve ser recalculado usando o mesmo PVP de referência
 * persistido, e não o PVP actual" — como o valor bruto nunca é
 * armazenado, mas sim recalculado a partir do PVP de referência
 * inalterado, isto é automático).
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
 * leitura do loader é suficiente; não há passo extra a fazer aqui além
 * de mudar o estado).
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
