"use server";

import { getTransferenciasData } from "@/lib/transferencias-data";

export async function runTransferenciasReport() {
  return getTransferenciasData();
}
