"use client";

/**
 * components/produtos/criar-produto-form.tsx
 *
 * O formulário ÚNICO de criação de ficha de produto.
 *
 * Serve os dois pontos de entrada — Stocks e Encomendas — e é a razão de
 * existir: duas implementações do mesmo formulário divergiriam na
 * primeira regra que mudasse, e a regra que mais interessa aqui (o CNP
 * não catalogável) é precisamente a que ninguém se lembra de copiar.
 *
 * O que MUDA entre hospedeiros:
 *   · `contexto`  — só para a auditoria (STOCK | ENCOMENDA)
 *   · `onCriado`  — Stocks navega para a ficha; Encomendas devolve o
 *                   produto ao picker e fecha o modal
 *   · o invólucro — página num caso, modal no outro
 *
 * O que NÃO muda: os campos, a validação, a normalização e a acção.
 * A validação vem de `lib/produtos/criar-produto.ts` — a MESMA função
 * que o servidor volta a correr. O cliente valida para dar resposta
 * imediata; o servidor valida porque é ele que garante.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  validarFichaManual,
  type ContextoCriacao,
  type ErroValidacao,
  type FichaManual,
} from "@/lib/produtos/criar-produto";
import { criarProdutoManualAction } from "@/app/produtos/criar/actions";

export type ProdutoCriado = {
  produtoId: string;
  cnp: number;
  designacao: string;
  /** `false` quando o CNP já existia e devolvemos o existente. */
  criado: boolean;
};

type Props = {
  contexto: ContextoCriacao;
  /** Pré-preenchimento vindo da pesquisa que não deu resultados. */
  cnpInicial?: number | null;
  designacaoInicial?: string | null;
  onCriado: (p: ProdutoCriado) => void;
  onCancelar?: () => void;
};

type Campos = {
  cnp: string;
  designacao: string;
  dci: string;
  codigoATC: string;
  dosagem: string;
  formaFarmaceutica: string;
  embalagem: string;
  fabricante: string;
  categoria: string;
  subcategoria: string;
  grupoHomogeneo: string;
  flagGenerico: boolean;
};

const VAZIO: Campos = {
  cnp: "", designacao: "", dci: "", codigoATC: "", dosagem: "",
  formaFarmaceutica: "", embalagem: "", fabricante: "", categoria: "",
  subcategoria: "", grupoHomogeneo: "", flagGenerico: false,
};

function paraFicha(c: Campos): FichaManual {
  return {
    cnp: Number(c.cnp.trim()),
    designacao: c.designacao,
    dci: c.dci,
    codigoATC: c.codigoATC,
    dosagem: c.dosagem,
    formaFarmaceutica: c.formaFarmaceutica,
    embalagem: c.embalagem,
    fabricante: c.fabricante,
    categoria: c.categoria,
    subcategoria: c.subcategoria,
    grupoHomogeneo: c.grupoHomogeneo,
    flagGenerico: c.flagGenerico,
  };
}

export function CriarProdutoForm({
  contexto,
  cnpInicial,
  designacaoInicial,
  onCriado,
  onCancelar,
}: Props) {
  const [campos, setCampos] = useState<Campos>({
    ...VAZIO,
    cnp: cnpInicial ? String(cnpInicial) : "",
    designacao: designacaoInicial ?? "",
  });
  const [erros, setErros] = useState<ErroValidacao[]>([]);
  const [aGuardar, setAGuardar] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const set = (k: keyof Campos, v: string | boolean) =>
    setCampos((p) => ({ ...p, [k]: v }));

  const erroDe = (campo: string) => erros.find((e) => e.campo === campo)?.mensagem;

  async function submeter(e: React.FormEvent) {
    e.preventDefault();
    setAviso(null);

    const ficha = paraFicha(campos);
    const locais = validarFichaManual(ficha);
    if (locais.length > 0) {
      setErros(locais);
      return;
    }
    setErros([]);
    setAGuardar(true);
    try {
      const r = await criarProdutoManualAction({ ...ficha, contexto });
      if (!r.ok) {
        setErros(r.erros);
        return;
      }
      if (!r.criado) {
        // Não é erro. O CNP já existia e o utilizador vai usá-lo na
        // mesma — dizê-lo evita que ele pense que criou algo novo.
        setAviso(`O CNP ${r.cnp} já existia: «${r.designacao}». Vai ser usado este.`);
      }
      onCriado({
        produtoId: r.produtoId,
        cnp: r.cnp,
        designacao: r.designacao,
        criado: r.criado,
      });
    } finally {
      setAGuardar(false);
    }
  }

  return (
    <form onSubmit={submeter} className="space-y-4">
      {/* O que esta ficha É e o que NÃO é. Sem isto, «criar produto»
          num ecrã de farmácia lê-se como «criar no ERP». */}
      <p className="rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
        A ficha é criada no <strong>catálogo do SPharm.MT</strong>, não no ERP de
        nenhuma farmácia. Stock, custo, PVP e validade continuam a vir da farmácia
        quando o artigo lá aparecer.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <Campo
          label="CNP"
          obrigatorio
          value={campos.cnp}
          onChange={(v) => set("cnp", v.replace(/\D/g, ""))}
          erro={erroDe("cnp")}
          inputMode="numeric"
          placeholder="5880075"
        />
        <Campo
          label="Designação"
          obrigatorio
          value={campos.designacao}
          onChange={(v) => set("designacao", v)}
          erro={erroDe("designacao")}
          placeholder="Mounjaro 5 Mg/0.6 Ml Sol. Injetável"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Campo label="DCI" value={campos.dci} onChange={(v) => set("dci", v)} erro={erroDe("dci")} placeholder="Tirzepatido" />
        <Campo
          label="ATC"
          value={campos.codigoATC}
          onChange={(v) => set("codigoATC", v.toUpperCase())}
          erro={erroDe("codigoATC")}
          placeholder="A10BX16"
        />
        <Campo label="Dosagem" value={campos.dosagem} onChange={(v) => set("dosagem", v)} erro={erroDe("dosagem")} placeholder="5 mg/0.6 ml" />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Campo label="Forma farmacêutica" value={campos.formaFarmaceutica} onChange={(v) => set("formaFarmaceutica", v)} erro={erroDe("formaFarmaceutica")} />
        <Campo label="Embalagem" value={campos.embalagem} onChange={(v) => set("embalagem", v)} erro={erroDe("embalagem")} />
        <Campo label="Fabricante / titular" value={campos.fabricante} onChange={(v) => set("fabricante", v)} erro={erroDe("fabricante")} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Campo label="Categoria" value={campos.categoria} onChange={(v) => set("categoria", v)} erro={erroDe("categoria")} />
        <Campo label="Subcategoria" value={campos.subcategoria} onChange={(v) => set("subcategoria", v)} erro={erroDe("subcategoria")} />
        <Campo label="Grupo homogéneo" value={campos.grupoHomogeneo} onChange={(v) => set("grupoHomogeneo", v)} erro={erroDe("grupoHomogeneo")} />
      </div>

      <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
        <input
          type="checkbox"
          checked={campos.flagGenerico}
          onChange={(e) => set("flagGenerico", e.target.checked)}
          className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
        />
        <span>Genérico</span>
      </label>

      {erroDe("geral") && (
        <p className="rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          {erroDe("geral")}
        </p>
      )}
      {aviso && (
        <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {aviso}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={aGuardar}
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-emerald-500 bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {aGuardar && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {aGuardar ? "A criar…" : "Criar produto"}
        </button>
        {onCancelar && (
          <button
            type="button"
            onClick={onCancelar}
            disabled={aGuardar}
            className="rounded-[10px] border border-slate-200 bg-white px-4 py-2 text-[13px] text-slate-600 transition hover:border-slate-300 disabled:opacity-60"
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function Campo({
  label,
  value,
  onChange,
  erro,
  obrigatorio = false,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  erro?: string;
  obrigatorio?: boolean;
  placeholder?: string;
  inputMode?: "numeric" | "text";
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
        {label}
        {obrigatorio && <span className="ml-0.5 text-rose-500">*</span>}
      </span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={erro ? true : undefined}
        className={`mt-1 h-9 w-full rounded-[10px] border bg-white px-3 text-[13px] text-slate-700 outline-none ${
          erro ? "border-rose-300 focus:border-rose-400" : "border-slate-200 focus:border-emerald-300"
        }`}
      />
      {erro && <span className="mt-0.5 block text-[11px] text-rose-600">{erro}</span>}
    </label>
  );
}
