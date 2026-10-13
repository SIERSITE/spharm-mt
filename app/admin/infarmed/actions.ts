"use server";

/**
 * app/admin/infarmed/actions.ts
 *
 * Server actions de /admin/infarmed. Finas de propósito: a autorização e toda a
 * lógica estão em `lib/regulamentar/infarmed-admin.ts` (testadas com bases
 * reais) — cada ação valida a SESSÃO de platform admin (não basta esconder o
 * link) e usa o mesmo motor de importação da atualização automática.
 */

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { criarDependenciasReais } from "@/lib/regulamentar/infarmed-runtime";
import { acaoAplicarUpload, acaoRepetir, acaoValidarUpload } from "@/lib/regulamentar/infarmed-admin";

export async function validarUploadAction(formData: FormData) {
  return acaoValidarUpload(criarDependenciasReais(), await getSession(), formData.get("ficheiro"));
}

export async function aplicarUploadAction(formData: FormData) {
  const r = await acaoAplicarUpload(criarDependenciasReais(), await getSession(), {
    ficheiro: formData.get("ficheiro"),
    sha256Esperado: String(formData.get("sha256") ?? ""),
    confirmar: String(formData.get("confirmar") ?? ""),
    onlySlugs: formData.getAll("tenant").map(String).filter(Boolean),
    forcar: formData.get("forcar") === "1",
  });
  revalidatePath("/admin/infarmed");
  return r;
}

export async function repetirDescarregamentoAction(formData: FormData) {
  const r = await acaoRepetir(criarDependenciasReais(), await getSession(), {
    onlySlugs: formData.getAll("tenant").map(String).filter(Boolean),
    forcar: formData.get("forcar") === "1",
  });
  revalidatePath("/admin/infarmed");
  return r;
}
