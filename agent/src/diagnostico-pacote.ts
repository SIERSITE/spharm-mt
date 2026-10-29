/**
 * agent/src/diagnostico-pacote.ts
 *
 * Identidade do pacote de DIAGNÓSTICO `classification-audit` (fase 1 da classificação ERP). NÃO é uma revisão do
 * agent: é um pacote à parte, baseado na rev98, só para executar manualmente numa farmácia e recolher factos.
 * Nunca instalável, nunca substitui a rev98, nunca é publicado.
 *
 * `AUDIT_PACKAGE_VERSION` é injetado pelo `agent/build-audit-package.mjs` (`diag2-<data UTC>`; a v1 era `diag-<data>`); em desenvolvimento (tsx)
 * fica `diag-dev`. O `AGENT_COMMIT` também vem do build.
 */

export const PACOTE_ID = "classification-audit";
export const PACOTE_BASE_REV = "98";
/** Commit da rev98 em que o pacote se baseia (`git rev-parse beb5fa7`). */
export const PACOTE_BASE_COMMIT = "beb5fa7c008cb33238b3e644ec1165caf99fb648";
export const FRASE_PACOTE = `pacote de DIAGNÓSTICO (base rev${PACOTE_BASE_REV}), modo read-only, não instalável`;

export function versaoDoPacote(): string {
  return process.env.AUDIT_PACKAGE_VERSION || "diag-dev";
}
export function commitDoPacote(): string | null {
  const c = process.env.AGENT_COMMIT;
  return c && c !== "unknown" ? c : null;
}
