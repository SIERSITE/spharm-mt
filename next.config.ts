import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
