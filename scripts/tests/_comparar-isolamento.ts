/**
 * scripts/tests/_comparar-isolamento.ts
 *
 * Orquestra a comparação BASE (a69cbc5) × ENTREGA (árvore actual) por tenant, usando `_snapshot-tenant.ts`:
 *   1. cria uma base PostgreSQL descartável, aplica as migrações (as da árvore actual; `prisma/` é idêntico ao base),
 *      semeia-a de forma determinística;
 *   2. corre o snapshot em cada árvore × tenant (processos `tsx` separados, com cwd = a árvore, para o tsconfig/`@/` certo);
 *   3. compara os JSON achatados e classifica cada diferença como «esperada» (com a razão) ou «INESPERADA».
 *
 * É usado pelos testes de isolamento e também como CLI (`npx tsx scripts/tests/_comparar-isolamento.ts`), que imprime
 * as diferenças por tenant. A árvore base é só LIDA/EXECUTADA (nada é escrito lá). Env: ISOLAMENTO_BASE_ROOT,
 * TEST_PG_ADMIN_URL.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const SHA_BASE = "a69cbc5";
export const ROOT_ATUAL = path.resolve(__dirname, "../..");
export const ROOT_BASE = path.resolve(process.env.ISOLAMENTO_BASE_ROOT ?? "C:/projetos/_clean/base-a69");
export const TENANTS = ["silveira", "sier", "garantia", "outro", "__nenhum__"] as const;
export type SlugSnapshot = (typeof TENANTS)[number];

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const SCRIPT = path.join(ROOT_ATUAL, "scripts/tests/_snapshot-tenant.ts");

export function validarBase(): string {
  const head = execFileSync("git", ["-C", ROOT_BASE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!head.startsWith(SHA_BASE)) throw new Error(`A árvore base (${ROOT_BASE}) está em ${head}, esperava ${SHA_BASE}`);
  return head;
}

const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
async function tsx(cwd: string, args: string[]) {
  // `shell: true` no Windows (npx.cmd); os argumentos não têm espaços. Repete até 3x: com a máquina carregada (vários
  // agentes/IDE) o esbuild do tsx pode falhar com «out of memory» de forma transitória.
  let ultimo: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await execFileP(npx, ["tsx", SCRIPT.replace(/\\/g, "/"), ...args], { cwd, shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { ultimo = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw ultimo;
}

export type Snapshots = { base: Record<string, any>; atual: Record<string, any> };

/** Cria a base descartável, semeia, fotografa as duas árvores para todos os tenants e apaga a base. */
export async function obterSnapshots(tenants: readonly string[] = TENANTS): Promise<Snapshots> {
  validarBase();
  const { Client } = require(path.join(ROOT_ATUAL, "node_modules/pg"));
  const host = new URL(ADMIN_URL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`RECUSADO: ${host} não é uma base local descartável.`);
  const db = `spharm_iso_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-iso-"));
  try {
    execFileSync(npx, ["prisma", "migrate", "deploy"], { cwd: ROOT_ATUAL, shell: process.platform === "win32", env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8", stdio: "pipe" });
    await tsx(ROOT_ATUAL, ["--root", ROOT_ATUAL.replace(/\\/g, "/"), "--db", urlDe(db), "--seed"]);
    const trabalhos: Array<Promise<void>> = [];
    const resultado: Snapshots = { base: {}, atual: {} };
    for (const [arvore, root] of [["base", ROOT_BASE], ["atual", ROOT_ATUAL]] as const) {
      for (const t of tenants) {
        const out = path.join(pasta, `${arvore}-${t}.json`);
        trabalhos.push(
          tsx(root, ["--root", root.replace(/\\/g, "/"), "--tenant", t, "--db", urlDe(db), "--out", out.replace(/\\/g, "/")]).then(() => {
            resultado[arvore][t] = JSON.parse(fs.readFileSync(out, "utf8"));
          }),
        );
      }
    }
    // Em lotes de 3 (cada processo carrega o Prisma + a app).
    const lote = 3;
    for (let i = 0; i < trabalhos.length; i += lote) await Promise.all(trabalhos.slice(i, i + lote));
    return resultado;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

// ─── Comparação ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function achatar(v: any, prefixo = "", out: Record<string, any> = {}): Record<string, any> {
  if (v !== null && typeof v === "object") {
    const chaves = Array.isArray(v) ? v.map((_, i) => `[${i}]`) : Object.keys(v);
    if (chaves.length === 0) out[prefixo || "."] = Array.isArray(v) ? "[]" : "{}";
    for (const k of chaves) {
      const sub = Array.isArray(v) ? v[Number(k.slice(1, -1))] : v[k];
      achatar(sub, Array.isArray(v) ? `${prefixo}${k}` : prefixo ? `${prefixo}.${k}` : k, out);
    }
  } else out[prefixo || "."] = v;
  return out;
}

export type Diferenca = { caminho: string; base: any; atual: any };
export function diferencas(base: any, atual: any): Diferenca[] {
  const a = achatar(base);
  const b = achatar(atual);
  const chaves = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  const out: Diferenca[] = [];
  for (const c of chaves) if (JSON.stringify(a[c]) !== JSON.stringify(b[c])) out.push({ caminho: c, base: a[c], atual: b[c] });
  return out;
}

export type Classificacao = { esperada: true; razao: string } | { esperada: false };

/**
 * Diferenças declaradas e esperadas para os tenants que NÃO são a garantia (silveira, sier, outro, sem tenant).
 * Tudo o que não bate com um destes padrões é INESPERADO.
 */
const ESPERADAS_NAO_GARANTIA: Array<{ re: RegExp; razao: string }> = [
  { re: /^filtros\.opcoesRelatorio\.formas/, razao: "mudança esperada: ponto 6 (filtro de forma farmacêutica — todos os tenants, por pedido): opções de forma nos filtros dos relatórios" },
  { re: /^catalogo\.opcoes\.formas/, razao: "mudança esperada: ponto 6 (filtro de forma farmacêutica — todos os tenants, por pedido): opções de forma no Catálogo" },
  { re: /^margens\..*\.(stockAtual|stockTotal|linhasSemStock|linhas)$/, razao: "mudança esperada: Margens com stock (todos os tenants, por pedido): campos novos aditivos stockAtual/stockTotal/linhasSemStock/linhas (contador por agregado); o resto do mapa tem de ser igual" },
  { re: /^sql\./, razao: "mudança esperada: ponto 6 — SQL puro do filtro de forma (módulo novo; ausente no base)" },
  { re: /^constantes\.TENANTS_CATALOGO_MANUTENCAO/, razao: "refactor declarado: nova constante da lista central de manutenção (só dados; o resultado por tenant está em gates.*)" },
  { re: /^gates\.(manutencaoCatalogo|gruposLaboratoriais)\.fn$/, razao: "refactor declarado: o gate passou a ser a função central (nome do mecanismo; o booleano `ativo` tem de ser igual)" },
  { re: /^menu\.mecanismo$/, razao: "refactor declarado: o menu usa a função central (nome do mecanismo; o booleano `visivel` tem de ser igual)" },
  { re: /^resolucao\.cnpsPorSelecao/, razao: "módulo novo (resolvedor por CNP dos filtros agrupados); ausente no base. `idsProdutoPorSelecao` (o existente) tem de ser igual" },
  { re: /^acoesLaboratorio/, razao: "server action de LEITURA nova (resolverCnpsLaboratoriosAction, reports.read): ausente no base; fora de garantia só resolve fabricantes, nunca grupos" },
  { re: /^resolucao\.agrupadoNoCliente/, razao: "função pura nova (agruparOpcoesLaboratorio); ausente no base. Sem `laboratorios` (tenants sem grupos) devolve lista vazia" },
];

export function classificarNaoGarantia(d: Diferenca): Classificacao {
  const e = ESPERADAS_NAO_GARANTIA.find((x) => x.re.test(d.caminho));
  return e ? { esperada: true, razao: e.razao } : { esperada: false };
}

const ESPERADAS_GARANTIA: Array<{ re: RegExp; razao: string }> = [
  ...ESPERADAS_NAO_GARANTIA,
  { re: /^gates\.manutencaoCatalogo\.ativo$|^menu\.visivel$|^pagina\.|^acoes\./, razao: "garantia passa a ter a manutenção do catálogo (menu, página e server actions)" },
  { re: /laboratorios/, razao: "garantia: opções de laboratório agrupadas (grupo com variantes)" },
  { re: /^resolucao\./, razao: "garantia: filtro agrupado" },
];
export function classificarGarantia(d: Diferenca): Classificacao {
  const e = ESPERADAS_GARANTIA.find((x) => x.re.test(d.caminho));
  return e ? { esperada: true, razao: e.razao } : { esperada: false };
}

// ─── Mini-runner dos testes de isolamento (PASSOU / FALHOU) ───────────────────────────────────────────────────────────
export function criarRunner() {
  let passou = 0;
  let falhou = 0;
  const falhas: string[] = [];
  return {
    check(cond: boolean, rotulo: string, detalhe?: string) {
      if (cond) { passou++; console.log("  PASSOU  " + rotulo); }
      else { falhou++; falhas.push(rotulo); console.log("  FALHOU  " + rotulo + (detalhe ? "\n            " + detalhe : "")); }
    },
    titulo(t: string) { console.log("\n" + t); },
    fim(): never {
      console.log("\n" + passou + " PASSOU, " + falhou + " FALHOU");
      if (falhou) console.log("Falhas:\n - " + falhas.join("\n - "));
      process.exit(falhou === 0 ? 0 : 1);
    },
  };
}

/** Igualdade profunda por JSON canónico (os snapshots já têm chaves ordenadas). */
export const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `git` na árvore actual; devolve stdout. */
export function git(...args: string[]): string {
  return execFileSync("git", ["-C", ROOT_ATUAL, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const s = await obterSnapshots();
    for (const t of TENANTS) {
      const ds = diferencas(s.base[t], s.atual[t]);
      const cls = t === "garantia" ? classificarGarantia : classificarNaoGarantia;
      const inesperadas = ds.filter((d) => !cls(d).esperada);
      console.log(`\n=== ${t}: ${ds.length} diferenças, ${inesperadas.length} INESPERADAS ===`);
      const porRazao = new Map<string, number>();
      for (const d of ds) { const c = cls(d); if (c.esperada) porRazao.set(c.razao, (porRazao.get(c.razao) ?? 0) + 1); }
      for (const [r, n] of porRazao) console.log(`  [esperada x${n}] ${r}`);
      for (const d of inesperadas) console.log(`  [INESPERADA] ${d.caminho}\n      base:  ${JSON.stringify(d.base)}\n      atual: ${JSON.stringify(d.atual)}`);
    }
  })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
