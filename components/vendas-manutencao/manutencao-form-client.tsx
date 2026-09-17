"use client";

/**
 * components/vendas-manutencao/manutencao-form-client.tsx
 *
 * Criação/edição de uma Manutenção de Vendas — um só componente para os
 * dois modos, porque a matriz farmácia × mês e a validação da soma são
 * exactamente o mesmo mecanismo nos dois casos.
 *
 * ── O fluxo, tal como o pedido descreve ──────────────────────────────
 *
 *   parâmetros → "Calcular distribuição" → matriz proposta (editável,
 *   PVP de referência capturado agora) → ajustes manuais (opcional) →
 *   soma tem de bater E toda a farmácia com quantidade tem de ter PVP
 *   de referência → Gravar
 *
 * Editar SÓ células → "Gravar ajustes" (guardarCelulasAjustadasAction),
 * PVP de referência intocado. Editar quantidade/nº meses/período
 * inicial → a matriz actual fica desactualizada (secção 1.10: nunca
 * recalcular implicitamente) — é preciso "Recalcular" explicitamente
 * antes de voltar a poder gravar, e o recálculo NUNCA toca no PVP de
 * referência já persistido (secção 5) — só o cálculo inicial (modo
 * criar) captura PVP fresco de `ProdutoFarmacia`.
 */
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Loader2, RefreshCw, Save, X } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import {
  anularManutencaoAction,
  criarManutencaoAction,
  gerarPropostaAction,
  guardarCelulasAjustadasAction,
  guardarRecalculoAction,
  recalcularDistribuicaoAction,
} from "@/app/vendas/manutencao/actions";
import type {
  CelulaManutencao,
  FarmaciaComPvpReferencia,
  ManutencaoDetalhe,
  PesoFarmaciaExibicao,
  PesosMensaisPorFarmacia,
} from "@/lib/vendas-manutencao/tipos";
import { calcularValorBrutoCelula } from "@/lib/vendas-manutencao/valorizacao";
import {
  pesquisarProdutosManutencaoAction,
  type ManutencaoProdutoHit,
} from "@/app/vendas/manutencao/search";

const MES_LABEL = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function fmtQtd(n: number): string {
  return n.toLocaleString("pt-PT", { maximumFractionDigits: 0 });
}

function fmtEur(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function fmtPct(fracao: number): string {
  return (fracao * 100).toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}

function origemPesoMensalLabel(origem: "FARMACIA" | "GLOBAL" | "NEUTRO"): string {
  switch (origem) {
    case "FARMACIA": return "perfil histórico desta farmácia";
    case "GLOBAL": return "perfil histórico global do artigo (sem amostra própria)";
    case "NEUTRO": return "sem histórico mensal — partes iguais";
  }
}

/** Chave estável de célula — `${farmaciaId}:${ano}-${mes}`. */
function chaveCelula(farmaciaId: string, ano: number, mes: number): string {
  return `${farmaciaId}:${ano}-${mes}`;
}

type FarmaciaRef = { id: string; nome: string };

type Props = {
  farmacias: FarmaciaRef[];
} & (
  | { modo: "criar" }
  | { modo: "editar"; manutencao: ManutencaoDetalhe }
);

const HOJE = new Date();

export function ManutencaoFormClient(props: Props) {
  const editando = props.modo === "editar";
  const inicial = editando ? props.manutencao : null;

  const [produto, setProduto] = useState<ManutencaoProdutoHit | null>(
    inicial ? { id: inicial.produtoId, cnp: inicial.cnp, designacao: inicial.designacao, fabricante: null } : null,
  );
  const [buscaProduto, setBuscaProduto] = useState("");
  const [resultadosProduto, setResultadosProduto] = useState<ManutencaoProdutoHit[]>([]);
  const [aProcurar, startProcura] = useTransition();

  const [quantidadeTotal, setQuantidadeTotal] = useState<number>(inicial?.quantidadeTotal ?? 0);
  const [numMeses, setNumMeses] = useState<number>(inicial?.numMeses ?? 3);
  const [mesInicialAno, setMesInicialAno] = useState<number>(inicial?.mesInicialAno ?? HOJE.getFullYear());
  const [mesInicialMes, setMesInicialMes] = useState<number>(inicial?.mesInicialMes ?? HOJE.getMonth() + 1);

  const [celulas, setCelulas] = useState<CelulaManutencao[]>(inicial?.celulas ?? []);
  // PVP de referência — capturado uma vez na criação, NUNCA re-obtido
  // num recálculo (secção 5 do pedido). Em modo "editar" vem do que já
  // está persistido e fica sempre só-leitura nesta versão.
  const [farmaciasPvp, setFarmaciasPvp] = useState<FarmaciaComPvpReferencia[]>(inicial?.farmaciasPvp ?? []);
  const [origemAtual, setOrigemAtual] = useState<"AUTOMATICA" | "MANUAL_AJUSTADA">(
    inicial?.origemDistribuicao ?? "AUTOMATICA",
  );
  const [avisoSemHistorico, setAvisoSemHistorico] = useState<string[] | null>(null);
  // Transparência da última proposta AUTOMÁTICA (secção 4/5 do pedido) —
  // de onde vieram os pesos que decidiram a distribuição. Só existe
  // depois de um "Calcular"/"Recalcular pelo histórico" nesta sessão —
  // uma manutenção existente carregada sem recalcular ainda não tem
  // esta informação (fica sem a tabela, nunca com dados inventados).
  const [pesosFarmacia, setPesosFarmacia] = useState<PesoFarmaciaExibicao[]>([]);
  const [pesosMensais, setPesosMensais] = useState<PesosMensaisPorFarmacia[]>([]);
  const [confirmarCancelamento, setConfirmarCancelamento] = useState(false);
  // A matriz foi calculada/carregada para ESTES parâmetros — se o
  // utilizador mudar quantidade/nºmeses/período, fica desactualizada.
  const [parametrosDaMatriz, setParametrosDaMatriz] = useState(
    inicial
      ? { quantidadeTotal: inicial.quantidadeTotal, numMeses: inicial.numMeses, mesInicialAno: inicial.mesInicialAno, mesInicialMes: inicial.mesInicialMes }
      : null,
  );

  const [aCalcular, startCalculo] = useTransition();
  const [aGravar, startGravar] = useTransition();
  const [aAnular, startAnular] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [confirmarAnulacao, setConfirmarAnulacao] = useState(false);

  const parametrosMudaramDesdeCalculo =
    parametrosDaMatriz === null ||
    parametrosDaMatriz.quantidadeTotal !== quantidadeTotal ||
    parametrosDaMatriz.numMeses !== numMeses ||
    parametrosDaMatriz.mesInicialAno !== mesInicialAno ||
    parametrosDaMatriz.mesInicialMes !== mesInicialMes;

  // "Cancelar" (secção 8 do pedido) só pergunta antes de sair quando há
  // realmente algo por perder: uma proposta calculada/editada que ainda
  // não foi gravada. Um formulário virgem (create) ou uma edição que
  // não mexeu em nada (matriz igual à carregada, parâmetros iguais)
  // sai directo, sem confirmação nenhuma — a mesma distinção que
  // `parametrosMudaramDesdeCalculo` já faz para bloquear o "Gravar".
  const haAlteracoesPorGuardar = useMemo(() => {
    if (celulas.length === 0) return false;
    if (!editando) return true;
    const celulasMudaram = JSON.stringify(celulas) !== JSON.stringify(inicial?.celulas ?? []);
    return celulasMudaram || parametrosMudaramDesdeCalculo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [celulas, editando, parametrosMudaramDesdeCalculo]);

  const soma = useMemo(() => celulas.reduce((s, c) => s + c.quantidade, 0), [celulas]);
  const diferenca = Math.round(soma - quantidadeTotal);
  const somaBate = diferenca === 0;

  const meses = useMemo(() => {
    const out: { ano: number; mes: number }[] = [];
    let ano = mesInicialAno;
    let mes = mesInicialMes;
    for (let i = 0; i < numMeses; i++) {
      out.push({ ano, mes });
      mes++;
      if (mes > 12) { mes = 1; ano++; }
    }
    return out;
  }, [mesInicialAno, mesInicialMes, numMeses]);

  const farmaciasNaMatriz = useMemo(() => {
    const idsComCelula = new Set(celulas.map((c) => c.farmaciaId));
    return props.farmacias.filter((f) => idsComCelula.size === 0 || idsComCelula.has(f.id));
  }, [celulas, props.farmacias]);

  function celulaValor(farmaciaId: string, ano: number, mes: number): number {
    const chave = chaveCelula(farmaciaId, ano, mes);
    return celulas.find((c) => chaveCelula(c.farmaciaId, c.ano, c.mes) === chave)?.quantidade ?? 0;
  }

  function pvpDaFarmacia(farmaciaId: string): number | null {
    return farmaciasPvp.find((f) => f.farmaciaId === farmaciaId)?.pvpReferencia ?? null;
  }

  /** Peso mensal aplicado a UMA célula, para a tooltip — `null` se não houver proposta calculada nesta sessão. */
  function pesoMensalCelula(farmaciaId: string, ano: number, mes: number): { peso: number; origem: "FARMACIA" | "GLOBAL" | "NEUTRO" } | null {
    const doFarmacia = pesosMensais.find((p) => p.farmaciaId === farmaciaId);
    if (!doFarmacia) return null;
    const doMes = doFarmacia.pesos.find((p) => p.ano === ano && p.mes === mes);
    if (!doMes) return null;
    return { peso: doMes.peso, origem: doFarmacia.origem };
  }

  // Secção 6 — farmácia com quantidade > 0 mas sem PVP de referência.
  // Nunca 0 silencioso: fica sinalizada até o utilizador corrigir.
  const farmaciasSemPvpComQuantidade = useMemo(() => {
    const totalPorFarmacia = new Map<string, number>();
    for (const c of celulas) totalPorFarmacia.set(c.farmaciaId, (totalPorFarmacia.get(c.farmaciaId) ?? 0) + c.quantidade);
    const pvpPorFarmacia = new Map(farmaciasPvp.map((f) => [f.farmaciaId, f.pvpReferencia]));
    return farmaciasNaMatriz.filter((f) => (totalPorFarmacia.get(f.id) ?? 0) > 0 && (pvpPorFarmacia.get(f.id) ?? null) === null);
  }, [celulas, farmaciasNaMatriz, farmaciasPvp]);

  function editarCelula(farmaciaId: string, farmaciaNome: string, ano: number, mes: number, novoValor: number) {
    setOrigemAtual("MANUAL_AJUSTADA");
    setCelulas((prev) => {
      const chave = chaveCelula(farmaciaId, ano, mes);
      const existe = prev.some((c) => chaveCelula(c.farmaciaId, c.ano, c.mes) === chave);
      if (existe) {
        return prev.map((c) =>
          chaveCelula(c.farmaciaId, c.ano, c.mes) === chave ? { ...c, quantidade: novoValor } : c,
        );
      }
      return [...prev, { farmaciaId, farmaciaNome, ano, mes, quantidade: novoValor }];
    });
  }

  function editarPvpReferencia(farmaciaId: string, farmaciaNome: string, novoValor: string) {
    const num = novoValor.trim() === "" ? null : Number(novoValor);
    const valido = num !== null && Number.isFinite(num) && num > 0 ? num : null;
    setFarmaciasPvp((prev) => {
      const existe = prev.some((f) => f.farmaciaId === farmaciaId);
      if (existe) return prev.map((f) => (f.farmaciaId === farmaciaId ? { ...f, pvpReferencia: valido } : f));
      return [...prev, { farmaciaId, farmaciaNome, pvpReferencia: valido }];
    });
  }

  function buscarProduto(q: string) {
    setBuscaProduto(q);
    if (q.trim().length < 2) {
      setResultadosProduto([]);
      return;
    }
    startProcura(async () => {
      const r = await pesquisarProdutosManutencaoAction(q);
      setResultadosProduto(r);
    });
  }

  function calcularOuRecalcular() {
    if (!produto) {
      setErro("Escolhe um artigo primeiro.");
      return;
    }
    setErro(null);
    setSucesso(null);
    startCalculo(async () => {
      const params = { produtoId: produto.id, quantidadeTotal, numMeses, mesInicialAno, mesInicialMes };
      if (!editando) {
        // Criação: distribuição + PVP de referência capturado agora.
        const r = await gerarPropostaAction(params);
        if (!r.ok) { setErro(r.erro); return; }
        setCelulas(r.proposta.celulas);
        setFarmaciasPvp(r.proposta.farmaciasPvp);
        setOrigemAtual("AUTOMATICA");
        setParametrosDaMatriz({ quantidadeTotal, numMeses, mesInicialAno, mesInicialMes });
        setAvisoSemHistorico(r.proposta.aviso ? r.proposta.aviso.farmaciasSemHistorico : null);
        setPesosFarmacia(r.proposta.pesosFarmacia);
        setPesosMensais(r.proposta.pesosMensais);
        return;
      }
      // Edição — "Recalcular pelo histórico": reconstrói a proposta do
      // ZERO a partir do histórico (nunca lê a matriz anterior, mesmo
      // que tenha sido ajustada à mão — secção 7 do pedido). SÓ a
      // distribuição muda: o PVP de referência (farmaciasPvp) fica
      // exactamente como estava (secção 5 do pedido).
      const r = await recalcularDistribuicaoAction(params);
      if (!r.ok) { setErro(r.erro); return; }
      setCelulas(r.proposta.celulas);
      setOrigemAtual("AUTOMATICA");
      setParametrosDaMatriz({ quantidadeTotal, numMeses, mesInicialAno, mesInicialMes });
      setAvisoSemHistorico(r.proposta.aviso ? r.proposta.aviso.farmaciasSemHistorico : null);
      setPesosFarmacia(r.proposta.pesosFarmacia);
      setPesosMensais(r.proposta.pesosMensais);
    });
  }

  function cancelar() {
    if (haAlteracoesPorGuardar) {
      setConfirmarCancelamento(true);
      return;
    }
    window.location.href = "/vendas/manutencao";
  }

  function gravar() {
    if (!somaBate) {
      setErro(`A soma das células (${fmtQtd(soma)}) não bate com a quantidade total (${fmtQtd(quantidadeTotal)}).`);
      return;
    }
    if (!produto) {
      setErro("Escolhe um artigo primeiro.");
      return;
    }
    if (farmaciasSemPvpComQuantidade.length > 0) {
      setErro(`Falta o PVP de referência para: ${farmaciasSemPvpComQuantidade.map((f) => f.nome).join(", ")}.`);
      return;
    }
    setErro(null);
    startGravar(async () => {
      if (!editando) {
        const r = await criarManutencaoAction({
          produtoId: produto.id,
          cnp: produto.cnp,
          quantidadeTotal,
          numMeses,
          mesInicialAno,
          mesInicialMes,
          origemDistribuicao: origemAtual,
          celulas,
          farmaciasPvp,
        });
        if (!r.ok) { setErro(r.erro); return; }
        window.location.href = `/vendas/manutencao/${r.id}`;
        return;
      }

      // Editar: se os parâmetros mudaram, isto só pode acontecer depois
      // de um "Recalcular" (parametrosMudaramDesdeCalculo já teria
      // bloqueado o botão de gravar antes disso) — grava como recálculo.
      const r = parametrosMudaramDesdeCalculo || origemAtual === "AUTOMATICA"
        ? await guardarRecalculoAction({
            id: props.manutencao.id,
            produtoId: produto.id,
            quantidadeTotal,
            numMeses,
            mesInicialAno,
            mesInicialMes,
            celulas,
            farmaciasPvp,
          })
        : await guardarCelulasAjustadasAction({
            id: props.manutencao.id,
            quantidadeTotal,
            celulas,
            farmaciasPvp,
          });
      if (!r.ok) { setErro(r.erro); return; }
      setSucesso("Gravado.");
      setParametrosDaMatriz({ quantidadeTotal, numMeses, mesInicialAno, mesInicialMes });
    });
  }

  function anular() {
    if (!editando) return;
    startAnular(async () => {
      const r = await anularManutencaoAction(props.manutencao.id);
      if (!r.ok) { setErro(r.erro); return; }
      window.location.href = "/vendas/manutencao";
    });
  }

  const podeGravar =
    celulas.length > 0 && somaBate && farmaciasSemPvpComQuantidade.length === 0 && !parametrosMudaramDesdeCalculo && !aGravar;
  const jaAnulada = editando && props.manutencao.estado === "ANULADA";
  const valorBrutoTotal = farmaciasNaMatriz.reduce((s, f) => {
    const totalFarmacia = meses.reduce((acc, m) => acc + celulaValor(f.id, m.ano, m.mes), 0);
    const v = calcularValorBrutoCelula(totalFarmacia, pvpDaFarmacia(f.id));
    return v === null ? s : s + v;
  }, 0);

  return (
    <AppShell>
      <div className="max-w-6xl space-y-4">
        <section className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <div className="text-xs font-medium text-slate-500">
              <Link href="/vendas/manutencao" className="hover:underline">Vendas · Manutenção de Vendas</Link>
            </div>
            <h1 className="text-[24px] font-semibold tracking-tight text-slate-900">
              {editando ? "Editar manutenção" : "Nova manutenção"}
            </h1>
          </div>
          {editando && !jaAnulada && (
            <button
              type="button"
              onClick={() => setConfirmarAnulacao(true)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-xl border border-rose-200 px-3 py-1.5 text-[13px] font-medium text-rose-600 transition hover:bg-rose-50"
            >
              <Ban className="h-4 w-4" aria-hidden />
              Anular
            </button>
          )}
        </section>

        {jaAnulada && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
            Esta manutenção está anulada — já não contribui para o mapa de Vendas. Fica em
            modo de consulta.
          </div>
        )}

        {erro && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{erro}</span>
          </div>
        )}
        {sucesso && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700">
            {sucesso}
          </div>
        )}

        {/* ── Artigo ── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Artigo</div>
          {!editando ? (
            <div className="relative mt-2">
              <input
                type="text"
                value={produto ? `${produto.designacao} (CNP ${produto.cnp})` : buscaProduto}
                onChange={(e) => { setProduto(null); buscarProduto(e.target.value); }}
                placeholder="Procurar por CNP, designação ou fabricante…"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
                disabled={jaAnulada}
              />
              {aProcurar && <div className="mt-1 text-[12px] text-slate-400">a procurar…</div>}
              {!produto && resultadosProduto.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                  {resultadosProduto.map((r) => (
                    <li
                      key={r.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setProduto(r);
                        setResultadosProduto([]);
                        setBuscaProduto("");
                      }}
                      className="cursor-pointer border-b border-slate-50 px-3 py-2 last:border-b-0 hover:bg-slate-50"
                    >
                      <div className="text-[13px] font-medium text-slate-900">{r.designacao}</div>
                      <div className="text-[11px] text-slate-500">
                        CNP {r.cnp}{r.fabricante ? ` · ${r.fabricante}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="mt-2 text-[14px] font-medium text-slate-900">
              {produto?.designacao} <span className="font-mono text-[12px] text-slate-500">CNP {produto?.cnp}</span>
            </div>
          )}
        </section>

        {/* ── Parâmetros ── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Distribuição</div>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="text-[12px] text-slate-600">Quantidade total</span>
              <input
                type="number"
                min={0}
                step={1}
                value={quantidadeTotal}
                onChange={(e) => setQuantidadeTotal(Math.round(Number(e.target.value)))}
                disabled={jaAnulada}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] focus:border-cyan-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-slate-600">Nº de meses</span>
              <input
                type="number"
                min={1}
                max={36}
                step={1}
                value={numMeses}
                onChange={(e) => setNumMeses(Math.round(Number(e.target.value)))}
                disabled={jaAnulada}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] focus:border-cyan-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-slate-600">Mês inicial</span>
              <select
                value={mesInicialMes}
                onChange={(e) => setMesInicialMes(Number(e.target.value))}
                disabled={jaAnulada}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] focus:border-cyan-400 focus:outline-none"
              >
                {MES_LABEL.map((l, i) => (
                  <option key={l} value={i + 1}>{l}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] text-slate-600">Ano inicial</span>
              <input
                type="number"
                step={1}
                value={mesInicialAno}
                onChange={(e) => setMesInicialAno(Math.round(Number(e.target.value)))}
                disabled={jaAnulada}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] focus:border-cyan-400 focus:outline-none"
              />
            </label>
          </div>

          {parametrosMudaramDesdeCalculo && celulas.length > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Os parâmetros mudaram desde o último cálculo — a matriz abaixo está
                desactualizada. Recalcula antes de gravar (nunca recalculamos sozinhos).
                {editando && " O PVP de referência já gravado não é afectado."}
              </span>
            </div>
          )}

          {!jaAnulada && (
            <button
              type="button"
              onClick={calcularOuRecalcular}
              disabled={aCalcular || !produto}
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-[13px] font-medium text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50"
            >
              {aCalcular ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              {celulas.length === 0 ? "Calcular distribuição" : "Recalcular pelo histórico"}
            </button>
          )}
        </section>

        {avisoSemHistorico && avisoSemHistorico.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              Sem histórico de vendas reais (naturezaVenda NORMAL) nos últimos 12 meses
              completos para{" "}
              {avisoSemHistorico
                .map((id) => props.farmacias.find((f) => f.id === id)?.nome ?? id)
                .join(", ")}
              . A distribuição para {avisoSemHistorico.length === props.farmacias.length ? "estas farmácias começa em partes iguais" : "estas farmácias ficou a 0"} — ajusta manualmente conforme necessário.
            </span>
          </div>
        )}

        {farmaciasSemPvpComQuantidade.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              Sem PVP de referência válido para{" "}
              <strong>{farmaciasSemPvpComQuantidade.map((f) => f.nome).join(", ")}</strong>, mas
              há quantidade atribuída. Nunca é assumido 0 como preço —{" "}
              {editando
                ? "esta versão não permite definir um PVP novo numa edição; remove a quantidade dessa farmácia ou aguarda uma acção futura de actualização de preços."
                : "indica o PVP manualmente na tabela abaixo antes de gravar."}
            </span>
          </div>
        )}

        {/* ── Transparência do peso histórico (secção 4/5 do pedido) ──
            Discreto de propósito — um <details> fechado por omissão,
            só para quando o utilizador quer perceber PORQUE a proposta
            saiu assim antes de gravar. Só existe depois de um
            "Calcular"/"Recalcular pelo histórico" nesta sessão. */}
        {pesosFarmacia.length > 0 && (
          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-[13px] font-medium text-slate-700">
              Como foi calculada esta distribuição?
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Peso histórico por farmácia (últimos 12 meses completos, vendas normais)
                </div>
                <table className="mt-1.5 w-full max-w-md text-[12px]">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 font-medium">Farmácia</th>
                      <th className="py-1 text-right font-medium">Peso hist.</th>
                      <th className="py-1 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pesosFarmacia.map((p) => {
                      const total = celulas.filter((c) => c.farmaciaId === p.farmaciaId).reduce((s, c) => s + c.quantidade, 0);
                      return (
                        <tr key={p.farmaciaId} className="border-t border-slate-100">
                          <td className="py-1 text-slate-700">{p.farmaciaNome}</td>
                          <td className="py-1 text-right text-slate-700">{p.temHistorico ? fmtPct(p.peso) : "sem histórico"}</td>
                          <td className="py-1 text-right font-medium text-slate-900">{fmtQtd(total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="text-[12px] text-slate-500">
                Peso mensal: cada célula da matriz abaixo mostra, ao passar o rato, a
                percentagem aplicada e a origem (perfil desta farmácia, perfil global do
                artigo, ou sem histórico).
              </div>
            </div>
          </details>
        )}

        {/* ── Matriz farmácia × mês ── */}
        {celulas.length > 0 && (
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 font-medium">Farmácia</th>
                    <th className="px-2 py-2 text-right font-medium">PVP ref.</th>
                    {meses.map((m) => (
                      <th key={`${m.ano}-${m.mes}`} className="px-2 py-2 text-right font-medium">
                        {MES_LABEL[m.mes - 1]}/{String(m.ano).slice(-2)}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                    <th className="px-3 py-2 text-right font-medium">Valor bruto</th>
                  </tr>
                </thead>
                <tbody>
                  {farmaciasNaMatriz.map((f) => {
                    const totalFarmacia = meses.reduce((s, m) => s + celulaValor(f.id, m.ano, m.mes), 0);
                    const pvpRef = pvpDaFarmacia(f.id);
                    const semPvp = totalFarmacia > 0 && pvpRef === null;
                    const valorBrutoFarmacia = calcularValorBrutoCelula(totalFarmacia, pvpRef);
                    return (
                      <tr key={f.id} className={`border-b border-slate-100 last:border-b-0 ${semPvp ? "bg-rose-50/60" : ""}`}>
                        <td className="px-3 py-1.5 font-medium text-slate-800">{f.nome}</td>
                        <td className="px-2 py-1 text-right">
                          {!editando ? (
                            <input
                              type="number"
                              step="0.0001"
                              min={0}
                              value={pvpRef ?? ""}
                              placeholder={semPvp ? "sem PVP" : ""}
                              onChange={(e) => editarPvpReferencia(f.id, f.nome, e.target.value)}
                              className={`w-20 rounded-md border px-1.5 py-1 text-right text-[12px] focus:outline-none ${
                                semPvp ? "border-rose-300 focus:border-rose-400" : "border-slate-200 focus:border-cyan-400"
                              }`}
                            />
                          ) : (
                            <span className={semPvp ? "font-medium text-rose-600" : "text-slate-700"}>
                              {pvpRef !== null ? fmtEur(pvpRef) : "sem PVP"}
                            </span>
                          )}
                        </td>
                        {meses.map((m) => {
                          const pesoMes = pesoMensalCelula(f.id, m.ano, m.mes);
                          return (
                            <td key={`${m.ano}-${m.mes}`} className="px-1.5 py-1">
                              <input
                                type="number"
                                step={1}
                                value={celulaValor(f.id, m.ano, m.mes)}
                                disabled={jaAnulada}
                                onChange={(e) => editarCelula(f.id, f.nome, m.ano, m.mes, Math.round(Number(e.target.value)))}
                                title={pesoMes ? `Peso histórico aplicado: ${fmtPct(pesoMes.peso)} (${origemPesoMensalLabel(pesoMes.origem)})` : undefined}
                                className="w-16 rounded-md border border-slate-200 px-1.5 py-1 text-right text-[12px] focus:border-cyan-400 focus:outline-none"
                              />
                            </td>
                          );
                        })}
                        <td className="px-3 py-1.5 text-right font-medium text-slate-700">{fmtQtd(totalFarmacia)}</td>
                        <td className="px-3 py-1.5 text-right text-slate-600">{fmtEur(valorBrutoFarmacia)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900">
                    <td className="px-3 py-2">TOTAL</td>
                    <td className="px-2 py-2" />
                    {meses.map((m) => {
                      const totalMes = farmaciasNaMatriz.reduce((s, f) => s + celulaValor(f.id, m.ano, m.mes), 0);
                      return (
                        <td key={`${m.ano}-${m.mes}`} className="px-2 py-2 text-right">{fmtQtd(totalMes)}</td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">{fmtQtd(soma)}</td>
                    <td className="px-3 py-2 text-right">{fmtEur(valorBrutoTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className={`flex items-center justify-between border-t px-4 py-2.5 text-[13px] ${somaBate ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
              <span>
                Soma: <strong>{fmtQtd(soma)}</strong> · Quantidade total: <strong>{fmtQtd(quantidadeTotal)}</strong>
                {!somaBate && <> · Diferença: <strong>{fmtQtd(diferenca)}</strong></>}
              </span>
              {somaBate ? <span>✓ bate certo</span> : <span>não bate — corrige antes de gravar</span>}
            </div>
          </section>
        )}

        {!jaAnulada && (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelar}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50"
            >
              <X className="h-4 w-4" aria-hidden />
              Cancelar
            </button>
            {celulas.length > 0 && (
              <button
                type="button"
                onClick={gravar}
                disabled={!podeGravar}
                className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {aGravar ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                Gravar
              </button>
            )}
          </div>
        )}
      </div>

      {confirmarCancelamento && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-[15px] font-semibold text-slate-900">Descartar alterações?</h2>
            <p className="mt-2 text-[13px] text-slate-600">
              Há uma distribuição calculada ou ajustada que ainda não foi gravada. Sair agora
              perde-a — nada é gravado.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmarCancelamento(false)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50"
              >
                Continuar a editar
              </button>
              <button
                type="button"
                onClick={() => { window.location.href = "/vendas/manutencao"; }}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-rose-700"
              >
                Descartar e sair
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmarAnulacao && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-[15px] font-semibold text-slate-900">Anular manutenção?</h2>
            <p className="mt-2 text-[13px] text-slate-600">
              Deixa imediatamente de contribuir para o mapa de Vendas. O histórico fica
              preservado.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmarAnulacao(false)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={aAnular}
                onClick={anular}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {aAnular ? "A anular…" : "Anular"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
