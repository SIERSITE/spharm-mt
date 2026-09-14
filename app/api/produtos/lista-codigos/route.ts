/**
 * app/api/produtos/lista-codigos/route.ts
 *
 * POST /api/produtos/lista-codigos   (multipart/form-data, campo `file`)
 *
 * Recebe o ficheiro de códigos, devolve a lista resolvida. É o único
 * ponto de entrada — Relatórios e Encomendas fazem o mesmo POST.
 *
 * ── Porque um Route Handler e não uma Server Action ──────────────────
 *
 * Duas razões, e nenhuma é estilo.
 *
 * O payload das Server Actions tem um tecto de 1 MB por omissão. Um
 * .xlsx de 3 MB com 20 000 linhas é um ficheiro perfeitamente banal
 * numa farmácia, e passaria a exigir subir `serverActions.bodySizeLimit`
 * em `next.config.ts` — um limite GLOBAL, que passaria a valer para
 * todas as actions da app por causa desta.
 *
 * E o `xlsx` é uma biblioteca pesada. Aqui fica confinado a uma rota do
 * servidor; o componente de UI só importa os TIPOS
 * (`lista-codigos-tipos.ts`, que não o conhece), e por isso nada disto
 * chega ao bundle do browser.
 *
 * ── O que NÃO faz ────────────────────────────────────────────────────
 *
 * Não escreve nada. Não guarda o ficheiro, não cria `LoteIngestao`, não
 * toca na BD além de um `findMany` por CNP. O ficheiro vive em memória
 * durante o pedido e desaparece com ele — é o que o requisito pede
 * ("não deve persistir o ficheiro original desnecessariamente").
 */
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  EXTENSOES_ACEITES,
  MAX_CODIGOS,
  MAX_FICHEIRO_BYTES,
  type ListaCodigosErro,
  type ListaCodigosResposta,
} from "@/lib/produtos/lista-codigos-tipos";
import { extensaoDe, ListaCodigosParseError, parseListaCodigos } from "@/lib/produtos/lista-codigos";
import {
  ListaCodigosDemasiadoGrande,
  resolverListaCodigos,
} from "@/lib/produtos/resolver-lista-codigos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function erro(codigo: ListaCodigosErro, mensagem: string, status: number): Response {
  return Response.json({ ok: false, erro: mensagem, codigo } satisfies ListaCodigosResposta, {
    status,
  });
}

export async function POST(request: Request): Promise<Response> {
  // `reports.read` e não `reports.write`: importar uma lista é preparar
  // uma consulta, e um OPERADOR pode consultar. Quem depois cria a
  // encomenda continua a precisar de `reports.write` — essa verificação
  // está onde sempre esteve, em `createOrderAction`.
  const session = await getSession();
  if (!session) return erro("sem_sessao", "Sessão expirada. Entre novamente.", 401);
  if (!can(session, "reports.read")) {
    return erro("sem_permissao", "Sem permissão para consultar relatórios.", 403);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return erro("sem_ficheiro", "Pedido inválido (esperado multipart/form-data).", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return erro("sem_ficheiro", "Nenhum ficheiro recebido.", 400);
  }

  const ext = extensaoDe(file.name);
  if (!(EXTENSOES_ACEITES as readonly string[]).includes(ext)) {
    return erro(
      "extensao_nao_suportada",
      `Formato não suportado (${ext || "sem extensão"}). Aceites: ${EXTENSOES_ACEITES.join(", ")}.`,
      400,
    );
  }

  // Verificado ANTES de ler para memória: é o que impede um upload de
  // 500 MB de se tornar 500 MB de heap no servidor.
  if (file.size > MAX_FICHEIRO_BYTES) {
    return erro(
      "ficheiro_grande",
      `O ficheiro tem ${(file.size / 1024 / 1024).toFixed(1)} MB; o máximo é ` +
        `${MAX_FICHEIRO_BYTES / 1024 / 1024} MB.`,
      413,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const parseada = parseListaCodigos(file.name, bytes);

    if (parseada.codigos.length === 0) {
      return erro(
        "sem_codigos",
        "Não foi encontrado nenhum código no ficheiro. Os códigos devem ter pelo menos " +
          "4 dígitos, um por linha ou separados por ; , ou tabulação.",
        422,
      );
    }
    if (parseada.codigos.length > MAX_CODIGOS) {
      return erro(
        "demasiados_codigos",
        `A lista tem ${parseada.codigos.length.toLocaleString("pt-PT")} códigos; o máximo é ` +
          `${MAX_CODIGOS.toLocaleString("pt-PT")}.`,
        422,
      );
    }

    const lista = await resolverListaCodigos(parseada, file.name);
    return Response.json({ ok: true, lista } satisfies ListaCodigosResposta);
  } catch (err) {
    if (err instanceof ListaCodigosParseError) {
      return erro(err.codigo, err.message, 422);
    }
    if (err instanceof ListaCodigosDemasiadoGrande) {
      return erro("demasiados_codigos", err.message, 422);
    }
    return erro(
      "parse_falhou",
      err instanceof Error ? err.message : "Não foi possível ler o ficheiro.",
      500,
    );
  }
}
