/**
 * scripts/tests/test-portao-sessao.ts
 *
 * O portão de sessão do middleware, e a troca de password obrigatória.
 *
 * ─────────────────────────────────────────────────────────────────────
 * OS DOIS DEFEITOS QUE ISTO GUARDA
 *
 * 1. AS ROTAS NÃO ESTAVAM PROTEGIDAS.
 *
 *    O middleware só resolvia o tenant. A autenticação estava confiada a
 *    `requireSession()` no topo dos server components, e só /encomendas
 *    e /configuracoes o chamavam. Medido contra produção, sem cookie
 *    nenhum:
 *
 *      GET https://app.spharmmt.com/dashboard?__tenant=silveira  →  200
 *
 *    com a barra lateral e os dados de `getDashboardData()`, que é uma
 *    consulta à base do tenant.
 *
 * 2. `mustChangePassword` NÃO ERA APLICADO.
 *
 *    O campo era escrito por todos os caminhos de reset e nunca era lido
 *    para decidir nada. O login lia-o para um log de diagnóstico e
 *    redireccionava para /dashboard na mesma. E não havia página nenhuma
 *    onde trocar a password: o utilizador não era forçado a trocar E não
 *    podia trocar.
 *
 * Os tokens deste ficheiro são assinados a sério, com a mesma chave e a
 * mesma biblioteca que a aplicação usa. O que se exercita é o middleware
 * real, não uma imitação dele.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-portao-sessao.ts
 */
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { validarNovaPassword, MIN_CARACTERES } from "../../lib/password-policy";

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

const SEGREDO = "segredo-de-teste-com-tamanho-suficiente";

/** Um token assinado como o da aplicação. */
async function token(over: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: "u1",
    email: "f.silveirense@gmail.com",
    nome: "Administrador",
    perfil: "ADMINISTRADOR",
    farmaciaId: null,
    tenant: "silveira",
    ...over,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(SEGREDO));
}

/** Onde o middleware mandou o pedido, ou null se o deixou passar. */
function destino(res: { status: number; headers: Headers }): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  process.env.AUTH_SECRET = SEGREDO;
  process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
  process.env.TENANT_FALLBACK_ENABLED = "1";
  const { NextRequest } = await import("next/server");
  const { middleware } = await import("../../middleware");

  const pedido = (url: string, cookies: Record<string, string> = {}) => {
    const req = new NextRequest(new URL(url), {
      headers: { host: new URL(url).host },
    });
    for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
    return req;
  };

  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== sem sessão, rota protegida: /login ===");
  {
    for (const rota of ["/dashboard", "/stock", "/vendas", "/catalogo", "/configuracoes/utilizadores"]) {
      const res = await middleware(pedido(`https://app.spharmmt.com${rota}?__tenant=silveira`));
      check(destino(res) === "/login", `${rota} sem cookie → /login`, String(destino(res)));
    }
    // O caso medido em produção, que devolvia 200 com dados.
    const d = await middleware(pedido("https://app.spharmmt.com/dashboard?__tenant=silveira"));
    check(d.status >= 300 && d.status < 400, "o /dashboard já NÃO responde 200 sem sessão", String(d.status));
  }

  console.log("\n=== o tenant sobrevive ao redireccionamento ===");
  {
    // Sem isto, quem é mandado para /login aterra no tenant legacy e vê
    // "Credenciais inválidas" com a password certa — o bloqueio ficava a
    // parecer um erro de password.
    const res = await middleware(pedido("https://app.spharmmt.com/dashboard?__tenant=silveira"));
    const ck = res.cookies.get("__tenant");
    check(ck?.value === "silveira", "o cookie do tenant é escrito na resposta de redireccionamento", String(ck?.value));
  }

  console.log("\n=== rotas públicas continuam abertas ===");
  {
    const login = await middleware(pedido("https://app.spharmmt.com/login?__tenant=silveira"));
    check(destino(login) === null, "/login não é bloqueado");
    // As APIs têm autenticação própria (CRON_SECRET, withIntegrationAuth).
    // Um 307 para HTML seria ilegível para o agente on-premise.
    const api = await middleware(pedido("https://app.spharmmt.com/api/qualquer"));
    check(destino(api) === null, "/api/* não é redireccionado para HTML");
  }

  console.log("\n=== sessão válida entra ===");
  {
    const t = await token();
    const res = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", { session: t }),
    );
    check(destino(res) === null, "com sessão do tenant certo, /dashboard passa");
  }

  console.log("\n=== sessão de OUTRO tenant não serve ===");
  {
    const t = await token({ tenant: "sier" });
    const res = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", { session: t }),
    );
    check(destino(res) === "/login", "sessão do sier não abre o silveira", String(destino(res)));
  }

  console.log("\n=== token adulterado ou assinado com outra chave ===");
  {
    const outro = await new SignJWT({ sub: "u1", tenant: "silveira", mustChangePassword: false })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("8h")
      .sign(new TextEncoder().encode("chave-errada-mas-do-mesmo-tamanho-x"));
    const res = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", { session: outro }),
    );
    check(destino(res) === "/login", "assinatura de outra chave → /login");

    const lixo = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", { session: "nao-e-um-jwt" }),
    );
    check(destino(lixo) === "/login", "cookie que não é um JWT → /login");
  }

  console.log("\n=== mustChangePassword=true: só a página de troca ===");
  {
    const t = await token({ mustChangePassword: true });
    // O requisito: não pode contornar navegando directamente.
    for (const rota of ["/dashboard", "/stock", "/vendas", "/encomendas", "/configuracoes/utilizadores", "/admin/tenants"]) {
      const res = await middleware(
        pedido(`https://app.spharmmt.com${rota}?__tenant=silveira`, { session: t }),
      );
      check(
        destino(res) === "/alterar-password",
        `${rota} → /alterar-password`,
        String(destino(res)),
      );
    }
    const troca = await middleware(
      pedido("https://app.spharmmt.com/alterar-password?__tenant=silveira", { session: t }),
    );
    check(destino(troca) === null, "…e a própria página de troca abre");
  }

  console.log("\n=== quem já trocou não fica preso na página ===");
  {
    const t = await token({ mustChangePassword: false });
    const res = await middleware(
      pedido("https://app.spharmmt.com/alterar-password?__tenant=silveira", { session: t }),
    );
    check(destino(res) === "/dashboard", "/alterar-password → /dashboard", String(destino(res)));

    const normal = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", { session: t }),
    );
    check(destino(normal) === null, "…e o dashboard abre normalmente no login seguinte");
  }

  console.log("\n=== token antigo, sem o claim, não fica preso ===");
  {
    // Tokens emitidos antes desta alteração não têm o campo. Tratá-los
    // como "tem de trocar" prendia toda a gente com sessão aberta numa
    // página que não pediram.
    const t = await token();
    const res = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", { session: t }),
    );
    check(destino(res) === null, "claim ausente é tratado como false");
  }

  console.log("\n=== regras da nova password ===");
  {
    const casos: Array<[string, string, string, string, boolean]> = [
      ["tudo certo", "TempAbc123", "UmaPasswordNova1", "UmaPasswordNova1", true],
      ["confirmação diferente", "TempAbc123", "UmaPasswordNova1", "OutraCoisa123", false],
      ["curta demais", "TempAbc123", "curta", "curta", false],
      ["igual à actual", "TempAbc123", "TempAbc123", "TempAbc123", false],
      ["actual em branco", "", "UmaPasswordNova1", "UmaPasswordNova1", false],
      ["nova em branco", "TempAbc123", "", "", false],
    ];
    for (const [nome, a, n, c, esperado] of casos) {
      check(validarNovaPassword(a, n, c).ok === esperado, `${nome} → ${esperado ? "aceite" : "recusada"}`);
    }
    check(MIN_CARACTERES >= 10, `mínimo de ${MIN_CARACTERES} caracteres`);
    const exacta = "a".repeat(MIN_CARACTERES);
    check(validarNovaPassword("Temp123456", exacta, exacta).ok, "o mínimo exacto é aceite");
    const curta = "a".repeat(MIN_CARACTERES - 1);
    check(!validarNovaPassword("Temp123456", curta, curta).ok, "um caracter abaixo é recusado");
  }

  console.log("\n=== a acção faz o que promete ===");
  {
    const src = readFileSync("app/alterar-password/actions.ts", "utf8");
    check(src.includes("bcrypt.compare(actual"), "confirma a password actual antes de trocar");
    check(/bcrypt\.hash\(nova,\s*10\)/.test(src), "grava com bcrypt cost 10");
    check(src.includes("mustChangePassword: false"), "limpa o mustChangePassword");
    check(
      src.includes("createSessionToken(") && src.includes("mustChangePassword: false"),
      "reemite o token — senão o middleware continuava a mandar para cá",
    );
    check(src.includes('redirect("/dashboard")'), "e só depois deixa entrar no dashboard");
    check(src.includes('estado !== "ATIVO"'), "recusa um utilizador entretanto desactivado");

    const login = readFileSync("app/login/actions.ts", "utf8");
    check(
      login.includes("mustChangePassword: utilizador.mustChangePassword === true"),
      "o login põe o claim no token",
    );
    check(
      login.includes('"/alterar-password" : "/dashboard"'),
      "…e manda para a troca quando é preciso",
    );
  }

  console.log("\n=== o login não regista nada sobre a tentativa ===");
  {
    // O bloco de diagnóstico de 2026-06-17 escrevia, por cada tentativa,
    // um JSON com o email, o comprimento da password, o resultado do
    // `bcrypt.compare` e o prefixo do hash. Estava marcado para remoção,
    // e ficou mais de dois meses. Isto guarda a remoção.
    const login = readFileSync("app/login/actions.ts", "utf8");
    // Comentários fora: a nota que EXPLICA porque o bloco saiu tem de
    // poder nomear o que ele fazia.
    const codigo = login.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    check(!/console\./.test(codigo), "nenhum console.* no caminho de login");
    check(!/diag-login|diagId/.test(codigo), "nenhum vestígio do bloco de diagnóstico");
    check(!/pwdLen|password\.length/.test(codigo), "não regista o comprimento da password");
    check(!/bcryptOk|bcryptError|hashAlgo|hashPresent/.test(codigo), "não regista o resultado do bcrypt nem metadados do hash");
    check(!/connectedDb|current_database/.test(codigo), "não sonda a base de dados para diagnóstico");
    check(!/vercel/i.test(login), "nenhuma referência ao alojamento antigo, nem em comentário");
    check(!/x-tenant-source/.test(codigo), "já não lê o header que só o diagnóstico usava");

    // E o que TEM de continuar lá: o comportamento não muda com a limpeza.
    check(/bcrypt\.compare\(password/.test(codigo), "continua a validar a password com bcrypt");
    check(/estado !== "ATIVO"/.test(codigo), "continua a exigir conta activa");
    check(
      (codigo.match(/Credenciais inválidas/g) ?? []).length >= 2,
      "utilizador inexistente e password errada dão a MESMA mensagem",
    );
    check(/createSessionToken\(/.test(codigo), "continua a emitir o token");
    check(/cookieStore\.set\("session"/.test(codigo), "continua a escrever o cookie de sessão");
    check(
      /mustChangePassword: utilizador\.mustChangePassword === true/.test(codigo),
      "continua a pôr o claim no token",
    );
    check(
      /"\/alterar-password" : "\/dashboard"/.test(codigo),
      "continua a encaminhar conforme o claim",
    );

    // O header que só o diagnóstico consumia saiu com ele.
    const mw = readFileSync("middleware.ts", "utf8");
    check(
      !/requestHeaders\.set\("x-tenant-source"/.test(mw),
      "o x-tenant-source encaminhado saiu — ficou sem consumidor",
    );
    check(
      /x-tenant-source/.test(mw),
      "…mas continua exposto na RESPOSTA, que é onde serve para diagnosticar",
    );
  }
  console.log("\n=== o nome na barra lateral é o do utilizador ===");
  {
    const shell = readFileSync("components/layout/app-shell.tsx", "utf8");
    // Comentários fora: o defeito está no que se RENDERIZA, e a
    // explicação de porque existiu tem de poder nomeá-lo.
    const codigo = shell.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check(!/Nuno/.test(codigo), "nenhum nome escrito à mão no código");
    check(!/>\s*Administrador\s*</.test(codigo), "nem o perfil escrito à mão");
    check(codigo.includes("useUtilizador()"), "lê o utilizador do contexto da sessão");
    check(codigo.includes("{utilizador.nome}"), "mostra o nome real");
    check(codigo.includes("inicial(utilizador.nome)"), "e a inicial vem do nome, não é um 'N' fixo");
    check(
      /utilizador \? \(/.test(codigo),
      "sem sessão não desenha o bloco — não há nome de reserva",
    );

    const layout = readFileSync("app/layout.tsx", "utf8");
    check(layout.includes("getSession()"), "o layout raiz lê a sessão");
    check(layout.includes("<SessionProvider"), "…e distribui-a por contexto");
    check(
      layout.includes("sessao.nome") && layout.includes("sessao.perfil"),
      "…com os dados reais do utilizador autenticado",
    );

    const provider = readFileSync("components/layout/session-provider.tsx", "utf8");
    check(
      /createContext<UtilizadorSessao \| null>\(null\)/.test(provider),
      "o contexto tem null por omissão, não um utilizador inventado",
    );
  }
}

main().then(() => {
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
});
