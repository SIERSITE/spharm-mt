"use server";

import { getEncomendasData } from "@/lib/encomendas-data";

export async function runEncomendasReport() {
  return getEncomendasData();
}
