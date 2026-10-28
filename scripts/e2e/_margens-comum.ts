/**
 * scripts/e2e/_margens-comum.ts
 *
 * Dados sintéticos e utilitários comuns dos ensaios de browser de Margens /
 * cabeçalhos fixos / encomendas anuladas (ambiente real: control plane +
 * servidor de produção + PostgreSQL descartável — ver `_ambiente-silveira.ts`).
 */
import * as XLSX from "xlsx";
import type { Page } from "playwright";
import type { Ambiente } from "./_ambiente-silveira";

export type Check = (cond: boolean, msg: string) => void;

/**
 * Margens NÃO gera ao alterar filtros: depois de mexer no formulário é preciso carregar em «Atualizar» (1 pedido).
 * Espera pela resposta da Server Action de geração (POST com Next-Action) e pelo botão voltar a «Atualizar».
 */
export async function atualizarMargens(page: Page): Promise<void> {
  const resposta = page.waitForResponse((r) => r.request().method() === "POST" && !!r.request().headers()["next-action"], { timeout: 60000 });
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await resposta;
  await page.getByRole("button", { name: "Atualizar", exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(300);
}

const CAB = ["Nº registo", "Substância Ativa/DCI", "Nome do medicamento", "Forma farmacêutica", "Dosagem", "Tamanho da embalagem", "CNPEM", "Preço (PVP)", "PVP Notificado", "Preço Utente", "Preço Pensionistas", "Comerc.", "Genérico"];
export function xlsBuf(rows: Array<Array<string | number | null>>): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB, ...rows]), "Medicamentos");
  return XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
}
const L = (reg: string, cnpem: number, nome: string, geral: number | null, esp: number | null, dci = "Ibuprofeno") =>
  [reg, dci, nome, "Comprimido", "400 mg", "20 unidade(s)", cnpem, 5, null, geral, esp, "Comercializado", "Não"] as Array<string | number | null>;

export const CNPEM_GRUPO = 50000001;
export const CNP = {
  A: 7200001, B: 7200002, C: 7200003, D: 7200004, E: 7200005, SO_FICHEIRO: 7299999,
  /** Mesmo CNPEM, sem vendas e sem stock em nenhuma farmácia: só aparece com «Mostrar todos». */
  F: 7200006,
  /** Ordem alfabética: minúsculas/acentos. */
  ABC: 7200007, ACIDO: 7200008,
  /** Vendas sem custo conhecido (PMC e PUC vazios). */
  SEM_CUSTO: 7200009,
};

export type Semeado = {
  userId: string;
  farmacias: { alfa: string; beta: string; gama: string };
  nomes: { alfa: string; beta: string; gama: string };
};

/**
 * Semeia: 3 farmácias; 150 artigos «VOL» com vendas e stock baixo (tabelas
 * longas, também na proposta de encomenda); o grupo CNPEM 50000001
 * (A e B vendem em Alfa; C existe em Alfa sem vendas; D só em Gama; E tem a
 * mesma DCI mas outro CNPEM; um CNP só existe no ficheiro); 30 encomendas
 * (8 anuladas, 1 eliminada) e um rascunho com 90 linhas.
 */
export async function semearMargens(amb: Ambiente): Promise<Semeado> {
  const prisma = amb.prisma;
  const user = await prisma.utilizador.create({ data: { email: "e2e@spharm.test", nome: "E2E Admin", perfil: "ADMINISTRADOR" } });
  const nomes = { alfa: "Farmacia Alfa", beta: "Farmacia Beta", gama: "Farmacia Gama" };
  const fa = await prisma.farmacia.create({ data: { nome: nomes.alfa } });
  const fb = await prisma.farmacia.create({ data: { nome: nomes.beta } });
  const fg = await prisma.farmacia.create({ data: { nome: nomes.gama } });
  const fabricante = await prisma.fabricante.create({ data: { nomeNormalizado: "LAB E2E" } });
  const agora = new Date();
  const ano = agora.getFullYear();
  const mesAtual = agora.getMonth() + 1;
  const meses = [1, 2, 3].map((d) => Math.max(1, mesAtual - d));

  const vendas = async (produtoId: string, farmaciaId: string, qty: number, preco: number) => {
    for (const mes of meses) {
      await prisma.vendaMensal.create({
        data: { farmaciaId, produtoId, ano, mes, quantidade: qty, valorTotal: qty * preco, valorBruto: qty * preco },
      });
    }
  };
  const pf = (produtoId: string, farmaciaId: string, stock: number, extra: { retirado?: boolean } = {}) =>
    prisma.produtoFarmacia.create({
      data: { produtoId, farmaciaId, pvp: 12.3, pmc: 6, puc: 5, stockAtual: stock, stockMinimo: 5, stockMaximo: 30, taxaIvaPercent: 23, flagRetirado: extra.retirado ?? false },
    });

  // ── 150 artigos «VOL» ─────────────────────────────────────────────
  for (let i = 1; i <= 150; i++) {
    const p = await prisma.produto.create({
      data: { cnp: 7100000 + i, designacao: `ARTIGO VOL ${String(i).padStart(3, "0")}`, fabricanteId: fabricante.id, estado: "VALIDADO" },
    });
    for (const f of [fa, fb, fg]) {
      await pf(p.id, f.id, 1);
      await vendas(p.id, f.id, 6 + (i % 5), 12.3);
    }
  }

  // ── Grupo CNPEM ───────────────────────────────────────────────────
  const mk = async (cnp: number, designacao: string) =>
    prisma.produto.create({ data: { cnp, designacao, dci: "Ibuprofeno", fabricanteId: fabricante.id, estado: "VALIDADO" } });
  const A = await mk(CNP.A, "IBUPROFENO A 400 (analisado)");
  const B = await mk(CNP.B, "IBUPROFENO B 400");
  const C = await mk(CNP.C, "IBUPROFENO C 400 (sem vendas)");
  const D = await mk(CNP.D, "IBUPROFENO D 400 (só em Gama)");
  const E = await mk(CNP.E, "IBUPROFENO E 600 (mesma DCI, outro CNPEM)");
  const F = await mk(CNP.F, "IBUPROFENO F 400 (sem vendas nem stock)");
  await pf(A.id, fa.id, 40); await vendas(A.id, fa.id, 10, 12.3);
  await pf(A.id, fb.id, 40); await vendas(A.id, fb.id, 4, 12.3);
  await pf(B.id, fa.id, 40); await vendas(B.id, fa.id, 7, 11.5);
  await pf(C.id, fa.id, 40);                       // existe na Alfa, não vendeu no período
  await pf(D.id, fg.id, 40); await vendas(D.id, fg.id, 9, 11);
  await pf(E.id, fa.id, 40); await vendas(E.id, fa.id, 5, 14);
  await pf(F.id, fa.id, 0);                         // existe na Alfa, sem stock e sem vendas

  // ── Ordem alfabética (sem maiúsculas/acentos) e custo desconhecido ──
  const ABC = await prisma.produto.create({ data: { cnp: CNP.ABC, designacao: "abc minúsculas E2E", fabricanteId: fabricante.id, estado: "VALIDADO" } });
  const ACIDO = await prisma.produto.create({ data: { cnp: CNP.ACIDO, designacao: "ÁCIDO ORDEM E2E", fabricanteId: fabricante.id, estado: "VALIDADO" } });
  const SC = await prisma.produto.create({ data: { cnp: CNP.SEM_CUSTO, designacao: "ZZ SEM CUSTO E2E", fabricanteId: fabricante.id, estado: "VALIDADO" } });
  await pf(ABC.id, fa.id, 3); await vendas(ABC.id, fa.id, 4, 12.3);
  await pf(ACIDO.id, fa.id, 3); await vendas(ACIDO.id, fa.id, 4, 12.3);
  await prisma.produtoFarmacia.create({ data: { produtoId: SC.id, farmaciaId: fa.id, pvp: 9, stockAtual: 3, stockMinimo: 1, stockMaximo: 5, taxaIvaPercent: 23 } });
  await vendas(SC.id, fa.id, 4, 9);

  // ── INFARMED ─────────────────────────────────────────────────────
  const { lerFicheiroInfarmed } = await import("../../lib/regulamentar/infarmed-ficheiro");
  const { aplicarVersaoInfarmed } = await import("../../lib/regulamentar/infarmed-aplicar");
  const ficheiro = lerFicheiroInfarmed(xlsBuf([
    L(String(CNP.A), CNPEM_GRUPO, "Ibuprofeno A INFARMED", 3.5, 2.1),
    L(String(CNP.B), CNPEM_GRUPO, "Ibuprofeno B INFARMED", 3.6, 2.2),
    L(String(CNP.C), CNPEM_GRUPO, "Ibuprofeno C INFARMED", 3.7, 2.3),
    L(String(CNP.D), CNPEM_GRUPO, "Ibuprofeno D INFARMED", 3.8, 2.4),
    L(String(CNP.E), 50000002, "Ibuprofeno E INFARMED", 4.5, 3.1),
    L(String(CNP.F), CNPEM_GRUPO, "Ibuprofeno F INFARMED", 3.9, 2.5),
    L(String(CNP.SO_FICHEIRO), CNPEM_GRUPO, "SO NO FICHEIRO INFARMED", 9.9, 9.9),
  ]));
  const ap = await aplicarVersaoInfarmed(prisma, ficheiro, { origem: "CARGA_INICIAL", apply: true });
  if (ap.resultado !== "APLICADA") throw new Error(`INFARMED não aplicado: ${ap.resultado} ${ap.motivo ?? ""}`);

  // ── Encomendas: 30 (8 anuladas, 1 eliminada) ─────────────────────
  const base = Date.now() - 40 * 86_400_000;
  for (let i = 1; i <= 30; i++) {
    const estado = i % 4 === 0 && i <= 32 ? "ANULADA" : i === 5 ? "ELIMINADA" : i % 3 === 0 ? "EXPORTADA" : "FINALIZADA";
    await prisma.listaEncomenda.create({
      data: {
        nome: `ENC E2E ${String(i).padStart(2, "0")}${estado === "ANULADA" ? " (anulada)" : ""}`,
        estado, farmaciaId: i % 2 ? fa.id : fb.id, criadoPorId: user.id,
        dataCriacao: new Date(base + i * 86_400_000),
        ...(estado === "ANULADA" ? { motivoAnulacao: "teste", anuladoPorId: user.id, anuladoEm: new Date() } : {}),
      },
    });
  }
  // rascunho com 90 linhas (detalhe longo)
  const rasc = await prisma.listaEncomenda.create({ data: { nome: "RASCUNHO LONGO E2E", estado: "RASCUNHO", farmaciaId: fa.id, criadoPorId: user.id } });
  const vols = await prisma.produto.findMany({ where: { cnp: { gte: 7100001, lte: 7100090 } }, orderBy: { cnp: "asc" } });
  await prisma.linhaEncomenda.createMany({
    data: vols.map((p) => ({ listaEncomendaId: rasc.id, produtoId: p.id, quantidadeSugerida: 5, quantidadeAjustada: 5 })),
  });
  return { userId: user.id, farmacias: { alfa: fa.id, beta: fb.id, gama: fg.id }, nomes };
}

/** Rects das células do cabeçalho vs. as da 1.ª linha do corpo: alinhamento exato por coluna. */
export async function alinhamentoColunas(page: Page, seletorContentor: string): Promise<{ colunas: number; maxDesvio: number }> {
  for (let t = 0; t < 4; t++) {
    const r = await alinhamentoUmaVez(page, seletorContentor);
    if (r.maxDesvio < 9999) return r;
    await page.waitForTimeout(600);
  }
  return alinhamentoUmaVez(page, seletorContentor);
}

async function alinhamentoUmaVez(page: Page, seletorContentor: string): Promise<{ colunas: number; maxDesvio: number }> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLElement;
    const ths = Array.from(c.querySelectorAll(":scope > table > thead > tr:first-child > th")) as HTMLElement[];
    const linha = Array.from(c.querySelectorAll(":scope > table > tbody > tr")).find((tr) => (tr as HTMLElement).querySelectorAll(":scope > td").length === ths.length) as HTMLElement | undefined;
    if (!linha) return { colunas: ths.length, maxDesvio: 9999 };
    const tds = Array.from(linha.querySelectorAll(":scope > td")) as HTMLElement[];
    let max = 0;
    ths.forEach((th, i) => {
      const a = th.getBoundingClientRect();
      const b = tds[i].getBoundingClientRect();
      max = Math.max(max, Math.abs(a.left - b.left), Math.abs(a.width - b.width));
    });
    return { colunas: ths.length, maxDesvio: Math.round(max * 100) / 100 };
  }, seletorContentor);
}

/** O cabeçalho está colado ao topo do contentor com scroll e visível por cima das linhas? */
export async function estadoCabecalho(page: Page, seletorContentor: string) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLElement;
    const th = c.querySelector("thead th") as HTMLElement;
    const cr = c.getBoundingClientRect();
    const tr = th.getBoundingClientRect();
    const ponto = document.elementFromPoint(tr.left + Math.min(tr.width / 2, 40), tr.top + tr.height / 2);
    const topoVisivel = Math.max(cr.top, 0);
    const bg = getComputedStyle(th).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    const alfa = m ? (m[1].split(",").length === 4 ? Number(m[1].split(",")[3]) : 1) : 0;
    return {
      scrollTop: c.scrollTop,
      desvioTopo: Math.round((tr.top - cr.top) * 100) / 100,
      visivelPorCima: !!ponto && th.contains(ponto),
      opaco: alfa === 1,
      zIndex: getComputedStyle(th).zIndex,
      contentorTopo: Math.round(topoVisivel),
    };
  }, seletorContentor);
}
