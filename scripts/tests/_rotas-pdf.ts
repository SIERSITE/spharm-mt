/**
 * Chama os handlers REAIS das rotas (POST /api/reports/pdf e /api/reports/email) com um Report do Mapa de Vendas:
 *   · 27 meses → HTTP 422 com a mensagem «O período de 27 meses não cabe numa página A4 legível (máximo M meses com estas opções)…»;
 *   · 14 meses → HTTP 200 e um PDF com páginas A4 horizontais (841,9 × 595,3 pt);
 *   · email com PDF e 27 meses → 422 antes de qualquer envio; email só com Excel não é limitado (não se envia: sem SMTP aqui).
 * O pacote `server-only` (que o Next fornece) é resolvido para este ficheiro — fica inerte, como no servidor Next. Imprime linhas «ROTA |OK|…».
 */
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { relatorioCliente } from "./_tabela-unica";
import { capacidadeDoRelatorio } from "../../lib/reporting/layout-vendas";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

const linha = (ok: boolean, txt: string) => console.log(`ROTA |${ok ? "OK" : "FALHA"}|${txt}`);
const post = (url: string, corpo: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });

(async () => {
  const { POST: pdf } = await import("../../app/api/reports/pdf/route");
  const r27 = relatorioCliente({ meses: 27, artigos: 20 });
  const cap27 = capacidadeDoRelatorio(r27);
  const esperado27 = `O período de 27 meses não cabe numa página A4 legível (máximo ${cap27.mesesMax} meses com estas opções). Reduza o período, retire preços ou use o Excel.`;
  const res27 = await pdf(post("/api/reports/pdf", r27));
  const j27 = (await res27.json()) as { error?: string };
  linha(res27.status === 422 && j27.error === esperado27, `POST /api/reports/pdf com 27 meses → HTTP ${res27.status} com a mensagem «${j27.error}»`);

  const r14 = relatorioCliente({ meses: 14, artigos: 30 });
  const res14 = await pdf(post("/api/reports/pdf", r14));
  const buf = Buffer.from(await res14.arrayBuffer());
  linha(res14.status === 200 && res14.headers.get("content-type") === "application/pdf" && buf.subarray(0, 4).toString() === "%PDF", `POST /api/reports/pdf com 14 meses → HTTP ${res14.status}, application/pdf, ${buf.length} bytes`);
  const dir = mkdtempSync(path.join(tmpdir(), "rota-pdf-"));
  try {
    const f = path.join(dir, "r.pdf");
    writeFileSync(f, buf);
    const r = spawnSync("python", ["-c", "import pymupdf,sys;d=pymupdf.open(sys.argv[1]);print(d.page_count, ' '.join(f'{p.rect.width:.1f}x{p.rect.height:.1f}' for p in d))", f], { encoding: "utf8" });
    const [n, ...tams] = r.stdout.trim().split(/\s+/);
    linha(Number(n) >= 2 && tams.every((t) => t === "841.9x595.0" || t === "841.9x595.3"), `…o PDF da rota tem ${n} páginas A4 horizontais (${[...new Set(tams)].join(", ")})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  try {
    const { POST: email } = await import("../../app/api/reports/email/route");
    const resE = await email(post("/api/reports/email", { to: ["destino@example.com"], attachFormats: ["pdf", "excel"], report: r27 }));
    const jE = (await resE.json()) as { error?: string };
    linha(resE.status === 422 && jE.error === esperado27, `POST /api/reports/email (PDF + Excel) com 27 meses → HTTP ${resE.status} com a mesma mensagem, sem enviar nada`);
  } catch (e) {
    linha(false, `POST /api/reports/email: não foi possível carregar a rota (${(e as Error).message.slice(0, 120)})`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); linha(false, `rotas: ${(e as Error).message}`); process.exit(1); });
