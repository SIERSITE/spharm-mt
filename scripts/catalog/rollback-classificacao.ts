/**
 * scripts/catalog/rollback-classificacao.ts
 *
 * Desfaz, linha a linha, o que `reavaliar-cache-classificacao --apply`
 * escreveu.
 *
 * ── Porque é pelo journal e não por SQL ──────────────────────────────
 *
 * A tentação óbvia era:
 *
 *   update "Produto" set "classificacaoNivel1Id" = null,
 *                        "classificacaoNivel2Id" = null
 *    where "classificacaoEstado" = 'PROVISORIA';
 *
 * e está errado para uma parte dos casos. Uma classificação provisória
 * pode ter substituído um `"Outros X"` — e esse SQL devolveria `null` a
 * esses produtos, apagando uma classificação que não foi esta corrida a
 * escrever. O rollback passaria a ser uma segunda alteração.
 *
 * O journal guarda o que lá estava ANTES, lido na mesma instrução que
 * escreveu (ver o CTE em `lib/catalog/escrita-classificacao.ts`), portanto
 * descreve o que foi mesmo substituído e não uma leitura anterior que
 * pudesse já estar desactualizada.
 *
 * ── Idempotente, e conservador ───────────────────────────────────────
 *
 * Cada reversão só se aplica se o produto AINDA estiver no estado que esta
 * escrita deixou. Consequências, ambas desejadas:
 *
 *   · correr duas vezes não faz nada da segunda;
 *   · uma classificação corrigida por uma pessoa entretanto NÃO é
 *     revertida — a correcção humana ganha ao desfazer automático.
 *
 * O relatório distingue os dois casos, para que "revertidas: 180 de 200"
 * não pareça uma falha quando são 20 correcções humanas a serem
 * respeitadas.
 *
 * Uso:
 *   npm run catalog:rollback-classificacao -- --tenant=<slug> --journal=/tmp/j.jsonl
 *   npm run catalog:rollback-classificacao -- --tenant=<slug> --journal=/tmp/j.jsonl --apply
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { reverterLinhaJournal, type LinhaJournal } from "../../lib/catalog/escrita-classificacao";

const pad = (n: number | string, w = 6) => String(n).padStart(w);

/**
 * Lê o journal, recusando-se a adivinhar.
 *
 * Uma linha malformada ABORTA em vez de ser saltada: um rollback parcial
 * silencioso é pior que nenhum — deixa a base num estado que ninguém
 * descreveu e que já não corresponde nem ao antes nem ao depois.
 */
function lerJournal(caminho: string): LinhaJournal[] {
  const bruto = readFileSync(caminho, "utf8");
  const linhas: LinhaJournal[] = [];
  let n = 0;
  for (const l of bruto.split(/\r?\n/)) {
    n++;
    const t = l.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      throw new Error(`journal: linha ${n} não é JSON válido.`);
    }
    const o = obj as Partial<LinhaJournal>;
    if (typeof o.cnp !== "number" || typeof o.n2DepoisId !== "string" || !o.estadoDepois) {
      throw new Error(
        `journal: linha ${n} não tem os campos mínimos (cnp, n2DepoisId, estadoDepois).`,
      );
    }
    linhas.push(o as LinhaJournal);
  }
  return linhas;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const journal = argv.find((a) => a.startsWith("--journal="))?.split("=").slice(1).join("=");

  if (!journal) {
    console.error("\nFalta --journal=<ficheiro>. É o ficheiro escrito pelo --apply da reavaliação.\n");
    process.exit(4);
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (!alvo.tenant) {
    console.error("\nEste comando precisa de --tenant=<slug>.\n");
    process.exit(2);
  }

  const linhas = lerJournal(journal);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  if (!apply) {
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
  }

  console.log("═".repeat(74));
  console.log(`${descreverAlvo(alvo)}   (rollback — ${apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`journal: ${journal}   ${linhas.length} linhas`);
  console.log("═".repeat(74));

  // A ordem INVERSA à da escrita. Se o mesmo produto aparecer duas vezes
  // no journal — dois `--apply` sobre o mesmo ficheiro —, desfazer de trás
  // para a frente repõe o estado mais antigo, que é o certo.
  const paraTras = [...linhas].reverse();

  let revertidas = 0;
  let jaRevertidas = 0;
  const exemplos: string[] = [];

  for (const l of paraTras) {
    if (!apply) {
      // Em dry-run diz-se o que se faria, sem tocar. A contagem exacta do
      // que ainda está no estado esperado só se sabe ao escrever — dizer
      // "seriam revertidas N" sem verificar seria uma promessa.
      if (exemplos.length < 12) {
        exemplos.push(
          `  ${String(l.cnp).padEnd(9)} ${(l.n2Depois ?? "—").slice(0, 24).padEnd(24)} → ${l.n2Antes ?? "(sem nível 2)"}`,
        );
      }
      continue;
    }
    const ok = await reverterLinhaJournal(prisma, l);
    if (ok) {
      revertidas++;
      if (exemplos.length < 12) {
        exemplos.push(
          `  ${String(l.cnp).padEnd(9)} ${(l.n2Depois ?? "—").slice(0, 24).padEnd(24)} → ${l.n2Antes ?? "(sem nível 2)"}`,
        );
      }
    } else {
      jaRevertidas++;
    }
  }

  console.log(`\n── resultado ──────────────────────────────────────────`);
  if (apply) {
    console.log(`  ${pad(revertidas)}  revertidas`);
    console.log(`  ${pad(jaRevertidas)}  intocadas — já revertidas, ou alteradas por alguém entretanto`);
    console.log(`\n  As intocadas NÃO são falha: o UPDATE só repõe se o produto ainda`);
    console.log(`  estiver no estado que esta escrita deixou. Uma correcção humana feita`);
    console.log(`  desde então ganha ao desfazer automático, e é isso que este número conta.`);
  } else {
    console.log(`  ${pad(linhas.length)}  linhas no journal, prontas a reverter`);
    console.log(`\n  DRY-RUN: nada foi escrito. Para aplicar, acrescentar --apply.`);
  }

  if (exemplos.length > 0) {
    console.log(`\n── amostra ────────────────────────────────────────────`);
    for (const e of exemplos) console.log(e);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
