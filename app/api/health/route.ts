/**
 * app/api/health/route.ts
 *
 * Health endpoint REAL — é o que o Docker, o reverse proxy e o
 * `verify-platform.sh` usam para decidir se este container serve
 * tráfego.
 *
 * "Real" quer dizer que toca mesmo nas dependências de que a aplicação
 * não consegue viver sem: uma rota que devolve `{"ok":true}` sem
 * verificar nada declara saudável um processo que não liga à base de
 * dados, e o proxy manda-lhe tráfego que só pode falhar.
 *
 * O que verifica:
 *   · processo vivo (uptime, versão)
 *   · control plane acessível (SELECT 1 com timeout curto)
 *
 * O que NÃO verifica, deliberadamente:
 *   · bases dos tenants — N ligações por sondagem, e um tenant em baixo
 *     não torna a plataforma inútil para os outros. Isso é trabalho do
 *     `tenancy:health`, não de um probe que corre a cada 30 segundos.
 *
 * Códigos: 200 saudável · 503 degradado (dependência crítica em baixo).
 * O corpo é o mesmo nos dois casos — quem diagnostica precisa de saber
 * O QUÊ falhou, não só que falhou.
 *
 * Sem autenticação, e sem nada sensível no corpo: nomes de verificações,
 * durações e um booleano. Nem URLs, nem versões de dependências, nem
 * mensagens de erro em bruto da base de dados (podem trazer host e
 * utilizador). Está excluído do middleware de tenant (ver `middleware.ts`).
 */

import { NextResponse } from "next/server";
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Timeout por verificação. Um probe que bloqueia é pior que um que falha. */
const CHECK_TIMEOUT_MS = 3_000;

type CheckResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  /** Categoria do erro, nunca a mensagem em bruto. */
  error?: string;
};

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkControlPlane(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const prisma = getControlPrismaCli();
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return { name: "control-plane", ok: true, durationMs: Date.now() - t0 };
  } catch (err) {
    const reason = err instanceof Error && err.message === "timeout" ? "timeout" : "unreachable";
    return {
      name: "control-plane",
      ok: false,
      durationMs: Date.now() - t0,
      error: reason,
    };
  }
}

export async function GET() {
  const checks: CheckResult[] = [await checkControlPlane()];
  const healthy = checks.every((c) => c.ok);

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      // Identifica o build a correr. Injectada pelo Dockerfile (ARG
      // APP_REVISION); "dev" quando se corre localmente.
      revision: process.env.APP_REVISION ?? "dev",
      checks,
    },
    {
      status: healthy ? 200 : 503,
      // Um health cacheado é um health mentiroso.
      headers: { "cache-control": "no-store, max-age=0" },
    },
  );
}

/** HEAD para probes que não querem corpo (o proxy usa este). */
export async function HEAD() {
  const res = await GET();
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
