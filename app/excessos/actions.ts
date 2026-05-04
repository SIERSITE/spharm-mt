"use server";

import {
  getExcessosData,
  type ExcessosOptions,
} from "@/lib/transferencias-data";

export async function runExcessosReport(options?: ExcessosOptions) {
  return getExcessosData(options);
}
