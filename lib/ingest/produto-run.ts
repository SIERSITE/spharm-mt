/**
 * lib/ingest/produto-run.ts
 *
 * Fronteira de uma corrida de `products-upload` e defesa do sweep que
 * marca produtos como retirados.
 *
 * A regra que governa este ficheiro: **nenhuma decisão destrutiva pode
 * depender do relógio da farmácia**. O agent envia um `runStartedAt`
 * gerado em Windows; ele viaja no protocolo e é devolvido na resposta
 * para telemetria, mas não entra em nenhum WHERE que altere dados. O
 * corte é `IngestProdutoRun.startedAtServer`, escrito pelo relógio da
 * base no primeiro batch da corrida.
 *
 * O que o sweep pode fazer, e nada além disso:
 *   · `flagRetirado` false → true, na farmácia da corrida;
 *   · nunca true → false (isso é trabalho do UPSERT, quando o produto
 *     regressa ao ERP e vem no payload);
 *   · nunca toca em `Produto`, que é catálogo global e não pertence a
 *     esta farmácia.
 */

/** Corrida sem batches há mais do que isto é considerada abandonada. */
export const MINUTOS_ATE_ABANDONO = 60;

/**
 * Um sweep acima destes dois limiares ao mesmo tempo é recusado.
 *
 * Porque dois e não um: numa farmácia pequena, retirar 60% de 200 linhas
 * pode ser legítimo; retirar 60% de 18 000 nunca é. E um limiar só
 * absoluto bloquearia farmácias grandes em limpezas reais.
 *
 * O caso que isto impede: uma corrida que morre a meio entrega 500 dos
 * 18 416 produtos, o agent chama o finalize à mesma, e as 17 916 linhas
 * não tocadas passam a retiradas — em silêncio, com ok: true.
 */
export const SWEEP_MAX_FRACCAO = 0.2;
export const SWEEP_MIN_ABSOLUTO = 500;

export type DecisaoSweep =
  | { permitir: true; motivo: "dentro dos limites" }
  | { permitir: false; motivo: string };

/**
 * Decide se um sweep de `candidatos` linhas é plausível, dado o universo
 * activo da farmácia e quantos produtos a corrida entregou.
 *
 * Pura de propósito: é a peça que impede uma perda de dados silenciosa e
 * tem de ser testável sem base nenhuma.
 */
export function avaliarSweep(input: {
  candidatos: number;
  activosAntes: number;
  produtosRecebidos: number;
}): DecisaoSweep {
  const { candidatos, activosAntes, produtosRecebidos } = input;

  if (candidatos === 0) return { permitir: true, motivo: "dentro dos limites" };

  // Uma corrida que não entregou nada não observou o ERP, e ausência de
  // observação não é observação de ausência.
  if (produtosRecebidos === 0) {
    return { permitir: false, motivo: "a corrida não entregou nenhum produto — nada a concluir sobre o que falta" };
  }

  const fraccao = activosAntes > 0 ? candidatos / activosAntes : 0;
  if (candidatos >= SWEEP_MIN_ABSOLUTO && fraccao > SWEEP_MAX_FRACCAO) {
    return {
      permitir: false,
      motivo:
        `sweep anormal: ${candidatos} de ${activosAntes} linhas activas ` +
        `(${(fraccao * 100).toFixed(1)}%, limite ${(SWEEP_MAX_FRACCAO * 100).toFixed(0)}%) ` +
        `numa corrida que entregou ${produtosRecebidos} produtos`,
    };
  }

  return { permitir: true, motivo: "dentro dos limites" };
}

export type EstadoCorrida = { id: string; startedAtServer: Date; lastBatchAtServer: Date; estado: string };

/** Só o que estas funções precisam do cliente Prisma do tenant. */
type ClientePrisma = {
  ingestProdutoRun: {
    findFirst(args: unknown): Promise<EstadoCorrida | null>;
    create(args: unknown): Promise<{ id: string }>;
    update(args: unknown): Promise<unknown>;
  };
};

/**
 * Abre a corrida no primeiro batch e vai-a alimentando nos seguintes.
 * Devolve o id da corrida em curso.
 *
 * Concorrência: o índice único parcial garante uma só corrida ABERTA por
 * farmácia. Se dois batches tentarem criar ao mesmo tempo, um falha e
 * relê — a corrida do outro é tão válida como a sua.
 */
export async function abrirOuContinuarCorrida(
  prisma: ClientePrisma,
  farmaciaId: string,
  produtosNesteBatch: number,
): Promise<string> {
  const agora = new Date();
  const aberta = await prisma.ingestProdutoRun.findFirst({
    where: { farmaciaId, estado: "ABERTA" },
  });

  if (aberta && !corridaAbandonada(aberta, agora)) {
    await prisma.ingestProdutoRun.update({
      where: { id: aberta.id },
      data: {
        lastBatchAtServer: agora,
        produtosRecebidos: { increment: produtosNesteBatch },
      },
    });
    return aberta.id;
  }

  if (aberta) {
    // Ficou pendurada de uma execução que morreu. Fechá-la como
    // abandonada é o que liberta o índice único e evita que a corrida
    // nova herde um corte muito mais antigo do que a realidade.
    await prisma.ingestProdutoRun.update({
      where: { id: aberta.id },
      data: { estado: "ABANDONADA", finalizadaEm: agora },
    });
  }

  try {
    const nova = await prisma.ingestProdutoRun.create({
      data: { farmaciaId, produtosRecebidos: produtosNesteBatch },
    });
    return nova.id;
  } catch {
    // Corrida de outro batch concorrente ganhou. Usa-se essa.
    const existente = await prisma.ingestProdutoRun.findFirst({
      where: { farmaciaId, estado: "ABERTA" },
    });
    if (!existente) throw new Error("corrida ABERTA desapareceu entre a criação e a releitura");
    await prisma.ingestProdutoRun.update({
      where: { id: existente.id },
      data: {
        lastBatchAtServer: agora,
        produtosRecebidos: { increment: produtosNesteBatch },
      },
    });
    return existente.id;
  }
}

/**
 * Uma corrida aberta há muito tempo sem batches é lixo de uma execução
 * que morreu: continuar nela daria um corte mais antigo do que a corrida
 * real, e o sweep deixaria de detectar retirados.
 */
export function corridaAbandonada(corrida: EstadoCorrida, agora: Date): boolean {
  const minutos = (agora.getTime() - corrida.lastBatchAtServer.getTime()) / 60_000;
  return minutos > MINUTOS_ATE_ABANDONO;
}
