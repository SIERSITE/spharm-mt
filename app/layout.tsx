import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { getSession } from "@/lib/auth";
import { SessionProvider } from "@/components/layout/session-provider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SPharm.MT",
  description: "Gestão inteligente de farmácias",
};

/**
 * A sessao e' lida AQUI, uma vez por request, e distribuida por
 * contexto. E' o que permite a barra lateral mostrar o utilizador real
 * tanto nas paginas servidas pela `MainShell` como nas oito que
 * renderizam a `AppShell` a partir do cliente.
 *
 * Ler cookies torna a arvore dinamica — o que ja' era: todas as rotas
 * desta aplicacao sao renderizadas por pedido.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const sessao = await getSession();
  const utilizador = sessao
    ? { nome: sessao.nome, email: sessao.email, perfil: sessao.perfil }
    : null;

  return (
    <html
      lang="pt-PT"
      className={`${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SessionProvider utilizador={utilizador}>{children}</SessionProvider>
      </body>
    </html>
  );
}