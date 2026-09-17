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
 *   parâmetros → "Calcular distribuição" → matriz proposta (editável)
 *     → ajustes manuais (opcional) → soma tem de bater → Gravar
 *
 * Editar SÓ células → "Gravar ajustes" (guardarCelulasAjustadasAction).
 * Editar quantidade/nº meses/período inicial → a matriz actual fica
 * desactualizada (secção 1.10: nunca recalcular implicitamente) — é
 * preciso "Recalcular" explicitamente antes de voltar a poder gravar.
 */
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Loader2, RefreshCw, Save } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import {
  anularManutencaoAction,
  criarManutencaoAction,
  gerarPropostaAction,
  guardarCelulasAjustadasAction,
  guardarRecalculoAction,
} from "@/app/vendas/manutencao/actions";
import type { CelulaManutencao, ManutencaoDetalhe } from "@/lib/vendas-manutencao/tipos";
import {
  pesquisarProdutosManutencaoAction,
  type ManutencaoProdutoHit,
} from "@/app/vendas/manutencao/search";

const MES_LABEL = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function fmtQtd(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString("pt-PT", { maximumFractionDigits: 3 });
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
  const [origemAtual, setOrigemAtual] = useState<"AUTOMATICA" | "MANUAL_AJUSTADA">(
    inicial?.origemDistribuicao ?? "AUTOMATICA",
  );
  const [avisoSemHistorico, setAvisoSemHistorico] = useState<string[] | null>(null);
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

  const soma = useMemo(() => celulas.reduce((s, c) => s + c.quantidade, 0), [celulas]);
  const diferenca = Math.round((soma - quantidadeTotal) * 1000) / 1000;
  const somaBate = Math.abs(diferenca) < 1e-6;

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

  function calcularDistribuicao() {
    if (!produto) {
      setErro("Escolhe um artigo primeiro.");
      return;
    }
    setErro(null);
    setSucesso(null);
    startCalculo(async () => {
      const r = await gerarPropostaAction({
        produtoId: produto.id,
        quantidadeTotal,
        numMeses,
        mesInicialAno,
        mesInicialMes,
      });
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      setCelulas(r.proposta.celulas);
      setOrigemAtual("AUTOMATICA");
      setParametrosDaMatriz({ quantidadeTotal, numMeses, mesInicialAno, mesInicialMes });
      setAvisoSemHistorico(r.proposta.aviso ? r.proposta.aviso.farmaciasSemHistorico : null);
    });
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
          })
        : await guardarCelulasAjustadasAction({
            id: props.manutencao.id,
            quantidadeTotal,
            celulas,
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

  const podeGravar = celulas.length > 0 && somaBate && !parametrosMudaramDesdeCalculo && !aGravar;
  const jaAnulada = editando && props.manutencao.estado === "ANULADA";

  return (
    <AppShell>
      <div className="max-w-5xl space-y-4">
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
                step="0.001"
                value={quantidadeTotal}
                onChange={(e) => setQuantidadeTotal(Number(e.target.value))}
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
                value={numMeses}
                onChange={(e) => setNumMeses(Number(e.target.value))}
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
                value={mesInicialAno}
                onChange={(e) => setMesInicialAno(Number(e.target.value))}
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
              </span>
            </div>
          )}

          {!jaAnulada && (
            <button
              type="button"
              onClick={calcularDistribuicao}
              disabled={aCalcular || !produto}
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-[13px] font-medium text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50"
            >
              {aCalcular ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              {celulas.length === 0 ? "Calcular distribuição" : "Recalcular distribuição"}
            </button>
          )}
        </section>

        {avisoSemHistorico && avisoSemHistorico.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              Sem histórico de vendas reais nos últimos 12 meses para{" "}
              {avisoSemHistorico
                .map((id) => props.farmacias.find((f) => f.id === id)?.nome ?? id)
                .join(", ")}
              . A distribuição para {avisoSemHistorico.length === props.farmacias.length ? "estas farmácias começa em partes iguais" : "estas farmácias ficou a 0"} — ajusta manualmente conforme necessário.
            </span>
          </div>
        )}

        {/* ── Matriz farmácia × mês ── */}
        {celulas.length > 0 && (
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 font-medium">Farmácia</th>
                    {meses.map((m) => (
                      <th key={`${m.ano}-${m.mes}`} className="px-2 py-2 text-right font-medium">
                        {MES_LABEL[m.mes - 1]}/{String(m.ano).slice(-2)}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {farmaciasNaMatriz.map((f) => {
                    const totalFarmacia = meses.reduce((s, m) => s + celulaValor(f.id, m.ano, m.mes), 0);
                    return (
                      <tr key={f.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-1.5 font-medium text-slate-800">{f.nome}</td>
                        {meses.map((m) => (
                          <td key={`${m.ano}-${m.mes}`} className="px-1.5 py-1">
                            <input
                              type="number"
                              step="0.001"
                              value={celulaValor(f.id, m.ano, m.mes)}
                              disabled={jaAnulada}
                              onChange={(e) => editarCelula(f.id, f.nome, m.ano, m.mes, Number(e.target.value))}
                              className="w-20 rounded-md border border-slate-200 px-1.5 py-1 text-right text-[12px] focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-right font-medium text-slate-700">{fmtQtd(totalFarmacia)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900">
                    <td className="px-3 py-2">TOTAL</td>
                    {meses.map((m) => {
                      const totalMes = farmaciasNaMatriz.reduce((s, f) => s + celulaValor(f.id, m.ano, m.mes), 0);
                      return (
                        <td key={`${m.ano}-${m.mes}`} className="px-2 py-2 text-right">{fmtQtd(totalMes)}</td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">{fmtQtd(soma)}</td>
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

        {!jaAnulada && celulas.length > 0 && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={gravar}
              disabled={!podeGravar}
              className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aGravar ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
              Gravar
            </button>
          </div>
        )}
      </div>

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
