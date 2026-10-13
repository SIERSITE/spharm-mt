"use client";

/**
 * components/admin/infarmed-admin-client.tsx
 *
 * Estado da atualização dos dados do INFARMED + upload manual em dois passos:
 * 1) validar (resumo por tenant, sem escrever nada);
 * 2) aplicar — só depois de o utilizador escrever «APLICAR».
 * O ficheiro nunca é guardado no servidor entre os dois passos: o browser
 * reenvia-o e o servidor confere o SHA-256 do que foi validado.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  aplicarUploadAction,
  repetirDescarregamentoAction,
  validarUploadAction,
} from "@/app/admin/infarmed/actions";
import type { EstadoAdminInfarmed, ExecucaoLinha } from "@/lib/regulamentar/infarmed-admin";
import type { PreviewUpload, ResultadoAtualizacao, ResultadoTenant } from "@/lib/regulamentar/infarmed-atualizacao";

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("pt-PT") : "—");
const curto = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "—");
const ORIGEM: Record<string, string> = {
  MENSAL: "Automática", AUTOMATICA: "Automática", REPETICAO: "Repetição (automática)", UPLOAD_MANUAL: "Upload manual",
  MANUAL: "CLI manual", CARGA_INICIAL: "Carga inicial",
};
const RESULTADO_TONE: Record<string, string> = {
  CONCLUIDA: "border-emerald-200 bg-emerald-50 text-emerald-800",
  PARCIAL: "border-amber-200 bg-amber-50 text-amber-800",
  FALHADA: "border-rose-200 bg-rose-50 text-rose-800",
};

function ResultadoTenants({ tenants, mostrarNumeros }: { tenants: ResultadoTenant[]; mostrarNumeros: boolean }) {
  return (
    <table className="w-full text-[12px]" data-testid="infarmed-tenants">
      <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
        <tr>
          <th className="py-1.5 pr-3">Tenant</th>
          <th className="py-1.5 pr-3">Resultado</th>
          {mostrarNumeros && <th className="py-1.5 pr-3 text-right">Produtos associados</th>}
          {mostrarNumeros && <th className="py-1.5 pr-3 text-right">Novos / alterados / iguais</th>}
          {mostrarNumeros && <th className="py-1.5 pr-3 text-right" title="Campos do catálogo preenchidos + atualizados (forma / dosagem / embalagem / DCI)">Catálogo (F/D/E/DCI)</th>}
          <th className="py-1.5">Detalhe</th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((t) => (
          <tr key={t.slug} className="border-t border-slate-100" data-tenant={t.slug} data-ok={t.ok ? "1" : "0"}>
            <td className="py-1.5 pr-3 font-medium text-slate-800">{t.slug}</td>
            <td className="py-1.5 pr-3">
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
                {t.resultado}
              </span>
            </td>
            {mostrarNumeros && <td className="py-1.5 pr-3 text-right tabular-nums">{t.produtosAssociados ?? "—"}</td>}
            {mostrarNumeros && (
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {t.registosNovos ?? 0} / {t.registosAlterados ?? 0} / {t.registosIguais ?? 0}
              </td>
            )}
            {mostrarNumeros && (
              <td className="py-1.5 pr-3 text-right tabular-nums" data-col="catalogo">
                {t.reconciliacao
                  ? [t.reconciliacao.campos.formaFarmaceutica, t.reconciliacao.campos.dosagem, t.reconciliacao.campos.embalagem, t.reconciliacao.campos.dci]
                      .map((c) => c.preenchidos + c.atualizados)
                      .join(" / ")
                  : "—"}
              </td>
            )}
            <td className="py-1.5 text-slate-600">{t.motivo ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LinhaExecucao({ e }: { e: ExecucaoLinha }) {
  return (
    <tr className="border-t border-slate-100" data-testid="infarmed-execucao">
      <td className="py-1.5 pr-3 tabular-nums">{fmt(e.quando)}</td>
      <td className="py-1.5 pr-3">{e.periodo}</td>
      <td className="py-1.5 pr-3">{ORIGEM[e.origem] ?? e.origem}</td>
      <td className="py-1.5 pr-3">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${RESULTADO_TONE[e.resultado] ?? ""}`}>{e.resultado}</span>
      </td>
      <td className="py-1.5 pr-3 font-mono text-[11px]">{curto(e.sha256)}</td>
      <td className="py-1.5 pr-3">{e.utilizadorEmail ?? "—"}</td>
      <td className="py-1.5 text-slate-600">{e.motivo ?? ""}</td>
    </tr>
  );
}

export function InfarmedAdminClient({ estado }: { estado: EstadoAdminInfarmed }) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const [ficheiro, setFicheiro] = useState<File | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewUpload | null>(null);
  const [confirmar, setConfirmar] = useState("");
  const [resultado, setResultado] = useState<ResultadoAtualizacao | null>(null);

  const alerta = estado.alertaPendente;
  const falhados = (resultado?.tenants ?? []).filter((t) => !t.ok).map((t) => t.slug);
  const nadaAFazer = !!preview && preview.tenants.length > 0 && preview.tenants.every((t) => t.resultado === "JA_PROCESSADA");

  function reiniciar() {
    setPreview(null);
    setResultado(null);
    setErro(null);
    setConfirmar("");
  }

  function validar() {
    if (!ficheiro) return;
    reiniciar();
    startTransition(async () => {
      const fd = new FormData();
      fd.set("ficheiro", ficheiro);
      const r = await validarUploadAction(fd);
      if (!r.ok) setErro(r.erro);
      else setPreview(r.preview);
    });
  }

  function aplicar(slugs?: string[]) {
    if (!ficheiro || !preview) return;
    setErro(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("ficheiro", ficheiro);
      fd.set("sha256", preview.sha256);
      fd.set("confirmar", confirmar);
      for (const s of slugs ?? []) fd.append("tenant", s);
      const r = await aplicarUploadAction(fd);
      if (!r.ok) setErro(r.erro);
      else {
        setResultado(r.resultado);
        router.refresh();
      }
    });
  }

  function repetir(slugs: string[]) {
    setErro(null);
    startTransition(async () => {
      const fd = new FormData();
      for (const s of slugs) fd.append("tenant", s);
      const r = await repetirDescarregamentoAction(fd);
      if (!r.ok) setErro(r.erro);
      else {
        setResultado(r.resultado);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6" data-testid="infarmed-admin">
      {/* ── Alerta ── */}
      {alerta && (
        <section role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-900" data-testid="infarmed-alerta">
          <div className="font-semibold">A atualização mensal de {alerta.periodo} não foi possível — por resolver</div>
          <p className="mt-1">{alerta.motivo}</p>
          <p className="mt-1 text-[12px] text-rose-800">
            A versão ativa foi mantida. Tentativas: {alerta.tentativas}. Notificação por email:{" "}
            <b data-testid="infarmed-notificacao">{alerta.notificacaoEstado}</b>
            {alerta.notificadoEm ? ` (${fmt(alerta.notificadoEm)})` : ""}
            {alerta.notificacaoErro ? ` — ${alerta.notificacaoErro}` : ""}
          </p>
          {alerta.tenantsFalhados.length > 0 && (
            <button
              type="button"
              disabled={pendente}
              onClick={() => repetir(alerta.tenantsFalhados)}
              className="mt-2 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-[12px] font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50"
              data-testid="infarmed-repetir-falhados"
            >
              Repetir nos tenants falhados ({alerta.tenantsFalhados.join(", ")})
            </button>
          )}
        </section>
      )}

      {/* ── Estado ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="infarmed-estado">
        <h2 className="text-[13px] font-semibold text-slate-900">Estado por tenant</h2>
        <table className="mt-2 w-full text-[12px]">
          <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="py-1.5 pr-3">Tenant</th>
              <th className="py-1.5 pr-3">Versão ativa</th>
              <th className="py-1.5 pr-3">Origem</th>
              <th className="py-1.5 pr-3">SHA-256</th>
              <th className="py-1.5 pr-3">Associados</th>
              <th className="py-1.5">Última tentativa</th>
            </tr>
          </thead>
          <tbody>
            {estado.tenants.map((t) => (
              <tr key={t.slug} className="border-t border-slate-100" data-tenant-estado={t.slug}>
                <td className="py-1.5 pr-3 font-medium text-slate-800">{t.nome} <span className="text-slate-400">({t.slug})</span></td>
                <td className="py-1.5 pr-3 tabular-nums">{t.ativa ? fmt(t.ativa.quando) : "sem versão ativa"}</td>
                <td className="py-1.5 pr-3">{t.ativa ? (ORIGEM[t.ativa.origem] ?? t.ativa.origem) : "—"}</td>
                <td className="py-1.5 pr-3 font-mono text-[11px]">{curto(t.ativa?.sha256)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{t.ativa?.produtosAssociados ?? "—"}</td>
                <td className="py-1.5">
                  {t.recentes[0] ? (
                    <span className={t.ultimaFalhou ? "text-rose-700" : "text-slate-600"}>
                      {t.recentes[0].estado} · {fmt(t.recentes[0].quando)}
                      {t.recentes[0].erro ? ` — ${t.recentes[0].erro}` : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-3 grid gap-2 text-[12px] sm:grid-cols-3">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Último download automático</dt>
            <dd data-testid="infarmed-ultimo-download">
              {estado.ultimoDownloadAutomatico ? `${fmt(estado.ultimoDownloadAutomatico.quando)} · ${estado.ultimoDownloadAutomatico.resultado}` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Último erro</dt>
            <dd data-testid="infarmed-ultimo-erro">{estado.execucoes.find((e) => e.resultado !== "CONCLUIDA")?.motivo ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Estado do alerta</dt>
            <dd>{alerta ? "Por resolver" : "Sem alertas pendentes"}</dd>
          </div>
        </dl>
        <div className="mt-3">
          <button
            type="button"
            disabled={pendente}
            onClick={() => repetir([])}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            data-testid="infarmed-descarregar-agora"
          >
            Descarregar agora (todos os tenants)
          </button>
        </div>
      </section>

      {/* ── Upload manual ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="infarmed-upload">
        <h2 className="text-[13px] font-semibold text-slate-900">Carregar o ficheiro manualmente</h2>
        <p className="mt-1 text-[12px] text-slate-500">
          Ficheiro Excel 97-2003 do INFARMED (allPackages.xls). 1) Validar mostra o resumo por tenant sem escrever nada; 2) Aplicar só depois de confirmar.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".xls,application/vnd.ms-excel"
            data-testid="infarmed-input-ficheiro"
            aria-label="Ficheiro do INFARMED"
            onChange={(e) => {
              setFicheiro(e.target.files?.[0] ?? null);
              reiniciar();
            }}
            className="text-[12px]"
          />
          <button
            type="button"
            disabled={!ficheiro || pendente}
            onClick={validar}
            className="rounded-lg border border-slate-800 bg-slate-800 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
            data-testid="infarmed-validar"
          >
            {pendente && !preview ? "A validar…" : "Validar"}
          </button>
        </div>

        {erro && (
          <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800" data-testid="infarmed-erro">
            {erro}
          </p>
        )}

        {preview && !resultado && (
          <div className="mt-4 space-y-3" data-testid="infarmed-preview">
            <div className="grid gap-2 text-[12px] sm:grid-cols-4">
              <div><b>Ficheiro</b><br />{preview.nomeFicheiro}</div>
              <div><b>SHA-256</b><br /><span className="break-all font-mono text-[11px]">{preview.sha256}</span></div>
              <div><b>Linhas</b><br />{preview.linhasLidas} lidas · {preview.linhasValidas} válidas · {preview.linhasRejeitadas} rejeitadas</div>
              <div><b>Duplicados / conflitos</b><br />{preview.duplicadosIdenticos} / {preview.conflitos}</div>
            </div>
            {preview.rejeitadasAmostra.length > 0 && (
              <details className="text-[12px] text-slate-600">
                <summary>Linhas rejeitadas (amostra)</summary>
                <ul className="mt-1 list-disc pl-5">
                  {preview.rejeitadasAmostra.map((r) => (
                    <li key={r.linha}>linha {r.linha}: {r.motivo}</li>
                  ))}
                </ul>
              </details>
            )}
            <ResultadoTenants tenants={preview.tenants} mostrarNumeros />
            {nadaAFazer ? (
              <p className="text-[12px] text-slate-600" data-testid="infarmed-ja-processado">Este ficheiro já foi processado em todos os tenants — não há nada a aplicar.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[12px] text-slate-700">
                  Escreva <b>APLICAR</b> para confirmar:{" "}
                  <input
                    value={confirmar}
                    onChange={(e) => setConfirmar(e.target.value)}
                    data-testid="infarmed-confirmar"
                    className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-[12px]"
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  disabled={confirmar !== "APLICAR" || pendente}
                  onClick={() => aplicar()}
                  className="rounded-lg border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                  data-testid="infarmed-aplicar"
                >
                  {pendente ? "A aplicar…" : "Aplicar a todos os tenants"}
                </button>
              </div>
            )}
          </div>
        )}

        {resultado && (
          <div className="mt-4 space-y-2" data-testid="infarmed-resultado">
            <p className="text-[13px] font-medium">
              Resultado:{" "}
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${RESULTADO_TONE[resultado.estado] ?? ""}`} data-testid="infarmed-resultado-estado">
                {resultado.estado}
              </span>
            </p>
            <ResultadoTenants tenants={resultado.tenants} mostrarNumeros />
            {falhados.length > 0 && ficheiro && preview && (
              <button
                type="button"
                disabled={pendente || confirmar !== "APLICAR"}
                onClick={() => aplicar(falhados)}
                className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-[12px] font-medium text-rose-800 disabled:opacity-50"
                data-testid="infarmed-repetir-upload"
              >
                Repetir o upload nos tenants falhados ({falhados.join(", ")})
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── Histórico ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="infarmed-historico">
        <h2 className="text-[13px] font-semibold text-slate-900">Histórico recente</h2>
        <table className="mt-2 w-full text-[12px]">
          <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="py-1.5 pr-3">Quando</th>
              <th className="py-1.5 pr-3">Mês</th>
              <th className="py-1.5 pr-3">Origem</th>
              <th className="py-1.5 pr-3">Resultado</th>
              <th className="py-1.5 pr-3">SHA-256</th>
              <th className="py-1.5 pr-3">Utilizador</th>
              <th className="py-1.5">Motivo</th>
            </tr>
          </thead>
          <tbody>
            {estado.execucoes.length === 0 ? (
              <tr><td colSpan={7} className="py-3 text-slate-500">Sem execuções registadas.</td></tr>
            ) : (
              estado.execucoes.map((e) => <LinhaExecucao key={e.id} e={e} />)
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
