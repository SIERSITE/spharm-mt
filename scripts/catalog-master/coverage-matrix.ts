/**
 * scripts/catalog-master/coverage-matrix.ts
 *
 * Cobertura do catálogo por TIPO DE PRODUTO, campo a campo.
 *
 * A cobertura global é enganadora: mistura universos com necessidades
 * diferentes e esconde onde está o buraco. Um champô sem ATC não é uma
 * falha; um medicamento sem ATC é. Esta matriz mede cada campo apenas
 * sobre o universo a que o campo se aplica.
 *
 * Regras de negócio aplicadas:
 *  - CNP < 2 000 000 são códigos internos da farmácia: fora do universo.
 *  - DCI, ATC e Grupo Homogéneo só são exigíveis a MEDICAMENTO. Para os
 *    restantes tipos aparecem como "n/a", não como 0%.
 *
 * Uso: npx tsx scripts/catalog-master/coverage-matrix.ts [--db=...]
 */
import "dotenv/config";
import pg from "pg";

const MIN_CNP = 2_000_000;

/** Campos só exigíveis a medicamentos. */
const SO_MEDICAMENTO = new Set(["dci", "atc", "grupoHom"]);

type Linha = {
  tipo: string;
  n: number;
  categoria: number;
  subcategoria: number;
  laboratorio: number;
  dci: number;
  atc: number;
  grupoHom: number;
  imagem: number;
};

async function main() {
  const argv = process.argv.slice(2);
  const dbName =
    argv.find((a) => a.startsWith("--db="))?.split("=")[1] ??
    "spharmmt_t_grupo_silveira";
  const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  const { rows } = await db.query<Linha>(
    `select coalesce(p."productType", '(por classificar)') as tipo,
            count(*)::int as n,
            count(p."classificacaoNivel1Id")::int as categoria,
            count(p."classificacaoNivel2Id")::int as subcategoria,
            count(p."fabricanteId")::int as laboratorio,
            count(p.dci)::int as dci,
            count(p."codigoATC")::int as atc,
            count(p."grupoHomogeneo")::int as "grupoHom",
            count(p."imagemUrl")::int as imagem
       from "Produto" p
      where p.cnp >= $1
      group by 1
      order by 2 desc`,
    [MIN_CNP],
  );
  await db.end();

  const campos = [
    ["Categoria", "categoria"],
    ["Subcateg.", "subcategoria"],
    ["Laborat.", "laboratorio"],
    ["DCI", "dci"],
    ["ATC", "atc"],
    ["Gr.Homog.", "grupoHom"],
    ["Imagem", "imagem"],
  ] as const;

  const total = rows.reduce((s, r) => s + r.n, 0);

  const cel = (r: Linha, key: string) => {
    if (SO_MEDICAMENTO.has(key) && r.tipo !== "MEDICAMENTO") return "n/a";
    const v = r[key as keyof Linha] as number;
    return `${((v / r.n) * 100).toFixed(1)}%`;
  };

  const wTipo = Math.max(20, ...rows.map((r) => r.tipo.length));
  console.log(`\ncatálogo elegível (CNP >= ${MIN_CNP.toLocaleString("pt-PT")}): ${total}\n`);
  console.log("=== COBERTURA POR TIPO DE PRODUTO ===\n");
  console.log(
    "tipo".padEnd(wTipo) + "     n  " +
      campos.map(([label]) => label.padStart(10)).join(""),
  );
  console.log("─".repeat(wTipo + 6 + campos.length * 10));
  for (const r of rows) {
    console.log(
      r.tipo.padEnd(wTipo) +
        String(r.n).padStart(6) + "  " +
        campos.map(([, k]) => cel(r, k).padStart(10)).join(""),
    );
  }

  // Totais sobre o universo a que cada campo se aplica — não sobre tudo.
  console.log("─".repeat(wTipo + 6 + campos.length * 10));
  const med = rows.find((r) => r.tipo === "MEDICAMENTO");
  const somaTudo = (k: string) => rows.reduce((s, r) => s + (r[k as keyof Linha] as number), 0);
  console.log(
    "TOTAL (universo aplicável)".padEnd(wTipo) +
      String(total).padStart(6) + "  " +
      campos
        .map(([, k]) => {
          if (SO_MEDICAMENTO.has(k)) {
            if (!med) return "n/a".padStart(10);
            return `${(((med[k as keyof Linha] as number) / med.n) * 100).toFixed(1)}%`.padStart(10);
          }
          return `${((somaTudo(k) / total) * 100).toFixed(1)}%`.padStart(10);
        })
        .join(""),
  );
  console.log(
    "\nDCI / ATC / Grupo Homogéneo medidos só sobre MEDICAMENTO" +
      (med ? ` (${med.n} produtos)` : "") + ".",
  );

  // Onde está o défice em número absoluto de campos por preencher — é isto
  // que ordena o trabalho, não a percentagem.
  console.log("\n=== CAMPOS EM FALTA (absoluto), por tipo ===\n");
  const falta: Array<{ tipo: string; campo: string; n: number }> = [];
  for (const r of rows) {
    for (const [label, k] of campos) {
      if (SO_MEDICAMENTO.has(k) && r.tipo !== "MEDICAMENTO") continue;
      const v = r[k as keyof Linha] as number;
      if (r.n - v > 0) falta.push({ tipo: r.tipo, campo: label.trim(), n: r.n - v });
    }
  }
  falta.sort((a, b) => b.n - a.n);
  for (const f of falta.slice(0, 20)) {
    console.log(`  ${String(f.n).padStart(6)}  ${f.campo.padEnd(12)} ${f.tipo}`);
  }
  console.log(`\n  total de campos por preencher: ${falta.reduce((s, f) => s + f.n, 0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
