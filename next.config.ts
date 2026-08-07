import type { NextConfig } from "next";
import { resolveAllowedOrigins } from "./lib/server-actions-origins";

/**
 * Origens autorizadas a invocar Server Actions.
 *
 * Resolvido no BUILD, porque é aí que o Next fixa esta configuração no
 * bundle do servidor — mudar a lista obriga a reconstruir a imagem.
 *
 * Sem isto, atrás do reverse proxy o `Origin` do browser
 * (`127.0.0.1:8080` num túnel SSH) não bate com o `Host`, e cada
 * submissão de formulário morre em `Invalid Server Actions request`.
 *
 * A função ATIRA em produção quando não há nada que resolver: um build
 * que falha é muito melhor do que uma imagem que só se descobre partida
 * quando alguém tenta autenticar-se.
 */
const serverActionsAllowedOrigins = resolveAllowedOrigins({
  raw: process.env.SERVER_ACTIONS_ALLOWED_ORIGINS,
  publicAppUrl: process.env.PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL,
  isProduction: process.env.NODE_ENV === "production",
});

if (serverActionsAllowedOrigins.length > 0) {
  // Fica no log do build: é o registo de que origens aquele artefacto
  // aceita, sem ter de o desmontar.
  console.log(
    `[next.config] Server Actions — origens autorizadas: ${serverActionsAllowedOrigins.join(", ")}`,
  );
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: serverActionsAllowedOrigins,
    },
  },

  /**
   * Build auto-contido para container (`.next/standalone/server.js`).
   *
   * Sem isto, a imagem tinha de levar `node_modules` inteiro — incluindo
   * devDependencies e o Chromium do puppeteer — só para correr `next start`.
   * Com standalone, o `next build` traça o grafo real de imports e copia
   * apenas o que é usado.
   *
   * `public/` e `.next/static` NÃO são copiados pelo build — o Dockerfile
   * copia-os explicitamente (ver `deploy/docker/Dockerfile`).
   */
  output: "standalone",

  /**
   * Packages que têm de ficar FORA do bundle do servidor.
   * - puppeteer: descarrega e lança um binário Chromium, não pode ser
   *   empacotado pelo Webpack/Turbopack.
   * - nodemailer: depende de APIs Node e TLS; o bundler tenta resolver
   *   módulos opcionais internos que não existem.
   *
   * Sem esta configuração, as rotas /api/reports/pdf e /api/reports/email
   * falham em build ou runtime com "Module not found" ou erros de stream.
   */
  serverExternalPackages: ["puppeteer", "nodemailer"],
};

export default nextConfig;
