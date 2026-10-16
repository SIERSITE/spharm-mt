/**
 * agent/src/subprocesso.ts
 *
 * Lança um subcomando do agent (`compras-upload`, `stocksmov-upload`, …) de forma ASSÍNCRONA, com um observador do lock:
 * se a execução-pai perder o lock (reclamado com `--force`, apagado…), o subprocesso é TERMINADO de imediato — nunca fica um
 * filho a escrever em paralelo com a nova dona. (Com `spawnSync` o pai ficava bloqueado e não podia reagir.)
 *
 * O filho também se protege sozinho: herda o `runId` do lock e cada escrita sua confirma-o (`guarda-escrita.ts`).
 */

import { spawn } from "node:child_process";

export async function correrSubcomando(
  nodeArgs: string[],
  env: NodeJS.ProcessEnv,
  opts: { perdido?: () => boolean; intervaloMs?: number; log?: (linha: string) => void; nome?: string } = {},
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { stdio: "inherit", env });
    let terminadoPorPerda = false;
    const t = opts.perdido
      ? setInterval(() => {
          try {
            if (!terminadoPorPerda && opts.perdido!()) {
              terminadoPorPerda = true;
              (opts.log ?? ((l: string) => console.error(l)))(`✗ Lock perdido: o subprocesso ${opts.nome ?? ""} foi TERMINADO (outra execução tem agora o lock).`);
              child.kill();
            }
          } catch {
            /* ignore */
          }
        }, opts.intervaloMs ?? 2_000)
      : null;
    const fim = (code: number) => {
      if (t) clearInterval(t);
      resolve(code);
    };
    child.on("error", (e) => {
      (opts.log ?? ((l: string) => console.error(l)))(`✗ spawn ${opts.nome ?? ""} falhou: ${e.message}`);
      fim(1);
    });
    child.on("close", (code) => fim(terminadoPorPerda ? 1 : typeof code === "number" ? code : 1));
  });
}
