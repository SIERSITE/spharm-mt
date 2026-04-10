"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  Filter,
  RefreshCw,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";

type Prioridade = "Crítica" | "Elevada" | "Normal" | "Estável";

type MonthlyMovement = {
  mes: string;
  compras: number;
  vendas: number;
};

type PurchaseHistory = {
  data: string;
  fornecedor: string;
  quantidade: number;
  precoCusto: number;
};

type SupplierCondition = {
  fornecedor: string;
  campanha: string;
  desconto: string;
  bonus: string;
};

type EncomendaFarmaciaRow = {
  cnp: string;
  produto: string;
  farmacia: string;
  stockAtual: number;
  coberturaAtual: number;
  rotacaoMedia: number;
  sugestao: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  valorEstimado: number;
  prioridade: Prioridade;
  movimentos6M: MonthlyMovement[];
  condicoesFornecedor: SupplierCondition[];
  ultimasCompras: PurchaseHistory[];
};

type GroupEncomendaRow = {
  cnp: string;
  produto: string;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  stockGrupo: number;
  sugestaoGrupo: number;
  encomendarGrupo: number;
  valorEstimado: number;
  prioridade: Prioridade;
  porFarmacia: Array<{
    farmacia: string;
    stockAtual: number;
    coberturaAtual: number;
    rotacaoMedia: number;
    sugestao: number;
    prioridade: Prioridade;
    movimentos6M: MonthlyMovement[];
    ultimasCompras: PurchaseHistory[];
  }>;
  condicoesFornecedor: SupplierCondition[];
};

type BaseRow = Omit<
  EncomendaFarmaciaRow,
  "sugestao" | "valorEstimado" | "prioridade"
>;

const mockRowsBase: BaseRow[] = [
  {
    cnp: "2401180",
    produto: "Nebilet Comp 5 mg x 28",
    farmacia: "Braga Centro",
    stockAtual: 0,
    coberturaAtual: 0,
    rotacaoMedia: 0.9,
    fornecedor: "Alliance Healthcare",
    fabricante: "Menarini",
    categoria: "Cardiovascular",
    movimentos6M: [
      { mes: "Nov", compras: 12, vendas: 10 },
      { mes: "Dez", compras: 18, vendas: 14 },
      { mes: "Jan", compras: 10, vendas: 12 },
      { mes: "Fev", compras: 14, vendas: 13 },
      { mes: "Mar", compras: 8, vendas: 15 },
      { mes: "Abr", compras: 6, vendas: 16 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Alliance Healthcare",
        campanha: "Cardio Abril",
        desconto: "4,0%",
        bonus: "2 + 1",
      },
      {
        fornecedor: "Plural",
        campanha: "Sem campanha",
        desconto: "2,0%",
        bonus: "0",
      },
    ],
    ultimasCompras: [
      {
        data: "02/04/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 4,
        precoCusto: 5.05,
      },
      {
        data: "01/04/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 3,
        precoCusto: 5.05,
      },
      {
        data: "03/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 8,
        precoCusto: 5.03,
      },
      {
        data: "05/02/2026",
        fornecedor: "Plural",
        quantidade: 6,
        precoCusto: 5.11,
      },
    ],
  },
  {
    cnp: "2401180",
    produto: "Nebilet Comp 5 mg x 28",
    farmacia: "Braga Norte",
    stockAtual: 10,
    coberturaAtual: 9,
    rotacaoMedia: 0.5,
    fornecedor: "Alliance Healthcare",
    fabricante: "Menarini",
    categoria: "Cardiovascular",
    movimentos6M: [
      { mes: "Nov", compras: 8, vendas: 5 },
      { mes: "Dez", compras: 10, vendas: 4 },
      { mes: "Jan", compras: 6, vendas: 5 },
      { mes: "Fev", compras: 4, vendas: 5 },
      { mes: "Mar", compras: 3, vendas: 4 },
      { mes: "Abr", compras: 2, vendas: 4 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Alliance Healthcare",
        campanha: "Cardio Abril",
        desconto: "4,0%",
        bonus: "2 + 1",
      },
    ],
    ultimasCompras: [
      {
        data: "29/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 5.04,
      },
      {
        data: "04/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 5.02,
      },
      {
        data: "10/02/2026",
        fornecedor: "Plural",
        quantidade: 4,
        precoCusto: 5.1,
      },
      {
        data: "15/01/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 4.99,
      },
    ],
  },
  {
    cnp: "2401180",
    produto: "Nebilet Comp 5 mg x 28",
    farmacia: "Braga Sul",
    stockAtual: 2,
    coberturaAtual: 2,
    rotacaoMedia: 1.0,
    fornecedor: "Alliance Healthcare",
    fabricante: "Menarini",
    categoria: "Cardiovascular",
    movimentos6M: [
      { mes: "Nov", compras: 10, vendas: 9 },
      { mes: "Dez", compras: 12, vendas: 11 },
      { mes: "Jan", compras: 8, vendas: 10 },
      { mes: "Fev", compras: 7, vendas: 10 },
      { mes: "Mar", compras: 6, vendas: 11 },
      { mes: "Abr", compras: 4, vendas: 12 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Alliance Healthcare",
        campanha: "Cardio Abril",
        desconto: "4,0%",
        bonus: "2 + 1",
      },
    ],
    ultimasCompras: [
      {
        data: "03/04/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 4,
        precoCusto: 5.06,
      },
      {
        data: "19/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 5,
        precoCusto: 5.04,
      },
      {
        data: "21/02/2026",
        fornecedor: "Plural",
        quantidade: 3,
        precoCusto: 5.15,
      },
      {
        data: "18/01/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 4,
        precoCusto: 5.03,
      },
    ],
  },
  {
    cnp: "5674239",
    produto: "Skudexa 75 mg + 25 mg x 20",
    farmacia: "Braga Centro",
    stockAtual: 3,
    coberturaAtual: 2,
    rotacaoMedia: 1.4,
    fornecedor: "Alliance Healthcare",
    fabricante: "Menarini",
    categoria: "Dor",
    movimentos6M: [
      { mes: "Nov", compras: 24, vendas: 19 },
      { mes: "Dez", compras: 20, vendas: 18 },
      { mes: "Jan", compras: 16, vendas: 21 },
      { mes: "Fev", compras: 12, vendas: 20 },
      { mes: "Mar", compras: 10, vendas: 22 },
      { mes: "Abr", compras: 9, vendas: 24 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Alliance Healthcare",
        campanha: "Dor Premium",
        desconto: "5,0%",
        bonus: "5%",
      },
      {
        fornecedor: "OCP",
        campanha: "Condição base",
        desconto: "2,5%",
        bonus: "0",
      },
    ],
    ultimasCompras: [
      {
        data: "04/04/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 5,
        precoCusto: 6.36,
      },
      {
        data: "29/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 6.31,
      },
      {
        data: "11/03/2026",
        fornecedor: "OCP",
        quantidade: 4,
        precoCusto: 6.42,
      },
      {
        data: "02/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 8,
        precoCusto: 6.33,
      },
    ],
  },
  {
    cnp: "5674239",
    produto: "Skudexa 75 mg + 25 mg x 20",
    farmacia: "Braga Norte",
    stockAtual: 9,
    coberturaAtual: 7,
    rotacaoMedia: 0.8,
    fornecedor: "Alliance Healthcare",
    fabricante: "Menarini",
    categoria: "Dor",
    movimentos6M: [
      { mes: "Nov", compras: 16, vendas: 12 },
      { mes: "Dez", compras: 14, vendas: 11 },
      { mes: "Jan", compras: 12, vendas: 10 },
      { mes: "Fev", compras: 9, vendas: 9 },
      { mes: "Mar", compras: 8, vendas: 10 },
      { mes: "Abr", compras: 6, vendas: 9 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Alliance Healthcare",
        campanha: "Dor Premium",
        desconto: "5,0%",
        bonus: "5%",
      },
    ],
    ultimasCompras: [
      {
        data: "31/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 6.34,
      },
      {
        data: "08/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 5,
        precoCusto: 6.3,
      },
      {
        data: "12/02/2026",
        fornecedor: "OCP",
        quantidade: 4,
        precoCusto: 6.4,
      },
      {
        data: "17/01/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 6.29,
      },
    ],
  },
  {
    cnp: "5776364",
    produto: "Edarbi 20 mg x 56",
    farmacia: "Braga Sul",
    stockAtual: 5,
    coberturaAtual: 4,
    rotacaoMedia: 1.1,
    fornecedor: "Alliance Healthcare",
    fabricante: "Menarini",
    categoria: "Cardiovascular",
    movimentos6M: [
      { mes: "Nov", compras: 18, vendas: 15 },
      { mes: "Dez", compras: 20, vendas: 17 },
      { mes: "Jan", compras: 15, vendas: 16 },
      { mes: "Fev", compras: 12, vendas: 14 },
      { mes: "Mar", compras: 10, vendas: 16 },
      { mes: "Abr", compras: 8, vendas: 17 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Alliance Healthcare",
        campanha: "Cardio Abril",
        desconto: "4,0%",
        bonus: "2%",
      },
    ],
    ultimasCompras: [
      {
        data: "03/04/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 10,
        precoCusto: 15.58,
      },
      {
        data: "21/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 8,
        precoCusto: 15.61,
      },
      {
        data: "05/03/2026",
        fornecedor: "Alliance Healthcare",
        quantidade: 6,
        precoCusto: 15.67,
      },
      {
        data: "10/02/2026",
        fornecedor: "Plural",
        quantidade: 4,
        precoCusto: 15.82,
      },
    ],
  },
  {
    cnp: "3232782",
    produto: "Ácido Acetils Rati 100 mg x 50",
    farmacia: "Braga Norte",
    stockAtual: 12,
    coberturaAtual: 8,
    rotacaoMedia: 1.3,
    fornecedor: "OCP",
    fabricante: "Ratiopharm",
    categoria: "Cardiovascular",
    movimentos6M: [
      { mes: "Nov", compras: 14, vendas: 11 },
      { mes: "Dez", compras: 12, vendas: 10 },
      { mes: "Jan", compras: 16, vendas: 12 },
      { mes: "Fev", compras: 18, vendas: 14 },
      { mes: "Mar", compras: 20, vendas: 15 },
      { mes: "Abr", compras: 14, vendas: 13 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "OCP",
        campanha: "Genéricos",
        desconto: "3,5%",
        bonus: "0",
      },
    ],
    ultimasCompras: [
      { data: "01/04/2026", fornecedor: "OCP", quantidade: 12, precoCusto: 2.9 },
      { data: "14/03/2026", fornecedor: "OCP", quantidade: 14, precoCusto: 2.88 },
      { data: "26/02/2026", fornecedor: "OCP", quantidade: 10, precoCusto: 2.91 },
      { data: "31/01/2026", fornecedor: "Plural", quantidade: 8, precoCusto: 2.96 },
    ],
  },
  {
    cnp: "1124509",
    produto: "Brufen 600 mg x 20",
    farmacia: "Braga Sul",
    stockAtual: 9,
    coberturaAtual: 5,
    rotacaoMedia: 1.9,
    fornecedor: "Plural",
    fabricante: "Abbott",
    categoria: "Dor",
    movimentos6M: [
      { mes: "Nov", compras: 22, vendas: 18 },
      { mes: "Dez", compras: 26, vendas: 20 },
      { mes: "Jan", compras: 18, vendas: 23 },
      { mes: "Fev", compras: 16, vendas: 21 },
      { mes: "Mar", compras: 12, vendas: 24 },
      { mes: "Abr", compras: 10, vendas: 25 },
    ],
    condicoesFornecedor: [
      {
        fornecedor: "Plural",
        campanha: "Analgésicos",
        desconto: "4,5%",
        bonus: "3%",
      },
    ],
    ultimasCompras: [
      { data: "05/04/2026", fornecedor: "Plural", quantidade: 8, precoCusto: 4.72 },
      { data: "27/03/2026", fornecedor: "Plural", quantidade: 10, precoCusto: 4.69 },
      { data: "11/03/2026", fornecedor: "OCP", quantidade: 6, precoCusto: 4.81 },
      { data: "19/02/2026", fornecedor: "Plural", quantidade: 12, precoCusto: 4.66 },
    ],
  },
];

function calcularSugestao(stockAtual: number, rotacaoMedia: number, coberturaAlvoDias: number) {
  const stockAlvo = rotacaoMedia * coberturaAlvoDias;
  return Math.max(0, Math.ceil(stockAlvo - stockAtual));
}

function calcularPrioridade(coberturaAtual: number, sugestao: number): Prioridade {
  if (sugestao <= 0) return "Estável";
  if (coberturaAtual <= 2) return "Crítica";
  if (coberturaAtual <= 5) return "Elevada";
  return "Normal";
}

function getPriorityClasses(prioridade: Prioridade) {
  switch (prioridade) {
    case "Crítica":
      return "border-red-200 bg-red-50 text-red-700";
    case "Elevada":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "Normal":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "Estável":
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

export default function EncomendasPage() {
  const [farmaciasSelecionadas, setFarmaciasSelecionadas] = useState<string[]>([
    "Braga Centro",
    "Braga Norte",
    "Braga Sul",
  ]);
  const [fornecedoresSelecionados, setFornecedoresSelecionados] = useState<string[]>([]);
  const [fabricantesSelecionados, setFabricantesSelecionados] = useState<string[]>([]);
  const [categoriasSelecionadas, setCategoriasSelecionadas] = useState<string[]>([]);
  const [periodoAnalise, setPeriodoAnalise] = useState<7 | 15 | 30 | 60 | 90>(30);
  const [coberturaAlvoDias, setCoberturaAlvoDias] = useState(15);
  const [apenasComSugestao, setApenasComSugestao] = useState(true);
  const [apenasCriticos, setApenasCriticos] = useState(false);
  const [editableGroupRows, setEditableGroupRows] = useState<Record<string, number>>({});
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [activeRowIndex, setActiveRowIndex] = useState(0);

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const farmacias = Array.from(new Set(mockRowsBase.map((r) => r.farmacia)));
  const fornecedores = Array.from(new Set(mockRowsBase.map((r) => r.fornecedor)));
  const fabricantes = Array.from(new Set(mockRowsBase.map((r) => r.fabricante)));
  const categorias = Array.from(new Set(mockRowsBase.map((r) => r.categoria)));

  const rowsCalculadas = useMemo<EncomendaFarmaciaRow[]>(() => {
    return mockRowsBase.map((item) => {
      const fatorPeriodo =
        periodoAnalise === 7 ? 1.08 :
        periodoAnalise === 15 ? 1.04 :
        periodoAnalise === 30 ? 1 :
        periodoAnalise === 60 ? 0.96 : 0.93;

      const rotacaoAjustada = Number((item.rotacaoMedia * fatorPeriodo).toFixed(1));
      const sugestao = calcularSugestao(item.stockAtual, rotacaoAjustada, coberturaAlvoDias);
      const prioridade = calcularPrioridade(item.coberturaAtual, sugestao);
      const valorEstimado = Number((sugestao * (4.5 + rotacaoAjustada * 1.8)).toFixed(2));

      return {
        ...item,
        rotacaoMedia: rotacaoAjustada,
        sugestao,
        prioridade,
        valorEstimado,
      };
    });
  }, [periodoAnalise, coberturaAlvoDias]);

  const groupRows = useMemo<GroupEncomendaRow[]>(() => {
    const filtered = rowsCalculadas.filter((row) => {
      if (farmaciasSelecionadas.length > 0 && !farmaciasSelecionadas.includes(row.farmacia)) return false;
      if (fornecedoresSelecionados.length > 0 && !fornecedoresSelecionados.includes(row.fornecedor)) return false;
      if (fabricantesSelecionados.length > 0 && !fabricantesSelecionados.includes(row.fabricante)) return false;
      if (categoriasSelecionadas.length > 0 && !categoriasSelecionadas.includes(row.categoria)) return false;
      return true;
    });

    const grouped = new Map<string, EncomendaFarmaciaRow[]>();

    for (const row of filtered) {
      const key = row.cnp;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

   const result = Array.from(grouped.values()).map((rows): GroupEncomendaRow => {
  const first = rows[0]!;
  const stockGrupo = rows.reduce((sum, r) => sum + r.stockAtual, 0);
  const sugestaoGrupo = rows.reduce((sum, r) => sum + r.sugestao, 0);
  const valorEstimado = Number(
    rows.reduce((sum, r) => sum + r.valorEstimado, 0).toFixed(2)
  );

  const prioridade = (
    rows.some((r) => r.prioridade === "Crítica")
      ? "Crítica"
      : rows.some((r) => r.prioridade === "Elevada")
        ? "Elevada"
        : sugestaoGrupo > 0
          ? "Normal"
          : "Estável"
  ) as Prioridade;

  return {
    cnp: first.cnp,
    produto: first.produto,
    fornecedor: first.fornecedor,
    fabricante: first.fabricante,
    categoria: first.categoria,
    stockGrupo,
    sugestaoGrupo,
    encomendarGrupo: sugestaoGrupo,
    valorEstimado,
    prioridade,
    porFarmacia: rows
      .sort((a, b) => a.farmacia.localeCompare(b.farmacia))
      .map((r) => ({
        farmacia: r.farmacia,
        stockAtual: r.stockAtual,
        coberturaAtual: r.coberturaAtual,
        rotacaoMedia: r.rotacaoMedia,
        sugestao: r.sugestao,
        prioridade: r.prioridade as Prioridade,
        movimentos6M: r.movimentos6M,
        ultimasCompras: r.ultimasCompras,
      })),
    condicoesFornecedor: first.condicoesFornecedor,
  };
});

    return result.filter((row) => {
      if (apenasComSugestao && row.sugestaoGrupo <= 0) return false;
      if (apenasCriticos && row.prioridade !== "Crítica") return false;
      return true;
    });
  }, [
    rowsCalculadas,
    farmaciasSelecionadas,
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    apenasComSugestao,
    apenasCriticos,
  ]);

  const currentActiveIndex =
    groupRows.length === 0 ? -1 : Math.min(activeRowIndex, groupRows.length - 1);

  const activeRow = currentActiveIndex >= 0 ? groupRows[currentActiveIndex] : null;
  const farmaciaMaiorNecessidade = activeRow
    ? [...activeRow.porFarmacia].sort((a, b) => b.sugestao - a.sugestao)[0] ?? null
    : null;

  useEffect(() => {
    if (groupRows.length === 0) return;
    if (activeRowIndex > groupRows.length - 1) {
      setActiveRowIndex(groupRows.length - 1);
    }
  }, [groupRows.length, activeRowIndex]);

  const encomendarGrupoValue = (row: GroupEncomendaRow) =>
    editableGroupRows[row.cnp] ?? row.encomendarGrupo;

  const handleChangeEncomendarGrupo = (cnp: string, value: string) => {
    const parsed = Number(value);
    setEditableGroupRows((prev) => ({
      ...prev,
      [cnp]: Number.isNaN(parsed) ? 0 : Math.max(0, parsed),
    }));
  };

  const handleRowKeyNavigation = (
    event: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = Math.min(rowIndex + 1, groupRows.length - 1);
      setActiveRowIndex(nextIndex);
      inputRefs.current[nextIndex]?.focus();
      inputRefs.current[nextIndex]?.select();
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIndex = Math.max(rowIndex - 1, 0);
      setActiveRowIndex(prevIndex);
      inputRefs.current[prevIndex]?.focus();
      inputRefs.current[prevIndex]?.select();
    }
  };

  const resumo = useMemo(() => {
    const artigos = groupRows.length;
    const criticos = groupRows.filter((r) => r.prioridade === "Crítica").length;
    const valor = groupRows.reduce((sum, row) => {
      const qtd = encomendarGrupoValue(row);
      const valorUnitario = row.sugestaoGrupo > 0 ? row.valorEstimado / row.sugestaoGrupo : 0;
      return sum + qtd * valorUnitario;
    }, 0);

    return { artigos, criticos, valor };
  }, [groupRows, editableGroupRows]);

  const filtrosAtivosCount =
    farmaciasSelecionadas.length +
    fornecedoresSelecionados.length +
    fabricantesSelecionados.length +
    categoriasSelecionadas.length;

  return (
    <AppShell>
      <div className="space-y-3">
        <section className="space-y-0.5">
          <div className="text-xs font-medium text-slate-500">Decisão / Encomendas</div>
          <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
            Encomendas
          </h1>
          <p className="text-[13px] text-slate-600">
            Proposta de grupo com necessidade discriminada por farmácia.
          </p>
        </section>

        <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-[0.95fr_0.95fr_auto]">
              <CompactSelect
                label="Período"
                value={String(periodoAnalise)}
                onChange={(value) => setPeriodoAnalise(Number(value) as 7 | 15 | 30 | 60 | 90)}
                options={["7", "15", "30", "60", "90"]}
                suffix=" dias"
              />
              <CompactInput
                label="Cobertura"
                value={coberturaAlvoDias}
                onChange={(value) => setCoberturaAlvoDias(Math.max(1, Number(value) || 1))}
                suffix="dias"
              />

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => setFiltrosAbertos((prev) => !prev)}
                  className={[
                    "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-[13px] font-medium transition",
                    filtrosAbertos
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                  ].join(" ")}
                >
                  <Filter className="h-3.5 w-3.5" />
                  Filtros
                  <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                    {filtrosAtivosCount}
                  </span>
                  <ChevronDown
                    className={[
                      "h-3.5 w-3.5 transition",
                      filtrosAbertos ? "rotate-180" : "",
                    ].join(" ")}
                  />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ActionButton icon={<RefreshCw className="h-3.5 w-3.5" />} label="Atualizar" />
              <ActionButton icon={<Download className="h-3.5 w-3.5" />} label="Exportar" />
              <ActionButton icon={<ShoppingCart className="h-3.5 w-3.5" />} label="Gerar" primary />
            </div>
          </div>

          {filtrosAbertos && (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="grid gap-3 xl:grid-cols-4">
                <SearchableMultiSelect
                  label="Farmácias"
                  options={farmacias}
                  selected={farmaciasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, farmaciasSelecionadas, setFarmaciasSelecionadas)
                  }
                />
                <SearchableMultiSelect
                  label="Fornecedores"
                  options={fornecedores}
                  selected={fornecedoresSelecionados}
                  onToggle={(value) =>
                    toggleValue(value, fornecedoresSelecionados, setFornecedoresSelecionados)
                  }
                />
                <SearchableMultiSelect
                  label="Fabricantes"
                  options={fabricantes}
                  selected={fabricantesSelecionados}
                  onToggle={(value) =>
                    toggleValue(value, fabricantesSelecionados, setFabricantesSelecionados)
                  }
                />
                <SearchableMultiSelect
                  label="Categorias"
                  options={categorias}
                  selected={categoriasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, categoriasSelecionadas, setCategoriasSelecionadas)
                  }
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {farmaciasSelecionadas.map((item) => (
                  <FilterPill
                    key={`farmacia-${item}`}
                    label={item}
                    onRemove={() =>
                      setFarmaciasSelecionadas((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
                {fornecedoresSelecionados.map((item) => (
                  <FilterPill
                    key={`fornecedor-${item}`}
                    label={item}
                    onRemove={() =>
                      setFornecedoresSelecionados((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
                {fabricantesSelecionados.map((item) => (
                  <FilterPill
                    key={`fabricante-${item}`}
                    label={item}
                    onRemove={() =>
                      setFabricantesSelecionados((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
                {categoriasSelecionadas.map((item) => (
                  <FilterPill
                    key={`categoria-${item}`}
                    label={item}
                    onRemove={() =>
                      setCategoriasSelecionadas((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              <Filter className="h-3 w-3" />
              Filtros rápidos
            </div>

            <ToggleRow
              label="Apenas com sugestão"
              checked={apenasComSugestao}
              onChange={setApenasComSugestao}
              compact
            />
            <ToggleRow
              label="Apenas críticos"
              checked={apenasCriticos}
              onChange={setApenasCriticos}
              compact
            />

            <div className="ml-auto flex flex-wrap items-center gap-3 text-[13px] text-slate-600">
              <span>
                <span className="font-semibold text-slate-900">{resumo.artigos}</span> artigos
              </span>
              <span>
                <span className="font-semibold text-red-600">{resumo.criticos}</span> críticos
              </span>
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.valor.toLocaleString("pt-PT", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} €
                </span>{" "}
                estimados
              </span>
            </div>
          </div>
        </section>

        <section className="sticky top-16 z-20 overflow-hidden rounded-[20px] border border-white/70 bg-white/92 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          {activeRow ? (
            <div className="grid gap-0 xl:grid-cols-[1.05fr_1.1fr_1.15fr]">
              <div className="border-b border-slate-100 px-4 py-3 xl:border-b-0 xl:border-r">
                <h3 className="text-sm font-semibold text-slate-900">Condições do fornecedor</h3>
                <div className="mt-3 overflow-hidden rounded-xl border border-slate-100">
                  <table className="min-w-full text-left">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-semibold">Fornecedor</th>
                        <th className="px-2.5 py-1.5 font-semibold">Desc.</th>
                        <th className="px-2.5 py-1.5 font-semibold">Bónus</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[12px] text-slate-700">
                      {activeRow.condicoesFornecedor.slice(0, 4).map((item, index) => (
                        <tr key={`${item.fornecedor}-${index}`}>
                          <td className="px-2.5 py-1.5">
                            <div className="font-medium">{item.fornecedor}</div>
                            <div className="text-[11px] text-slate-400">{item.campanha}</div>
                          </td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{item.desconto}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{item.bonus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border-b border-slate-100 px-4 py-3 xl:border-b-0 xl:border-r">
                <h3 className="text-sm font-semibold text-slate-900">Compras vs vendas</h3>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {farmaciaMaiorNecessidade
                    ? `Farmácia com maior necessidade: ${farmaciaMaiorNecessidade.farmacia}`
                    : "Sem dados disponíveis"}
                </p>
                <div className="mt-3">
                  <MovementChart
                    data={farmaciaMaiorNecessidade?.movimentos6M ?? []}
                  />
                </div>
              </div>

              <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">Últimas 4 compras</h3>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {farmaciaMaiorNecessidade
                    ? `Referência: ${farmaciaMaiorNecessidade.farmacia}`
                    : "Sem histórico disponível"}
                </p>

                <div className="mt-3 overflow-hidden rounded-xl border border-slate-100">
                  <table className="min-w-full text-left">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-semibold">Data</th>
                        <th className="px-2.5 py-1.5 font-semibold">Fornecedor</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">Qtd.</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">P. custo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[12px] text-slate-700">
                      {(farmaciaMaiorNecessidade?.ultimasCompras ?? []).slice(0, 4).map((item, index) => (
                        <tr key={`${item.data}-${index}`}>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{item.data}</td>
                          <td className="px-2.5 py-1.5">{item.fornecedor}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap text-right">{item.quantidade}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap text-right">
                            {item.precoCusto.toLocaleString("pt-PT", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })} €
                          </td>
                        </tr>
                      ))}

                      {(farmaciaMaiorNecessidade?.ultimasCompras ?? []).length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-6 text-center text-[12px] text-slate-500">
                            Sem compras registadas.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="px-4 py-4 text-[13px] text-slate-500">Sem artigo selecionado.</div>
          )}
        </section>

        <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Proposta consolidada</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Encomenda única com discriminação por farmácia
              </p>
            </div>
          </div>

          <div className="max-h-[calc(100vh-500px)] min-h-[320px] overflow-y-auto">
            <table className="min-w-full table-fixed text-left">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[16%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[8%]" />
              </colgroup>

              <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Produto</th>
                  <th className="px-3 py-2.5 font-semibold">Contexto</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Stock grupo</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Sug. grupo</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Enc. grupo</th>
                  <th className="px-3 py-2.5 font-semibold">Distribuição por farmácia</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Prioridade</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                {groupRows.map((row, index) => (
                  <tr
                    key={row.cnp}
                    onMouseEnter={() => setActiveRowIndex(index)}
                    className={[
                      "transition",
                      currentActiveIndex === index ? "bg-emerald-50/70" : "hover:bg-slate-50/70",
                    ].join(" ")}
                  >
                    <td className="px-4 py-2.5 align-top">
                      <div className="space-y-0.5">
                        <Link
                          href={`/stock/artigo/${row.cnp}`}
                          className="block leading-5 font-semibold text-slate-900 transition hover:text-emerald-600"
                        >
                          {row.produto}
                        </Link>
                        <div className="text-[12px] text-slate-500">CNP {row.cnp}</div>
                      </div>
                    </td>

                    <td className="px-3 py-2.5 align-top">
                      <div className="space-y-0.5">
                        <div className="text-[12px] leading-5 text-slate-500">
                          {row.fornecedor} · {row.fabricante}
                        </div>
                        <div className="text-[12px] leading-5 text-slate-400">{row.categoria}</div>
                      </div>
                    </td>

                    <td className="px-2 py-2.5 text-center font-medium">{row.stockGrupo}</td>
                    <td className="px-2 py-2.5 text-center font-semibold text-slate-900">
                      {row.sugestaoGrupo}
                    </td>

                    <td className="px-2 py-2.5 text-center">
                      <input
                        ref={(el) => {
                          inputRefs.current[index] = el;
                        }}
                        type="number"
                        min={0}
                        value={encomendarGrupoValue(row)}
                        onFocus={() => setActiveRowIndex(index)}
                        onChange={(e) => handleChangeEncomendarGrupo(row.cnp, e.target.value)}
                        onKeyDown={(e) => handleRowKeyNavigation(e, index)}
                        className="h-8 w-[66px] rounded-xl border border-slate-200 bg-white px-2 text-center text-[13px] font-semibold text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
                      />
                    </td>

                    <td className="px-3 py-2.5 align-top">
                      <div className="space-y-1">
                        {row.porFarmacia.map((item) => (
                          <div
                            key={`${row.cnp}-${item.farmacia}`}
                            className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1"
                          >
                            <span className="text-[12px] text-slate-700">{item.farmacia}</span>
                            <span className="text-[12px] text-slate-500">
                              stock {item.stockAtual} · cob. {item.coberturaAtual} d · sug.{" "}
                              <span className="font-semibold text-slate-900">{item.sugestao}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </td>

                    <td className="px-2 py-2.5 text-center align-top">
                      <span
                        className={[
                          "inline-flex rounded-full border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap",
                          getPriorityClasses(row.prioridade),
                        ].join(" ")}
                      >
                        {row.prioridade}
                      </span>
                    </td>
                  </tr>
                ))}

                {groupRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center">
                      <div className="mx-auto max-w-md">
                        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                          <Filter className="h-4 w-4" />
                        </div>
                        <div className="mt-3 text-[13px] font-semibold text-slate-900">
                          Sem artigos para os filtros selecionados
                        </div>
                        <p className="mt-1.5 text-[12px] text-slate-500">
                          Ajuste farmácias, fabricantes, fornecedores ou categorias.
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function CompactSelect({
  label,
  value,
  onChange,
  options,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  suffix?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {suffix && ["7", "15", "30", "60", "90"].includes(option)
              ? `${option}${suffix}`
              : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompactInput({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: string) => void;
  suffix?: string;
}) {
  return (
    <label className="block min-w-[110px]">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <div className="relative">
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 pr-12 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function SearchableMultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>

      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Pesquisar ${label.toLowerCase()}...`}
            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white"
          />
        </div>

        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {filteredOptions.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => onToggle(option)}
                className={[
                  "flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[12px] font-medium transition",
                  active
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                ].join(" ")}
              >
                <span className="truncate">{option}</span>
                {active && <span className="ml-2 text-[11px] font-semibold">✓</span>}
              </button>
            );
          })}

          {filteredOptions.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[12px] text-slate-500">
              Sem resultados.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[12px] text-slate-700">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="text-slate-400 transition hover:text-slate-700"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  compact = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label className={compact ? "flex items-center gap-2.5" : "flex items-center justify-between gap-2.5"}>
      <span className="text-[13px] text-slate-700">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={[
          "relative h-5 w-10 rounded-full transition",
          checked ? "bg-emerald-500" : "bg-slate-200",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition",
            checked ? "left-[20px]" : "left-0.5",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

function ActionButton({
  icon,
  label,
  primary = false,
}: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      className={[
        "inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium transition",
        primary
          ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
          : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-800",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}

function MovementChart({ data }: { data: MonthlyMovement[] }) {
  const safeData = data.length > 0 ? data : [{ mes: "-", compras: 0, vendas: 0 }];
  const maxValue = Math.max(...safeData.flatMap((item) => [item.compras, item.vendas]), 1);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="flex h-[118px] items-end gap-2">
        {safeData.map((item) => {
          const comprasHeight = Math.max((item.compras / maxValue) * 74, 8);
          const vendasHeight = Math.max((item.vendas / maxValue) * 74, 8);

          return (
            <div key={item.mes} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-[84px] items-end gap-1">
                <div className="w-3 rounded-t-md bg-emerald-300" style={{ height: `${comprasHeight}px` }} />
                <div className="w-3 rounded-t-md bg-sky-300" style={{ height: `${vendasHeight}px` }} />
              </div>
              <div className="text-[10px] font-medium text-slate-500">{item.mes}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-300" />
          Compras
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-300" />
          Vendas
        </div>
      </div>
    </div>
  );
}