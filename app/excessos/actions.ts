"use server";

import { getExcessosData } from "@/lib/transferencias-data";

export async function runExcessosReport() {
  return getExcessosData();
}
