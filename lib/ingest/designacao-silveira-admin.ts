/**
 * lib/ingest/designacao-silveira-admin.ts
 *
 * Lógica pura/DB dos dois utilitários operacionais da autoridade da
 * designação (scripts/diagnostics/designacao-silveira-diagnostico.ts e
 * scripts/admin/definir-codigo-farmacia-designacao.ts) — separada dos
 * scripts para ser testável sem control plane.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  ENV_CODIGO_ANF_DESIGNACAO,
  normalizarCodigoANF,
  resolverAutoridadeDesignacao,
  type EstadoAutoridadeDesignacao,
} from "@/lib/ingest/designacao-silveira";

export type LinhaFarmaciaDiagnostico = {
  id: string;
  nome: string;
  codigoANF: string | null;
  estado: string;
  produtosNaFarmacia: number;
};

export type DiagnosticoDesignacao = {
  tenant: string;
  variavelDefinida: boolean;
  codigoConfigurado: string;
  farmacias: LinhaFarmaciaDiagnostico[];
  resolucao: EstadoAutoridadeDesignacao;
  /** Linhas de texto com o que fazer, vazio se está tudo bem. */
  accoes: string[];
};

/** READ-ONLY: só `SELECT`. */
export async function diagnosticarDesignacao(
  prisma: PrismaClient,
  tenantSlug: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DiagnosticoDesignacao> {
  const farmacias = await prisma.farmacia.findMany({
    select: { id: true, nome: true, codigoANF: true, estado: true, _count: { select: { produtosFarmacia: true } } },
    orderBy: { nome: "asc" },
  });
  const resolucao = await resolverAutoridadeDesignacao(prisma, tenantSlug, env);
  const configurado = normalizarCodigoANF(env[ENV_CODIGO_ANF_DESIGNACAO]);

  const accoes: string[] = [];
  if (resolucao.aplica && !resolucao.valida) {
    const semCodigo = farmacias.filter((f) => normalizarCodigoANF(f.codigoANF) === "");
    switch (resolucao.codigo) {
      case "NAO_CONFIGURADO":
        accoes.push(
          `Definir ${ENV_CODIGO_ANF_DESIGNACAO} no ambiente da app (valor = Farmacia.codigoANF da Silveirense) e reiniciar.`,
        );
        if (semCodigo.length > 0) {
          accoes.push(
            `Farmácias SEM codigoANF (candidatas a receber um): ${semCodigo.map((f) => `${f.nome} [${f.id}]`).join("; ")}.`,
            "Para atribuir o código à Silveirense: npm run admin:definir-codigo-farmacia-designacao -- --tenant=silveira --farmacia-id=<id> --codigo=<ANF> (dry-run) e repetir com --apply.",
          );
        }
        break;
      case "NAO_ENCONTRADA":
        accoes.push(
          `Nenhuma farmácia tem codigoANF "${configurado}". Corrigir o valor de ${ENV_CODIGO_ANF_DESIGNACAO} ou atribuir o código à farmácia certa (script admin:definir-codigo-farmacia-designacao).`,
        );
        break;
      case "AMBIGUA":
        accoes.push(
          `Mais de uma farmácia tem codigoANF "${configurado}": ${farmacias
            .filter((f) => normalizarCodigoANF(f.codigoANF) === configurado)
            .map((f) => `${f.nome} [${f.id}]`)
            .join("; ")}. Tem de ser exactamente uma.`,
        );
        break;
      case "INATIVA":
        accoes.push("A farmácia identificada está inactiva — reactivá-la ou configurar outra.");
        break;
    }
  }
  return {
    tenant: tenantSlug,
    variavelDefinida: configurado !== "",
    codigoConfigurado: configurado,
    farmacias: farmacias.map((f) => ({
      id: f.id,
      nome: f.nome,
      codigoANF: f.codigoANF,
      estado: f.estado,
      produtosNaFarmacia: f._count.produtosFarmacia,
    })),
    resolucao,
    accoes,
  };
}

export type ResultadoDefinirCodigo =
  | { ok: true; accao: "SEM_ALTERACAO" | "ATRIBUIR" | "SUBSTITUIR"; farmaciaId: string; codigoAnterior: string | null; codigoNovo: string; aplicado: boolean }
  | { ok: false; erro: "FARMACIA_INEXISTENTE" | "CODIGO_INVALIDO" | "CODIGO_EM_USO" | "JA_TEM_OUTRO_CODIGO"; mensagem: string };

/**
 * Atribui `Farmacia.codigoANF` à farmácia indicada, de forma idempotente e
 * segura. NUNCA escolhe a farmácia (o id é obrigatório). Dry-run por omissão.
 *
 *   · já tem esse código            → SEM_ALTERACAO (nada escrito)
 *   · sem código                    → ATRIBUIR
 *   · tem OUTRO código              → recusa, salvo `forcar` (SUBSTITUIR) — o
 *                                     codigoANF aparece nos cabeçalhos dos
 *                                     relatórios, não se troca por engano
 *   · outra farmácia já o usa       → recusa (a identificação ficaria ambígua)
 */
export async function definirCodigoFarmacia(
  prisma: PrismaClient,
  input: { farmaciaId: string; codigo: string; aplicar: boolean; forcar?: boolean },
): Promise<ResultadoDefinirCodigo> {
  const codigo = input.codigo.trim();
  if (codigo === "" || codigo.length > 50) {
    return { ok: false, erro: "CODIGO_INVALIDO", mensagem: "O código tem de ter entre 1 e 50 caracteres." };
  }
  const todas = await prisma.farmacia.findMany({ select: { id: true, nome: true, codigoANF: true } });
  const alvo = todas.find((f) => f.id === input.farmaciaId);
  if (!alvo) {
    return { ok: false, erro: "FARMACIA_INEXISTENTE", mensagem: `Não existe farmácia com id "${input.farmaciaId}" neste tenant.` };
  }
  const emUso = todas.filter((f) => f.id !== alvo.id && normalizarCodigoANF(f.codigoANF) === normalizarCodigoANF(codigo));
  if (emUso.length > 0) {
    return {
      ok: false,
      erro: "CODIGO_EM_USO",
      mensagem: `O código "${codigo}" já é usado por: ${emUso.map((f) => `${f.nome} [${f.id}]`).join("; ")}.`,
    };
  }
  const atual = alvo.codigoANF?.trim() || null;
  if (atual !== null && normalizarCodigoANF(atual) === normalizarCodigoANF(codigo)) {
    return { ok: true, accao: "SEM_ALTERACAO", farmaciaId: alvo.id, codigoAnterior: atual, codigoNovo: atual, aplicado: false };
  }
  if (atual !== null && !input.forcar) {
    return {
      ok: false,
      erro: "JA_TEM_OUTRO_CODIGO",
      mensagem: `A farmácia "${alvo.nome}" já tem codigoANF "${atual}". Usar esse valor em ${ENV_CODIGO_ANF_DESIGNACAO} (não é preciso alterar nada), ou --forcar para o substituir.`,
    };
  }
  const accao = atual === null ? "ATRIBUIR" : "SUBSTITUIR";
  if (input.aplicar) {
    await prisma.farmacia.update({ where: { id: alvo.id }, data: { codigoANF: codigo } });
  }
  return { ok: true, accao, farmaciaId: alvo.id, codigoAnterior: atual, codigoNovo: codigo, aplicado: input.aplicar };
}
