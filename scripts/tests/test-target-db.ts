/**
 * scripts/tests/test-target-db.ts
 *
 * Fixa as regras de resolução de destino dos comandos de catálogo.
 *
 * Duas falhas reais que estas asserções impedem de voltar:
 *
 *  1. O backfill tinha uma base por omissão e escreveu 6 324 linhas na
 *     base errada sem dar um único erro.
 *  2. `--db=<base>` mantém o utilizador do DATABASE_URL. Em produção esse
 *     utilizador é o `spharmmt_app`, que não tem CONNECT às bases dos
 *     tenants: a ligação falha com uma mensagem que parece dizer que a
 *     base não existe. Por isso produção resolve por `--tenant=<slug>`,
 *     que traz a credencial do próprio tenant.
 *
 * Sem rede e sem base: só a lógica de decisão.
 *
 * Uso: npx tsx scripts/tests/test-target-db.ts
 */
import {
  AlvoRecusado,
  descreverAlvo,
  resolverAlvo,
  type TenantParaLigacao,
} from "../../lib/catalog/target-db";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const TENANTS: Record<string, TenantParaLigacao> = {
  silveira: {
    slug: "silveira",
    dbHost: "postgres",
    dbPort: 5432,
    dbName: "spharmmt_t_silveira",
    dbUser: "spharmmt_t_silveira",
    dbPassEncrypted: "cifrado",
  },
  "demo-neon": {
    slug: "demo-neon",
    dbHost: "ep-qualquer-coisa-pooler.eu-west-2.aws.neon.tech",
    dbPort: 5432,
    dbName: "spharmmt_t_demo",
    dbUser: "neondb_owner",
    dbPassEncrypted: "cifrado",
  },
};

const deps = {
  getTenantBySlug: async (slug: string) => TENANTS[slug] ?? null,
  buildTenantConnectionString: (t: TenantParaLigacao) =>
    `postgresql://${t.dbUser}:decifrada@${t.dbHost}:${t.dbPort}/${t.dbName}`,
};

async function tenta(argv: string[]): Promise<{ alvo?: Awaited<ReturnType<typeof resolverAlvo>>; erro?: string }> {
  try {
    return { alvo: await resolverAlvo(argv, deps) };
  } catch (err) {
    if (err instanceof AlvoRecusado) return { erro: err.message };
    throw err;
  }
}

async function main() {
  process.env.DATABASE_URL = "postgresql://spharmmt_app:x@postgres:5432/spharmmt_legacy";

  console.log("=== não há destino por omissão ===");
  check((await tenta([])).erro !== undefined, "sem argumentos é recusado");
  check((await tenta(["--dry-run"])).erro !== undefined, "só --dry-run é recusado");
  check(
    (await tenta(["--tenant=silveira", "--db=outra"])).erro?.includes("alternativas") === true,
    "--tenant com --db é recusado (ambiguidade)",
  );

  console.log("\n=== produção resolve pelo tenant, com a credencial do tenant ===");
  const p = await tenta(["--tenant=silveira"]);
  check(p.alvo?.base === "spharmmt_t_silveira", "base vem do control plane");
  check(p.alvo?.host === "postgres", "host vem do control plane");
  // O ponto todo desta correcção: o utilizador NÃO é o do DATABASE_URL.
  check(p.alvo?.utilizador === "spharmmt_t_silveira", "utilizador é o do tenant, não o spharmmt_app");
  check(p.alvo?.url.includes("spharmmt_app") === false, "a string de ligação não usa o spharmmt_app");
  check(p.alvo?.externo === false, "postgres local não é externo");
  check(
    descreverAlvo(p.alvo!).includes("como spharmmt_t_silveira"),
    "o cabeçalho diz com que utilizador entra",
    descreverAlvo(p.alvo!),
  );

  console.log("\n=== tenant inexistente não é adivinhado ===");
  check(
    (await tenta(["--tenant=nao-existe"])).erro?.includes("não existe no control plane") === true,
    "slug desconhecido é recusado",
  );

  console.log("\n=== externo continua a exigir opção explícita ===");
  const n = await tenta(["--tenant=demo-neon"]);
  check(n.erro !== undefined, "tenant em Neon é recusado por omissão");
  check(n.erro?.includes("--permitir-externo") === true, "a recusa diz o que fazer");
  const n2 = await tenta(["--tenant=demo-neon", "--permitir-externo"]);
  check(n2.alvo?.externo === true, "com --permitir-externo passa e fica marcado externo");
  check(
    descreverAlvo(n2.alvo!).includes("EXTERNO"),
    "o cabeçalho avisa que não é produção",
    descreverAlvo(n2.alvo!),
  );

  console.log("\n=== --db mantém-se para desenvolvimento ===");
  const d = await tenta(["--db=spharmmt_legacy"]);
  check(d.alvo?.base === "spharmmt_legacy", "--db resolve contra o DATABASE_URL");
  check(d.alvo?.utilizador === undefined, "--db não promete utilizador nenhum");
  process.env.DATABASE_URL = "postgresql://neondb_owner:x@ep-x-pooler.eu-west-2.aws.neon.tech/neondb";
  check(
    (await tenta(["--db=qualquer"])).erro?.includes("--permitir-externo") === true,
    "--db para host Neon é recusado sem a opção",
  );

  // ── Os scripts usam mesmo isto ──────────────────────────────────────
  //
  // As asserções acima provam que `resolverAlvo` faz a coisa certa. Não
  // provam que alguém o chama. O bootstrap determinístico bloqueou em
  // produção precisamente por aí: `target-db.ts` já existia e estava
  // correcto, e o `classify-backfill` continuava a construir a ligação à
  // mão, trocando o nome da base no DATABASE_URL —
  //   FATAL 42501: User does not have CONNECT privilege
  // porque a credencial que ficava era a do `spharmmt_app`.
  //
  // Estas asserções são sobre o código-fonte porque é aí que está o
  // defeito: um script que reconstrói a URL nunca chega a falhar num
  // teste de unidade, falha na VPS.
  console.log("\n=== os scripts de catálogo resolvem o destino, não o constroem ===");
  const TENANT_AWARE = [
    "classify-backfill.ts",
    "fill-rules.ts",
    "backfill-utilizacoes.ts",
    "knowledge-enrich.ts",
  ];
  for (const nome of TENANT_AWARE) {
    const src = readFileSync(
      new URL(`../catalog-master/${nome}`, import.meta.url),
      "utf8",
    );
    // Comentários explicam porque NÃO se faz isto; o que interessa é o código.
    const codigo = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");

    check(/resolverAlvo\s*\(/.test(codigo), `${nome} chama resolverAlvo`);
    check(
      !/process\.env\.DATABASE_URL/.test(codigo),
      `${nome} NÃO lê DATABASE_URL — é o que trazia o role legacy para uma base de tenant`,
    );
    check(
      !/\.replace\([^)]*\$\{?db/i.test(codigo) && !/`\/\$\{dbName\}/.test(codigo),
      `${nome} NÃO reconstrói a URL trocando o nome da base`,
    );
    check(
      /connectionString:\s*alvo\.url/.test(codigo),
      `${nome} liga-se com a URL resolvida (alvo.url)`,
    );
    check(
      /descreverAlvo\(alvo\)/.test(codigo),
      `${nome} imprime o destino antes de trabalhar`,
    );
    check(
      /default_transaction_read_only = \$\{\s*(dryRun \? "on" : "off"|apply \? "off" : "on")/.test(codigo),
      `${nome} põe a sessão read-only em dry-run`,
    );
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
