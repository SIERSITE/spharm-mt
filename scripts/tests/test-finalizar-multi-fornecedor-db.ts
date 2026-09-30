/**
 * scripts/tests/test-finalizar-multi-fornecedor-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL — nunca uma base verdadeira.
 *
 *   docker run -d --name spharm-ws-test-pg-areaB -e POSTGRES_PASSWORD=test -p 55434:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55434/postgres npx tsx scripts/tests/test-finalizar-multi-fornecedor-db.ts
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 *
 * Cobre:
 *   A · regressão do fix de `numero`/`designacaoSnapshot` no caminho de
 *       fornecedor ÚNICO (createEncomendaWithOutbox directo E
 *       finalizeAndQueueOrder sobre um rascunho existente) — nenhum dos
 *       dois caminhos pré-existentes deixa de funcionar.
 *   B · divisão real por fornecedor: rascunho com 120+95+85 linhas em 3
 *       fornecedores distintos → exactamente 3 ListaEncomenda FINALIZADA,
 *       contagens de linha correctas, `numero` real (EN-######, todos
 *       distintos), `loteOrigemId` correcto nos 3, rascunho original em
 *       loteDivididoEm preenchido, continua legível com todas as linhas.
 *   C · idempotência: retry com a MESMA batchKey devolve o MESMO
 *       resultado; concorrência real (Promise.all) nunca duplica;
 *       payload diferente sob a mesma chave é um conflito explícito.
 *   D · linha sem fornecedor bloqueia a finalização (nenhuma alteração).
 *   E · cancelar um dos 3 documentos gerados não afecta os irmãos nem o
 *       rascunho original.
 *   F · PDF real de cada documento gerado contém SÓ o seu próprio
 *       fornecedor e as suas próprias linhas.
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}
async function rejeita(fn: () => Promise<unknown>, teste: (e: unknown) => boolean = () => true): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return teste(e); }
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55434/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
function urlDe(db: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

async function extrairTexto(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  return result.text;
}

async function main() {
  const dbName = `spharm_multiforn_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbName) }, encoding: "utf8" });
    // `loadOrderDetail` usa getPrisma(), que fora de request context cai
    // no cliente legacy construído a partir de DATABASE_URL — ver
    // test-reimpressao-documentos-db.ts para o mesmo cuidado.
    process.env.DATABASE_URL = urlDe(dbName);

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbName) }) });

    const { createEncomendaWithOutbox, finalizeAndQueueOrder } = await import("../../lib/ingest/orders");
    const {
      finalizarEncomendaMultiFornecedor,
      LinhasSemFornecedorError,
      IdempotencyConflictError,
    } = await import("../../lib/encomendas/finalizar-multi-fornecedor");
    const { ConflitoVersaoError } = await import("../../lib/encomendas/autosave");
    const { loadOrderDetail } = await import("../../lib/encomendas/order-detail");
    const { buildEncomendaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-documento");
    const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

    const farmacia = await prisma.farmacia.create({ data: { nome: "Farmácia Teste MultiFornecedor" } });
    const utilizador = await prisma.utilizador.create({ data: { email: "u-multiforn@t.pt", nome: "U", perfil: "ADMINISTRADOR" } });
    const [fornA, fornB, fornC] = await Promise.all([
      prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR ALFA", nome: "Fornecedor Alfa" } }),
      prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR BETA", nome: "Fornecedor Beta" } }),
      prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR GAMA", nome: "Fornecedor Gama" } }),
    ]);

    let proximoCnp = 900_000;
    async function criarProdutos(n: number, prefixo: string) {
      const data = Array.from({ length: n }, (_, i) => ({ cnp: proximoCnp++, designacao: `${prefixo} ${i + 1}` }));
      const criados = await prisma.produto.createManyAndReturn({ data });
      return criados;
    }

    async function criarRascunhoComLinhas(
      nome: string,
      grupos: Array<{ fornecedorId: string | null; produtos: Array<{ id: string }> }>
    ) {
      const linhas = grupos.flatMap((g) =>
        g.produtos.map((p) => ({
          produtoId: p.id,
          quantidadeAjustada: 1,
          fornecedorSugeridoId: g.fornecedorId,
        }))
      );
      const criado = await createEncomendaWithOutbox(prisma, "t", {
        farmaciaId: farmacia.id,
        criadoPorId: utilizador.id,
        nome,
        finalize: false,
        linhas,
      });
      return criado.listaEncomendaId;
    }

    // ── A · regressão: caminho de fornecedor único continua a funcionar ──
    console.log("\nA · numero/designacaoSnapshot não quebram o caminho de fornecedor único");
    {
      const [pA1, pA2] = await criarProdutos(2, "Produto Único A");
      const r = await createEncomendaWithOutbox(prisma, "t", {
        farmaciaId: farmacia.id,
        criadoPorId: utilizador.id,
        nome: "Encomenda fornecedor único",
        finalize: true,
        linhas: [
          { produtoId: pA1.id, quantidadeAjustada: 3, fornecedorSugeridoId: fornA.id },
          { produtoId: pA2.id, quantidadeAjustada: 5, fornecedorSugeridoId: fornA.id },
        ],
      });
      check(r.numero !== null && /^EN-\d{6}$/.test(r.numero), "A1: createEncomendaWithOutbox(finalize=true) atribui numero real no formato EN-######", String(r.numero));
      const linhasGravadas = await prisma.linhaEncomenda.findMany({ where: { listaEncomendaId: r.listaEncomendaId } });
      check(linhasGravadas.every((l) => l.designacaoSnapshot != null), "A2: designacaoSnapshot capturado em todas as linhas na finalização directa");

      // Renomeia o produto DEPOIS da finalização — a reimpressão tem de
      // continuar a mostrar o texto antigo (snapshot), nunca o novo.
      await prisma.produto.update({ where: { id: pA1.id }, data: { designacao: "NOME NOVO DEPOIS DE FINALIZAR" } });
      const detail = await loadOrderDetail(r.listaEncomendaId);
      check(!!detail && detail.linhas.some((l) => l.designacao === "Produto Único A 1"), "A3: reimpressão mostra a designação SNAPSHOT, imune ao rename do produto depois de finalizado");
      check(!!detail && !detail.linhas.some((l) => l.designacao === "NOME NOVO DEPOIS DE FINALIZAR"), "A4: o nome novo NUNCA aparece na reimpressão desta linha");

      // Caminho B: rascunho criado em RASCUNHO, finalizado DEPOIS via
      // finalizeAndQueueOrder — o gap pré-existente que esta revisão fecha.
      const [pB1] = await criarProdutos(1, "Produto Único B");
      const rascunho = await createEncomendaWithOutbox(prisma, "t", {
        farmaciaId: farmacia.id, criadoPorId: utilizador.id, nome: "Rascunho a finalizar depois", finalize: false,
        linhas: [{ produtoId: pB1.id, quantidadeAjustada: 1, fornecedorSugeridoId: fornB.id }],
      });
      check(rascunho.numero === null, "A5: rascunho (finalize=false) NUNCA tem numero");
      const finalizado = await finalizeAndQueueOrder(prisma, "t", rascunho.listaEncomendaId);
      check(finalizado.numero !== null && /^EN-\d{6}$/.test(finalizado.numero), "A6: finalizeAndQueueOrder também atribui numero real (o gap que este trabalho fecha)", String(finalizado.numero));
      const linhaB = await prisma.linhaEncomenda.findFirst({ where: { listaEncomendaId: rascunho.listaEncomendaId } });
      check(linhaB?.designacaoSnapshot === "Produto Único B 1", "A7: finalizeAndQueueOrder também captura designacaoSnapshot no momento da finalização");
      check(r.numero !== finalizado.numero, "A8: numeros de documentos diferentes são distintos entre si");
    }

    // ── B · divisão real 120+95+85 ──────────────────────────────────────
    console.log("\nB · divisão em 3 documentos por fornecedor (120+95+85 linhas)");
    let loteId = "";
    let documentosB: Array<{ fornecedorId: string; fornecedorNome: string; listaEncomendaId: string; numero: string | null; nLinhas: number }> = [];
    {
      const [prodA, prodB, prodC] = await Promise.all([
        criarProdutos(120, "Alfa"),
        criarProdutos(95, "Beta"),
        criarProdutos(85, "Gama"),
      ]);
      loteId = await criarRascunhoComLinhas("Preparação multi-fornecedor", [
        { fornecedorId: fornA.id, produtos: prodA },
        { fornecedorId: fornB.id, produtos: prodB },
        { fornecedorId: fornC.id, produtos: prodC },
      ]);
      const draftAntes = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteId }, include: { linhas: true } });
      check(draftAntes.estado === "RASCUNHO" && draftAntes.linhas.length === 300, "B1: rascunho criado com as 300 linhas (120+95+85), em RASCUNHO");

      const resultado = await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteId, batchKey: loteId });
      documentosB = resultado.documentos;
      check(!resultado.reutilizado, "B2: primeira chamada não é um replay");
      check(resultado.documentos.length === 3, "B3: exactamente 3 documentos gerados");
      check(resultado.loteOrigemId === loteId, "B4: loteOrigemId do resultado aponta para o rascunho original");

      const porFornecedor = new Map(resultado.documentos.map((d) => [d.fornecedorId, d]));
      check(porFornecedor.get(fornA.id)?.nLinhas === 120, "B5: documento do Fornecedor Alfa tem exactamente 120 linhas");
      check(porFornecedor.get(fornB.id)?.nLinhas === 95, "B6: documento do Fornecedor Beta tem exactamente 95 linhas");
      check(porFornecedor.get(fornC.id)?.nLinhas === 85, "B7: documento do Fornecedor Gama tem exactamente 85 linhas");

      const numeros = resultado.documentos.map((d) => d.numero);
      check(numeros.every((n) => n !== null && /^EN-\d{6}$/.test(n)), "B8: todos os 3 numeros são reais, no formato EN-######");
      check(new Set(numeros).size === 3, "B9: os 3 numeros são todos distintos entre si");

      const listasGeradas = await prisma.listaEncomenda.findMany({ where: { id: { in: resultado.documentos.map((d) => d.listaEncomendaId) } } });
      check(listasGeradas.every((l) => l.estado === "FINALIZADA"), "B10: as 3 listas geradas estão FINALIZADA");
      check(listasGeradas.every((l) => l.loteOrigemId === loteId), "B11: as 3 apontam loteOrigemId para o rascunho original");
      check(listasGeradas.every((l) => l.farmaciaId === farmacia.id), "B12: as 3 herdam a MESMA farmácia do rascunho original");

      const outboxGerados = await prisma.orderOutbox.count({ where: { listaEncomendaId: { in: resultado.documentos.map((d) => d.listaEncomendaId) } } });
      check(outboxGerados === 3, "B13: as 3 têm o seu próprio OrderOutbox (finalize=true propagado a cada filho)");

      const draftDepois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteId }, include: { linhas: true } });
      check(draftDepois.estado === "RASCUNHO" && draftDepois.loteDivididoEm !== null, "B14: o rascunho original ficou marcado como dividido (loteDivididoEm), estado continua RASCUNHO");
      check(draftDepois.linhas.length === 300, "B15: o rascunho original CONTINUA com as suas 300 linhas — nunca perde nada");
      check(draftDepois.versao === draftAntes.versao + 1, "B16: versão do rascunho incrementada pela transição");

      const detalheLote = await loadOrderDetail(loteId);
      check(!!detalheLote && detalheLote.loteDivididoEm !== null, "B17: o rascunho original continua legível via loadOrderDetail");
      check(detalheLote?.documentosGerados.length === 3, "B18: loadOrderDetail expõe os 3 documentos gerados");
      check(!detalheLote?.editable, "B19: o rascunho dividido não é editável");
    }

    // ── C · idempotência ─────────────────────────────────────────────────
    console.log("\nC · idempotência e concorrência");
    {
      // C1: retry exacto sobre o MESMO lote já dividido.
      const replay = await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteId, batchKey: loteId });
      check(replay.reutilizado === true, "C1: retry sobre um lote já dividido é reconhecido como replay");
      check(
        JSON.stringify([...replay.documentos].sort((a, b) => a.fornecedorId.localeCompare(b.fornecedorId))) ===
          JSON.stringify([...documentosB].sort((a, b) => a.fornecedorId.localeCompare(b.fornecedorId))),
        "C2: o replay devolve EXACTAMENTE os mesmos documentos (mesmos ids/numeros) da primeira chamada"
      );
      // C3: concorrência real — N chamadas em paralelo, MESMA batchKey,
      // sobre um lote NOVO (fresco, ainda em RASCUNHO).
      const [prodX, prodY] = await Promise.all([criarProdutos(4, "Concorrente X"), criarProdutos(3, "Concorrente Y")]);
      const loteConcorrente = await criarRascunhoComLinhas("Preparação concorrente", [
        { fornecedorId: fornA.id, produtos: prodX },
        { fornecedorId: fornB.id, produtos: prodY },
      ]);
      const batchKeyConcorrente = `${loteConcorrente}-batch`;
      const respostas = await Promise.all(
        Array.from({ length: 6 }, () =>
          finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteConcorrente, batchKey: batchKeyConcorrente })
        )
      );
      const idsOrdenados = respostas.map((r) => [...r.documentos].map((d) => d.listaEncomendaId).sort().join(","));
      check(new Set(idsOrdenados).size === 1, "C3: 6 chamadas concorrentes com a mesma batchKey devolvem TODAS o mesmo conjunto de documentos");
      const filhosConcorrente = await prisma.listaEncomenda.count({ where: { loteOrigemId: loteConcorrente } });
      check(filhosConcorrente === 2, "C4: só 2 documentos filhos foram realmente criados na BD (nunca 12, nem duplicados) — um por fornecedor");
      const loteConcorrenteDepois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteConcorrente } });
      check(loteConcorrenteDepois.estado === "RASCUNHO" && loteConcorrenteDepois.loteDivididoEm !== null, "C5: o lote concorrente terminou dividido de forma consistente");

      // C6: payload diferente sob a MESMA chave (aqui simulado com dois
      // lotes DIFERENTES a partilhar deliberadamente a mesma batchKey —
      // o que faz os filhos por fornecedor colidirem em conteúdo
      // diferente sob a mesma chave derivada) → conflito explícito, nunca
      // um duplicado silencioso.
      const [prodZ] = await Promise.all([criarProdutos(2, "Payload Diferente Z")]);
      const chavePartilhada = "chave-partilhada-teste";
      const loteZ1 = await criarRascunhoComLinhas("Lote Z1", [
        { fornecedorId: fornC.id, produtos: prodZ.slice(0, 1) },
        { fornecedorId: fornA.id, produtos: prodZ.slice(1, 2) },
      ]);
      await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteZ1, batchKey: chavePartilhada });
      const filhosZ1 = await prisma.listaEncomenda.count({ where: { loteOrigemId: loteZ1 } });
      check(filhosZ1 === 2, "C6a: lote Z1 (2 fornecedores) gerou os seus 2 documentos normalmente");

      const [prodZ2, prodZ2b] = await Promise.all([
        criarProdutos(3, "Payload Diferente Z2"),
        criarProdutos(1, "Payload Diferente Z2b"),
      ]);
      const loteZ2 = await criarRascunhoComLinhas("Lote Z2 — conteúdo diferente", [
        { fornecedorId: fornC.id, produtos: prodZ2 },
        { fornecedorId: fornA.id, produtos: prodZ2b },
      ]);
      check(
        await rejeita(
          () => finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteZ2, batchKey: chavePartilhada }),
          (e) => e instanceof IdempotencyConflictError
        ),
        "C6b: mesma batchKey com conteúdo/farmácia diferente por fornecedor → IdempotencyConflictError explícito"
      );
      const loteZ2Depois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteZ2 } });
      check(loteZ2Depois.estado === "RASCUNHO", "C7: o lote Z2 rejeitado por conflito NUNCA transitou — continua RASCUNHO intacto");
      const filhosZ2 = await prisma.listaEncomenda.count({ where: { loteOrigemId: loteZ2 } });
      check(filhosZ2 === 0, "C8: nenhum documento foi gravado para o lote Z2 rejeitado — nem sequer o fornecedor sem conflito directo");
    }

    // ── C9 · versaoEsperada desactualizada é um conflito amigável ────────
    console.log("\nC9 · versaoEsperada desactualizada");
    {
      const [pV1, pV2] = await criarProdutos(2, "Versao");
      const loteV = await criarRascunhoComLinhas("Lote versão", [
        { fornecedorId: fornA.id, produtos: [pV1] },
        { fornecedorId: fornB.id, produtos: [pV2] },
      ]);
      check(
        await rejeita(
          () => finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteV, batchKey: loteV, versaoEsperada: 999 }),
          (e) => e instanceof ConflitoVersaoError
        ),
        "C9: versaoEsperada errada → ConflitoVersaoError, nada é criado"
      );
      const loteVDepois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteV } });
      check(loteVDepois.estado === "RASCUNHO", "C9b: o lote continua RASCUNHO depois do conflito de versão");
      const ok = await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteV, batchKey: loteV, versaoEsperada: loteVDepois.versao });
      check(ok.documentos.length === 2, "C9c: com a versão certa, a finalização prossegue normalmente");
    }

    // ── D · linha sem fornecedor bloqueia tudo ──────────────────────────
    console.log("\nD · linha sem fornecedor bloqueia a finalização por inteiro");
    {
      const [pD1, pD2, pD3] = await criarProdutos(3, "Sem Fornecedor D");
      const loteD = await criarRascunhoComLinhas("Lote com linha sem fornecedor", [
        { fornecedorId: fornA.id, produtos: [pD1] },
        { fornecedorId: null, produtos: [pD2, pD3] },
      ]);
      const erro = await rejeita(
        () => finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteD, batchKey: loteD }),
        (e) => e instanceof LinhasSemFornecedorError
      );
      check(erro, "D1: draft com QUALQUER linha sem fornecedor é rejeitado (LinhasSemFornecedorError)");
      const loteDDepois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteD }, include: { linhas: true } });
      check(loteDDepois.estado === "RASCUNHO", "D2: nada mudou — o rascunho continua RASCUNHO");
      check(loteDDepois.linhas.length === 3, "D3: continua com as suas 3 linhas originais");
      const filhosD = await prisma.listaEncomenda.count({ where: { loteOrigemId: loteD } });
      check(filhosD === 0, "D4: nenhum documento filho foi criado");

      try {
        await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: loteD, batchKey: loteD });
      } catch (e) {
        check(
          e instanceof LinhasSemFornecedorError && e.produtoIdsSemFornecedor.sort().join(",") === [pD2.id, pD3.id].sort().join(","),
          "D5: o erro identifica EXACTAMENTE os produtos sem fornecedor (nunca só uma contagem)"
        );
      }
    }

    // ── E · cancelar um documento gerado não afecta os irmãos ───────────
    console.log("\nE · cancelar um documento gerado é isolado dos irmãos e do lote original");
    {
      const alvo = documentosB.find((d) => d.fornecedorId === fornB.id)!;
      const irmaos = documentosB.filter((d) => d.listaEncomendaId !== alvo.listaEncomendaId);

      // Mesma escrita que `anularListaEncomendaAction` faz — aplicada
      // directamente aqui (esse ficheiro exige sessão/`requirePermission`,
      // fora de alcance deste script puro de Node).
      await prisma.listaEncomenda.update({
        where: { id: alvo.listaEncomendaId },
        data: { estado: "ANULADA", motivoAnulacao: "Teste de isolamento", anuladoPorId: utilizador.id, anuladoEm: new Date() },
      });

      const alvoDepois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: alvo.listaEncomendaId }, include: { linhas: true } });
      check(alvoDepois.estado === "ANULADA" && alvoDepois.linhas.length === alvo.nLinhas, "E1: o documento cancelado fica ANULADA, mantém as suas linhas (nunca apagadas)");

      for (const irmao of irmaos) {
        const l = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: irmao.listaEncomendaId }, include: { linhas: true } });
        check(l.estado === "FINALIZADA" && l.linhas.length === irmao.nLinhas, `E2: o irmão (${irmao.fornecedorNome}) continua FINALIZADA com as suas ${irmao.nLinhas} linhas — não afectado`);
      }

      const loteOrigemDepois = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: loteId }, include: { linhas: true } });
      check(loteOrigemDepois.loteDivididoEm !== null && loteOrigemDepois.linhas.length === 300, "E3: o lote original continua dividido com as 300 linhas — cancelar um filho não o afecta");
    }

    // ── F · PDF real — cada documento só menciona o SEU fornecedor/linhas ─
    console.log("\nF · PDF real de cada documento gerado (extracção de texto)");
    {
      const alfa = documentosB.find((d) => d.fornecedorId === fornA.id)!;
      const gama = documentosB.find((d) => d.fornecedorId === fornC.id)!;

      const detalheAlfa = await loadOrderDetail(alfa.listaEncomendaId);
      const detalheGama = await loadOrderDetail(gama.listaEncomendaId);
      check(!!detalheAlfa && !!detalheGama, "F1: os dois documentos continuam legíveis via loadOrderDetail");

      const [reportAlfa] = buildEncomendaDocumentoReport([detalheAlfa!]);
      const [reportGama] = buildEncomendaDocumentoReport([detalheGama!]);
      check(reportAlfa.rows.length === 120 && reportGama.rows.length === 85, "F2: cada Report tem exactamente as suas próprias linhas (120 / 85)");

      const textoAlfa = await extrairTexto((await buildReportPdfBuffer(reportAlfa)).buffer);
      const textoGama = await extrairTexto((await buildReportPdfBuffer(reportGama)).buffer);

      check(textoAlfa.includes("Fornecedor Alfa"), "F3: PDF do Fornecedor Alfa identifica-o no cabeçalho");
      check(!textoAlfa.includes("Fornecedor Gama") && !textoAlfa.includes("Fornecedor Beta"), "F4: PDF do Fornecedor Alfa NUNCA menciona os outros fornecedores");
      check(textoAlfa.includes("Alfa 1") && !textoAlfa.includes("Gama 1") && !textoAlfa.includes("Beta 1"), "F5: PDF do Fornecedor Alfa só contém as SUAS linhas (produtos 'Alfa …'), nunca as de outro grupo");

      check(textoGama.includes("Fornecedor Gama"), "F6: PDF do Fornecedor Gama identifica-o no cabeçalho");
      check(!textoGama.includes("Fornecedor Alfa") && !textoGama.includes("Fornecedor Beta"), "F7: PDF do Fornecedor Gama NUNCA menciona os outros fornecedores");
      check(textoGama.includes("Gama 1") && !textoGama.includes("Alfa 1") && !textoGama.includes("Beta 1"), "F8: PDF do Fornecedor Gama só contém as SUAS linhas");
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  // `buildReportPdfBuffer` mantém um browser Puppeteer singleton nunca
  // fechado — sem process.exit explícito o processo fica vivo para sempre
  // mesmo depois do resumo impresso (mesma nota de test-documentos-pdf-texto.ts).
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
