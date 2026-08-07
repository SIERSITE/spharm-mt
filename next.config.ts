import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
