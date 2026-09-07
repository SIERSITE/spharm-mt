/**
 * scripts/diagnostics/revisoes-globais.ts
 *
 * As divergências entre o catálogo global e os tenants — que até agora
 * eram escritas e nunca lidas.
 *
 * READ-ONLY. A sessão é posta em `default_transaction_read_only` antes de
 * qualquer consulta: mesmo que alguém acrescente aqui uma escrita por
 * distracção, a base recusa-a.
 *
 * Uso:
 *   npm run diag:revisoes-globais
 *   npm run diag:revisoes-globais -- --tenant=garantia
 *   npm run diag:revisoes-globais -- --cnp=5678901
 *   npm run diag:revisoes-globais -- --resolvidas --limite=50
 *
 * Para resolver uma delas:  npm run catalog:resolver-revisao
 */
import "dotenv/config";
import { controlPrisma } from "../../lib/control-plane";
import {
  contarPorSnapshot,
  duplicadosRevisoesGlobais,
  listarRevisoesGlobais,
  resumoRevisoesGlobais,
  SNAPSHOT_SEM_CLASSIFICACAO,
  type EstadoRevisao,
} from "../../lib/catalog/revisao-global";

const nf = (n: number) => n.toLocaleString("pt-PT");
const pad = (n: number | string, w = 7) => String(nf(Number(n) || 0)).padStart(w);
const linha = (s = "") => console.log(s);
const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
const corta = (s: string | null, n: number) => (s ?? "—").slice(0, n).padEnd(n);

const valor = (argv: string[], nome: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=").trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  linha("SPharm.MT · revisões do catálogo global · READ-ONLY");

  const tenantSlug = valor(argv, "tenant");
  const cnpBruto = valor(argv, "cnp");
  const tipo = valor(argv, "tipo");
  const limite = Number(valor(argv, "limite") ?? 40);
  const estado: EstadoRevisao = argv.includes("--todas")
    ? "TODAS"
    : argv.includes("--resolvidas")
      ? "RESOLVIDA"
      : "PENDENTE";

  if (cnpBruto !== undefined && !/^\d+$/.test(cnpBruto)) {
    console.error(`\n--cnp="${cnpBruto}" não é um número.\n`);
    process.exit(2);
  }
  const cnp = cnpBruto ? Number(cnpBruto) : undefined;

  // Read-only à porta da base, não por disciplina de quem escreve aqui.
  await controlPrisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  linha("═".repeat(96));
  linha(
    `  control plane · estado=${estado}` +
      `${tenantSlug ? ` · tenant=${tenantSlug}` : ""}` +
      `${cnp ? ` · cnp=${cnp}` : ""}` +
      `${tipo ? ` · tipo=${tipo}` : ""}`,
  );
  linha("═".repeat(96));

  // ── PARTE 1 · o total ─────────────────────────────────────────────
  const resumo = await resumoRevisoesGlobais();
  linha("");
  linha("  1 · TOTAIS");
  linha(`      por resolver ......... ${pad(resumo.pendentes)}`);
  linha(`      resolvidas ........... ${pad(resumo.resolvidas)}`);
  linha(`      mais antiga aberta ... ${dia(resumo.maisAntiga)}`);

  if (resumo.porTenant.length > 0) {
    linha("");
    linha("      por tenant:");
    for (const t of resumo.porTenant) linha(`        ${t.tenantSlug.padEnd(24)} ${pad(t.n)}`);
  }
  if (resumo.porTipo.length > 0) {
    linha("");
    linha("      por tipo:");
    for (const t of resumo.porTipo) linha(`        ${t.tipo.padEnd(24)} ${pad(t.n)}`);
  }

  // ── PARTE 2 · duplicados ──────────────────────────────────────────
  //
  // Mede-se antes de se propor uma restrição na base: um índice único
  // parcial rebenta se já houver duplicados.
  const dups = await duplicadosRevisoesGlobais();
  linha("");
  linha("  2 · DUPLICADOS POR RESOLVER  (mesmo cnp + tenant + tipo)");
  if (dups.length === 0) {
    linha("      nenhum — a guarda do store tem chegado.");
  } else {
    linha(`      ${pad(dups.length)} grupos com mais do que uma linha aberta`);
    for (const d of dups.slice(0, 15)) {
      linha(`        ${String(d.cnp).padEnd(10)} ${d.tenantSlug.padEnd(20)} ${d.tipo.padEnd(16)} ×${d.n}`);
    }
    if (dups.length > 15) linha(`        (mais ${nf(dups.length - 15)})`);
  }

  // ── PARTE 2b · o snapshot NAO e' o estado de hoje ─────────────────
  //
  // Esta separacao existe porque a confusao entre as duas colunas ja'
  // aconteceu, e levou a ler a origem do GLOBAL como se fosse a do
  // tenant. Sao coisas diferentes e passam a estar rotuladas como tal:
  //
  //   snapshot  — o que estava gravado na revisao quando foi detectada
  //   hoje      — o que `CatalogoGlobal` diz neste momento
  //
  // A diferenca nao e' cosmetica: uma revisao que nasceu de um global
  // vazio e cujo cnp entretanto ganhou classificacao parece um conflito
  // real se so' se olhar para hoje. Nao e'. O criterio de encerramento
  // e' o snapshot, e e' por isso que ele aparece primeiro.
  const snap = await contarPorSnapshot();

  linha("");
  linha("  2b · SNAPSHOT (na detecção)  ×  GLOBAL (hoje)");
  linha(
    `      snapshot vazio, hoje sem classificação .... ` +
      `${pad(snap.falsosSnapshot - snap.falsosMasGlobalMudou)}  falso conflito`,
  );
  linha(
    `      snapshot vazio, hoje JÁ classifica ........ ${pad(snap.falsosMasGlobalMudou)}` +
      "  falso conflito (o global mudou depois)",
  );
  linha(
    `      snapshot específico ....................... ${pad(snap.conflitosReais)}` +
      "  conflito real — fica para uma pessoa",
  );
  linha("");
  linha(`      O critério de encerramento é o snapshot ("${SNAPSHOT_SEM_CLASSIFICACAO}"),`);
  linha("      não o estado de hoje: uma revisão julga-se pelo que era verdade");
  linha("      quando foi criada.");

  // ── PARTE 3 · a lista ─────────────────────────────────────────────
  const { linhas, total } = await listarRevisoesGlobais({
    estado, tenantSlug, cnp, tipo, pageSize: limite,
  });

  linha("");
  linha(`  3 · LISTA  (${nf(linhas.length)} de ${nf(total)})`);
  if (linhas.length === 0) {
    linha("      nada a mostrar com este filtro.");
  } else {
    linha("");
    linha(
      `      ${"cnp".padEnd(10)}${"tenant".padEnd(14)}` +
        `${"snapshot global (na detecção)".padEnd(32)}${"local (no tenant)".padEnd(32)}detectada`,
    );
    linha(`      ${"─".repeat(110)}`);
    for (const r of linhas) {
      linha(
        `      ${String(r.cnp).padEnd(10)}${corta(r.tenantSlug, 14)}` +
          `${corta(r.valorGlobal, 32)}${corta(r.valorLocal, 32)}${dia(r.detectadoEm)}`,
      );
      // Linha própria, e rotulada: a origem e a confiança são do CATÁLOGO
      // GLOBAL, não do tenant. Estarem na mesma linha que a coluna
      // "local" já foi lido como sendo a origem local.
      const hoje = r.globalCategoria
        ? `${r.globalCategoria} > ${r.globalSubcategoria ?? "—"}`
        : "(sem classificação)";
      linha(
        `        global hoje: ${hoje}` +
          (r.globalOrigem
            ? `  ·  origem global ${r.globalOrigem}` +
              ` conf ${(r.globalConfidence ?? 0).toFixed(2)}` +
              ` (${r.globalVersaoRegras ?? "?"})`
            : ""),
      );
      linha(`        id=${r.id}${r.detalhe ? `  ·  ${r.detalhe}` : ""}`);
      if (r.resolvidoEm) {
        linha(
          `        resolvida ${dia(r.resolvidoEm)} por ${r.resolvidoPor ?? "(sem autor)"}` +
            `${r.resolucao ? `: ${r.resolucao}` : ""}`,
        );
      }
    }
  }

  // ── PARTE 4 · o que fazer com isto ────────────────────────────────
  linha("");
  linha("  4 · RESUMO");
  linha(`      ${pad(resumo.pendentes)} por resolver, ${pad(dups.length)} grupos duplicados`);
  linha("");
  linha("      Uma revisão NÃO altera classificações. Marcá-la como resolvida");
  linha("      regista que foi vista e o que se decidiu — nada mais:");
  linha("");
  linha("        npm run catalog:resolver-revisao -- --id=<id> \\");
  linha('          --aprovador="Nome" --motivo="..." --apply');
  linha("");
  linha("      Mudar a classificação é outro acto: catalog:promote-global");
  linha("      (global) ou a validação manual no tenant (local).");
  linha("");
  linha("      Falsos conflitos do global-sem-classificação, em bloco:");
  linha("");
  linha("        npm run catalog:encerrar-revisoes-falsas -- \\");
  linha('          --aprovador="Nome" [--apply]');
  linha("");
  linha("      Só depois do fix estar em produção — com o código antigo a");
  linha("      correr, cada project-global cria mais.");

  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
