/**
 * scripts/tests/test-designacao-silveira.ts
 *
 * Testes PUROS/estáticos da autoridade da designação da Silveirense
 * (lib/ingest/designacao-silveira.ts). A prova contra PostgreSQL real está em
 * test-designacao-silveira-db.ts e a do botão real em
 * scripts/e2e/atualizar-agora-designacao-browser.ts.
 *
 * Item 15 do pedido ("sincronização diária e «Atualizar agora» percorrem o
 * pipeline que atualiza designações") prova-se aqui, no código real.
 *
 * Corre com:  npx tsx scripts/tests/test-designacao-silveira.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  contarDecisoes,
  decidirDesignacao,
  modoParaFarmacia,
  normalizarCodigoANF,
  normalizarDesignacao,
  type EstadoAutoridadeDesignacao,
} from "../../lib/ingest/designacao-silveira";
import { parseSyncResultado } from "../../lib/sync-request/estado";
import { buildDesignacoesSql } from "../../agent/src/commands/daily-sync-runner";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`); }
};
const src = (p: string) => readFileSync(p, "utf8");

console.log("\n=== A. normalizarDesignacao ===");
{
  const NBSP = String.fromCharCode(160);
  ok("vazio/null/undefined/espaços → null", [normalizarDesignacao(""), normalizarDesignacao(null), normalizarDesignacao(undefined), normalizarDesignacao("   "), normalizarDesignacao(`${NBSP}\t\n`)].every((v) => v === null));
  ok("espaços exteriores removidos", normalizarDesignacao("  ABC  ") === "ABC");
  ok("espaços técnicos internos reduzidos a um", normalizarDesignacao(`A${NBSP}${NBSP}B\t\tC \n D`) === "A B C D");
  ok("capitalização, acentos e pontuação intactos", normalizarDesignacao("Água Oxigenada 10 Vol., 250 ml (Gen.)") === "Água Oxigenada 10 Vol., 250 ml (Gen.)");
  ok("é idempotente", normalizarDesignacao(normalizarDesignacao("  A   B ")) === "A B");
  ok("normalizarCodigoANF: trim + minúsculas", normalizarCodigoANF("  ANF-01 ") === "anf-01" && normalizarCodigoANF(null) === "");
}

console.log("\n=== B. decidirDesignacao (o contrato que o SQL cumpre) ===");
{
  const ex = (designacao: string, camposManuais: string[] = []) => ({ designacao, camposManuais });
  const d = decidirDesignacao;
  ok("produto novo (qualquer modo) → CRIAR", d({ modo: "AUTORITATIVA", existente: null, recebida: "X" }) === "CRIAR" && d({ modo: "SO_CRIACAO", existente: null, recebida: "X" }) === "CRIAR");
  ok("vazia → IGNORADA_VAZIA, mesmo sem existente", d({ modo: "AUTORITATIVA", existente: ex("A"), recebida: "  " }) === "IGNORADA_VAZIA" && d({ modo: "SO_CRIACAO", existente: null, recebida: "" }) === "IGNORADA_VAZIA");
  ok("AUTORITATIVA diferente → ALTERAR", d({ modo: "AUTORITATIVA", existente: ex("A"), recebida: "B" }) === "ALTERAR");
  ok("AUTORITATIVA igual (após normalizar) → IGUAL", d({ modo: "AUTORITATIVA", existente: ex("A B"), recebida: " A   B " }) === "IGUAL");
  ok("AUTORITATIVA só difere na capitalização → ALTERAR (a capitalização do ERP manda)", d({ modo: "AUTORITATIVA", existente: ex("PARACETAMOL"), recebida: "Paracetamol" }) === "ALTERAR");
  ok("AUTORITATIVA com ficha manual → IGNORADA_MANUAL", d({ modo: "AUTORITATIVA", existente: ex("A", ["designacao"]), recebida: "B" }) === "IGNORADA_MANUAL");
  ok("outro campo manual NÃO protege a designação", d({ modo: "AUTORITATIVA", existente: ex("A", ["flagGenerico", "dci"]), recebida: "B" }) === "ALTERAR");
  ok("SO_CRIACAO diferente → IGNORADA_ORIGEM", d({ modo: "SO_CRIACAO", existente: ex("A"), recebida: "B" }) === "IGNORADA_ORIGEM");
  ok("SO_CRIACAO igual → IGUAL", d({ modo: "SO_CRIACAO", existente: ex("A"), recebida: "A" }) === "IGUAL");
}

console.log("\n=== C. contarDecisoes (observabilidade) ===");
{
  const e = contarDecisoes("AUTORITATIVA", ["CRIAR", "ALTERAR", "ALTERAR", "IGUAL", "IGNORADA_MANUAL", "IGNORADA_VAZIA"]);
  ok("autoritativa: criadas=1 alteradas=2 jaIguais=1 manual=1 vazias=1 verificadas=4", e.criadas === 1 && e.alteradas === 2 && e.jaIguais === 1 && e.ignoradasManual === 1 && e.ignoradasVazias === 1 && e.verificadas === 4);
  const n = contarDecisoes("SO_CRIACAO", ["CRIAR", "IGNORADA_ORIGEM", "IGNORADA_ORIGEM", "IGUAL"]);
  ok("não autoritativa: criadas=1 ignoradasOrigem=2; nada é 'verificada' nem 'alterada'", n.criadas === 1 && n.ignoradasOrigemNaoAutoritativa === 2 && n.verificadas === 0 && n.alteradas === 0 && n.jaIguais === 0);
  ok("erros arrancam a zero", e.erros === 0 && n.erros === 0);
}

console.log("\n=== D. modoParaFarmacia ===");
{
  const valida: EstadoAutoridadeDesignacao = { aplica: true, valida: true, farmaciaId: "S", farmaciaNome: "Silveirense", codigoANF: "X" };
  const invalida: EstadoAutoridadeDesignacao = { aplica: true, valida: false, codigo: "AMBIGUA", mensagem: "m" };
  ok("Silveirense → AUTORITATIVA", modoParaFarmacia(valida, "S") === "AUTORITATIVA");
  ok("outra farmácia → SO_CRIACAO", modoParaFarmacia(valida, "G") === "SO_CRIACAO");
  ok("configuração inválida → SO_CRIACAO para TODAS (modo seguro)", modoParaFarmacia(invalida, "S") === "SO_CRIACAO" && modoParaFarmacia(invalida, "G") === "SO_CRIACAO");
  ok("outros tenants → LEGACY", modoParaFarmacia({ aplica: false }, "S") === "LEGACY");
}

console.log("\n=== E. Identificação segura — nada hardcoded, nada pelo nome ===");
{
  const mod = src("lib/ingest/designacao-silveira.ts");
  const codigo = mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("usa Farmacia.codigoANF + variável de ambiente", codigo.includes("codigoANF") && codigo.includes("SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF"));
  ok("não compara o nome visível da farmácia", !/\.nome\s*(===|==|\.toLowerCase|\.includes)/.test(codigo) && !/Silveirense/i.test(codigo));
  ok("não há ids/cuids gravados no código", !/c[a-z0-9]{24}/.test(codigo.replace(/\b(resolverAutoridadeDesignacao|normalizarCodigoANF|upsertProdutosComDesignacao)\b/g, "")));
  ok("não escolhe 'a primeira farmácia' (sem findFirst/[0] sobre farmácias)", !/farmacia\.findFirst/.test(codigo));
  ok("exige exactamente uma (NAO_ENCONTRADA / AMBIGUA)", codigo.includes("NAO_ENCONTRADA") && codigo.includes("AMBIGUA") && codigo.includes("candidatas.length > 1"));
  ok("o gate de tenant é a constante dedicada, distinta da de manutenção em massa", src("lib/tenant-constants.ts").includes('TENANT_DESIGNACAO_AUTORITATIVA = "silveira"'));
  ok("o agent não conhece a Silveirense (a autoridade vem sempre do servidor)", !/silveira|silveirense|segurado/i.test(src("agent/src/commands/sync-now.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  ok("nenhuma autoridade genérica: sem autoridadeCatalogo / 'farmácia principal' no código novo", !/autoridadeCatalogo|farmaciaPrincipal/i.test(mod));
}

console.log("\n=== F. Um só caminho de escrita da designação ===");
{
  const rota = src("app/api/ingest/v1/bootstrap/products/route.ts");
  ok("endpoint de produtos resolve o modo pelo módulo partilhado", rota.includes("resolverModoDesignacao("));
  ok("…e faz o upsert do Produto por upsertProdutosComDesignacao", rota.includes("upsertProdutosComDesignacao("));
  ok("…não chama bulkUpsertProdutosByCnp directamente", !/bulkUpsertProdutosByCnp\(/.test(rota));
  ok("caminho de recurso (per-row) respeita SO_CRIACAO", /modoDesignacao === "SO_CRIACAO"[\s\S]{0,120}\? undefined/.test(rota));
  ok("o modo seguro regista o erro de configuração e devolve-o na resposta", rota.includes("erroConfiguracao") && rota.includes("configuração inválida"));
  ok("resposta traz o bloco `designacoes` só quando a regra se aplica", /if \(autoridade\.aplica\)/.test(rota) && rota.includes("...(designacoes ? { designacoes } : {})"));
  const bulk = src("lib/ingest/bulk.ts");
  ok("bulkUpsertProdutosByCnp: SO_CRIACAO deixa a designação como está", /SO_CRIACAO[\s\S]{0,120}"Produto"\."designacao"/.test(bulk));
  ok("…e nos outros modos mantém `camposManuais` e o vazio-não-apaga", bulk.includes("'designacao' = ANY(\"Produto\".\"camposManuais\")") && bulk.includes("NULLIF(btrim(EXCLUDED.\"designacao\"), '')"));

  // Quem mais escreve Produto.designacao? (varredura de app/ lib/ components/)
  function walk(d: string, out: string[] = []): string[] {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === ".next") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
  }
  const escritoresSql = ["app", "lib", "components"].flatMap((r) => walk(r)).filter((f) => /"designacao"\s*=\s*(?!EXCLUDED\b)/.test(src(f)) && /UPDATE "Produto"|INSERT INTO "Produto"|ON CONFLICT/.test(src(f)));
  const norm = escritoresSql.map((f) => f.replace(/\\/g, "/")).sort();
  ok(
    "só dois ficheiros têm SQL que escreve Produto.designacao: bulk.ts e designacao-silveira.ts",
    JSON.stringify(norm) === JSON.stringify(["lib/ingest/bulk.ts", "lib/ingest/designacao-silveira.ts"]),
    JSON.stringify(norm),
  );
  const jobs = ["lib/catalog-enrichment.ts", "lib/catalog-persistence.ts", "lib/ingest/catalog-from-erp.ts", "lib/jobs/enrich-catalog.ts", "lib/jobs/regulatory-acquisition.ts", "lib/jobs/retail-enrichment.ts"];
  ok(
    "enriquecimentos/jobs (que escrevem outros campos de Produto) nunca escrevem designacao",
    jobs.every((f) => !/\bdata\s*[:=]\s*\{[^}]*\bdesignacao\s*:/.test(src(f)) && !/(dados|dadosExtra)\.designacao\s*=/.test(src(f))),
  );
  ok("a manutenção em massa nunca toca na designação", !/SET[^;]{0,200}"designacao"/.test(src("lib/catalogo/manutencao-massa.ts")));
}

console.log("\n=== G. Passo leve no servidor ===");
{
  const r = src("app/api/ingest/v1/bootstrap/products/designacoes/route.ts");
  ok("recusa (409, sem escrever) quando a farmácia não é a autoritativa", r.includes("designacao_nao_autoritativa") && r.includes("status: 409"));
  ok("usa o mesmo resolver e a mesma aplicação da regra", r.includes("resolverAutoridadeDesignacao") && r.includes("aplicarDesignacoesAutoritativas"));
  ok("não cria produtos", !/produto\.(create|upsert)/.test(r));
  ok("logs só com contagens (não regista designações nem payloads)", !/console\.log\([^)]*designacao:/.test(r));
}

console.log("\n=== H. Item 15 — diária e «Atualizar agora» percorrem o pipeline de designações ===");
{
  const syncNow = src("agent/src/commands/sync-now.ts");
  ok("«Atualizar agora» (sync-now) corre o pipeline de produtos (endpoint com a regra)", /runPipelineForDay\(\{[\s\S]{0,300}scope: "products-stock"/.test(syncNow));
  ok("…e o passo de designações do catálogo inteiro", /runDesignacoesRefresh\(\{ pool, client, farmaciaId, logger \}\)/.test(syncNow));
  ok("…e devolve designacoesAlteradas no ack", syncNow.includes("designacoesAlteradas") && syncNow.includes("ackSyncRequest"));
  const diario = src("agent/src/commands/daily-pipeline.ts");
  ok("sincronização diária: pipeline de produtos (daily-sync) via runPipelineForDay", /runPipelineForDay\(/.test(diario));
  ok("…refresh operacional do catálogo inteiro (endpoint de produtos)", /runOperationalRefresh\(/.test(diario));
  ok("…e o passo de designações", /runDesignacoesRefresh\(/.test(diario));
  const runner = src("agent/src/commands/daily-sync-runner.ts");
  ok("o endpoint de produtos recebe também o onboarding (products-upload / full-sync)", /bootstrapProducts\(/.test(src("agent/src/commands/bootstrap-upload.ts")) || /bootstrapProducts\(/.test(src("agent/src/commands/products-upload.ts")));
  const sqlD = buildDesignacoesSql();
  ok("a leitura de designações NÃO depende de data nem de 'alterado'", !/@date|Data_Actualiz|Data Ultima|StocksMov/i.test(sqlD));
  ok("…inclui artigos retirados (não filtra Retirado)", !/Retirado/i.test(sqlD));
  ok("…lê só CodigoID, Codigo e Nome Comercial", /s\.\[Nome Comercial\]/.test(sqlD) && !/Preco|ArmazensStocks|Fornecedor/i.test(sqlD));
  ok("o passo só corre se o SaaS o autorizar (GET de estado antes de qualquer leitura)", runner.indexOf("designacoesEstado(") < runner.indexOf("buildDesignacoesSql()", runner.indexOf("export async function runDesignacoesRefresh")));
  ok("falha de um lote do passo leve propaga (sync-now FALHOU / daily PARTIAL), não é engolida", !/runDesignacoesRefresh[\s\S]{0,400}catch \(\{\}\)/.test(runner));
}

console.log("\n=== I. Resultado de «Atualizar agora» e UI ===");
{
  const r1 = parseSyncResultado({ stockAtualizado: 3, produtosAtualizados: 5, fabricantesAlterados: 1, designacoesAlteradas: 7, designacoesVerificadas: 40 });
  ok("o servidor guarda designacoesAlteradas/Verificadas", r1.designacoesAlteradas === 7 && r1.designacoesVerificadas === 40);
  const r2 = parseSyncResultado({ stockAtualizado: 3, produtosAtualizados: 5, fabricantesAlterados: 1 });
  ok("sem o campo → ausente (não 0): farmácias não autoritativas não mostram o contador", r2.designacoesAlteradas === undefined && !("designacoesAlteradas" in r2));
  const r3 = parseSyncResultado({ designacoesAlteradas: -4, designacoesVerificadas: "x" });
  ok("valores inválidos descartados", r3.designacoesAlteradas === undefined && r3.designacoesVerificadas === undefined);
  const w = src("components/stock/sync-now-widget.tsx");
  ok("o botão mostra «Designações alteradas: N» só quando o contador existe", /designacoesAlteradas !== undefined[\s\S]{0,200}Designações alteradas:/.test(w));
}

console.log("\n=== J. Sem migration ===");
{
  // A última migration da revisão em produção (4b6396a) é 20260930100000_...:
  // qualquer outra, mais recente, seria desta entrega.
  const novas = readdirSync("prisma/migrations").filter((m) => /^\d{14}_/.test(m) && m.slice(0, 14) > "20260930100000");
  ok("nenhuma migration nova (usa Farmacia.codigoANF, que já existe)", novas.length === 0, novas.join(","));
  ok("schema.prisma sem campo novo de autoridade", !/designacaoAutoritativa|autoridadeCatalogo/i.test(src("prisma/schema.prisma")));
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
