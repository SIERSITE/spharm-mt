/**
 * scripts/tests/test-perfis-utilizadores.ts
 *
 * Quem pode gerir utilizadores — e, sobretudo, quem não pode.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * `users.manage` e `users.view` incluíam o GESTOR_GRUPO. A única coisa
 * que o separava de um ADMINISTRADOR era uma linha no `updateUtilizador`
 * a proibi-lo de ATRIBUIR o perfil ADMINISTRADOR. Podia, com tudo o
 * resto: editar qualquer conta, repor a password de qualquer pessoa,
 * desactivar contas — e DESPROMOVER um administrador, que é a mesma
 * coisa que tirar do caminho quem o pudesse travar.
 *
 * E aconteceu, sem ser de propósito: em 2026-08-28, uma edição pela
 * interface deixou o `f.silveirense@gmail.com` a GESTOR_GRUPO. Como
 * GESTOR_GRUPO já não se conseguia repor — o perfil que lhe faltava era
 * exactamente o que era preciso para o devolver.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEFESA EM PROFUNDIDADE, E COMO É QUE ISSO SE TESTA
 *
 * A regra tem de valer mesmo que alguém chame a server action
 * directamente, sem passar pela página. Por isso o que se exercita aqui
 * são as GUARDAS — funções puras, chamadas a sério — e não a interface.
 * As asserções sobre o código-fonte servem só para provar que as acções
 * as chamam de facto, e antes de qualquer escrita.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-perfis-utilizadores.ts
 */
import { readFileSync } from "node:fs";
import {
  PERFIS_QUE_GEREM_UTILIZADORES,
  podeGerirUtilizadores,
  exigirGestaoUtilizadores,
  validarAlteracaoDePerfil,
  validarAlteracaoDeEstado,
  type PerfilUtilizador,
} from "../../lib/utilizadores-guardas";

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

const TODOS: PerfilUtilizador[] = [
  "ADMINISTRADOR",
  "GESTOR_GRUPO",
  "GESTOR_FARMACIA",
  "OPERADOR",
];

console.log("\n=== quem gere utilizadores ===");
{
  check(
    PERFIS_QUE_GEREM_UTILIZADORES.length === 1 &&
      PERFIS_QUE_GEREM_UTILIZADORES[0] === "ADMINISTRADOR",
    "ADMINISTRADOR é o único perfil com gestão de utilizadores",
    `lista = ${PERFIS_QUE_GEREM_UTILIZADORES.join(", ")}`,
  );
  check(podeGerirUtilizadores("ADMINISTRADOR"), "ADMINISTRADOR pode gerir");
  for (const p of TODOS.filter((x) => x !== "ADMINISTRADOR")) {
    check(!podeGerirUtilizadores(p), `${p} NÃO pode gerir`);
  }
  check(!podeGerirUtilizadores(null), "sem perfil não gere");
  check(!podeGerirUtilizadores(undefined), "perfil indefinido não gere");
  check(!podeGerirUtilizadores(""), "perfil vazio não gere");
  check(
    !podeGerirUtilizadores("administrador"),
    "a comparação é sensível a maiúsculas — 'administrador' não passa",
  );
}

console.log("\n=== o portão devolve recusa, não silêncio ===");
{
  const admin = exigirGestaoUtilizadores("ADMINISTRADOR");
  check(admin.ok, "ADMINISTRADOR passa o portão");

  const grupo = exigirGestaoUtilizadores("GESTOR_GRUPO");
  check(!grupo.ok, "GESTOR_GRUPO é recusado");
  check(
    !grupo.ok && grupo.erro.length > 0 && /Administrador/.test(grupo.erro),
    "…com uma mensagem que diz porquê",
    !grupo.ok ? grupo.erro : "",
  );
}

console.log("\n=== a matriz de permissões (lib/permissions.ts) ===");
{
  const src = readFileSync("lib/permissions.ts", "utf8");
  const matriz = src.slice(src.indexOf("const PERMISSIONS"));

  const linha = (perm: string): string => {
    const m = matriz.match(new RegExp(`"${perm.replace(".", "\\.")}":\\s*\\[([^\\]]*)\\]`));
    return m ? m[1] : "";
  };

  for (const perm of ["users.manage", "users.view"]) {
    const l = linha(perm);
    check(l.includes("ADMINISTRADOR"), `${perm} inclui ADMINISTRADOR`);
    check(!l.includes("GESTOR_GRUPO"), `${perm} NÃO inclui GESTOR_GRUPO`, l.trim());
    check(!l.includes("GESTOR_FARMACIA"), `${perm} NÃO inclui GESTOR_FARMACIA`);
    check(!l.includes("OPERADOR"), `${perm} NÃO inclui OPERADOR`);
  }

  // Controlo negativo: o GESTOR_GRUPO perde a gestão de contas e MAIS
  // NADA. Se este bloco falhar, a correcção foi longe demais e tirou-lhe
  // o trabalho do grupo.
  for (const perm of [
    "settings.global",
    "settings.farmacia",
    "reports.write",
    "reports.read",
    "catalog.write",
    "catalog.read",
  ]) {
    check(
      linha(perm).includes("GESTOR_GRUPO"),
      `controlo negativo: GESTOR_GRUPO mantém ${perm}`,
      linha(perm).trim(),
    );
  }
}

console.log("\n=== as server actions chamam o portão antes de escrever ===");
{
  const src = readFileSync("app/configuracoes/utilizadores/actions.ts", "utf8");
  const accoes = [
    "createUtilizador",
    "updateUtilizador",
    "toggleEstadoUtilizador",
    "resetPasswordUtilizador",
  ];

  for (const nome of accoes) {
    const i = src.indexOf(`export async function ${nome}`);
    check(i >= 0, `${nome} existe`);
    if (i < 0) continue;
    const seguinte = accoes
      .map((n) => src.indexOf(`export async function ${n}`))
      .filter((x) => x > i)
      .sort((a, b) => a - b)[0];
    const corpo = src.slice(i, seguinte === undefined ? src.length : seguinte);

    check(
      corpo.includes("exigirGestaoUtilizadores(session.perfil)"),
      `${nome} chama o portão`,
    );
    check(
      /if \(!portao\.ok\) return \{ ok: false as const, error: portao\.erro \}/.test(corpo),
      `${nome} devolve a recusa em vez de continuar`,
    );

    // O portão tem de vir ANTES de qualquer toque na base. Se a ordem se
    // inverter num refactor, isto apanha-o.
    const posPortao = corpo.indexOf("exigirGestaoUtilizadores");
    const posPrisma = corpo.indexOf("getPrisma()");
    check(
      posPrisma === -1 || posPortao < posPrisma,
      `${nome}: o portão vem antes de getPrisma()`,
      `portao@${posPortao} prisma@${posPrisma}`,
    );
    for (const escrita of [".create(", ".update(", ".updateMany(", ".deleteMany(", ".createMany("]) {
      const pos = corpo.indexOf(escrita);
      check(
        pos === -1 || posPortao < pos,
        `${nome}: o portão vem antes de ${escrita.replace("(", "")}`,
      );
    }
  }

  check(
    !src.includes('requirePermission("users.manage")'),
    "as acções deixaram de depender só do redireccionamento do requirePermission",
  );
  check(
    src.includes("await requireSession()"),
    "…mas continuam a exigir sessão autenticada",
  );
}

console.log("\n=== a interface não mostra o que a pessoa não pode fazer ===");
{
  const shell = readFileSync("components/layout/app-shell.tsx", "utf8");
  check(
    /soAdministrador: true/.test(shell) &&
      /href: "\/configuracoes\/utilizadores"/.test(shell),
    "o item Utilizadores está marcado como só-administrador",
  );
  check(
    /ehAdministrador\s*=\s*utilizador\?\.perfil === "ADMINISTRADOR"/.test(shell),
    "o perfil vem da sessão, não de uma prop opcional",
  );
  check(
    /items: g\.items\.filter\(\(i\) => !i\.soAdministrador \|\| ehAdministrador\)/.test(shell),
    "os itens só-administrador são filtrados",
  );
  check(
    /\.filter\(\(g\) => g\.items\.length > 0\)/.test(shell),
    "uma secção que fique vazia não deixa o rótulo órfão",
  );

  // A troca da própria password fica ao alcance de TODOS os perfis.
  check(
    /href: "\/alterar-password"/.test(shell),
    "existe entrada de menu para alterar a própria password",
  );
  const itemConta = shell.slice(shell.indexOf('href: "/alterar-password"'));
  check(
    !itemConta.slice(0, 200).includes("soAdministrador"),
    "…e NÃO está limitada a administradores",
  );

  const pagina = readFileSync("app/configuracoes/utilizadores/page.tsx", "utf8");
  check(
    pagina.includes('requirePermission("users.view")'),
    "a página de gestão continua a exigir users.view",
  );

  const troca = readFileSync("app/alterar-password/page.tsx", "utf8");
  check(
    !troca.includes("requirePermission"),
    "a troca da própria password NÃO exige permissão de gestão",
  );
  check(
    troca.includes("getSession()") && troca.includes('redirect("/login")'),
    "…mas exige sessão",
  );
}

console.log("\n=== ninguém fica sem administração ===");
{
  const base = {
    actorId: "admin-1",
    actorPerfil: "ADMINISTRADOR",
    alvoId: "admin-2",
    alvoPerfilActual: "ADMINISTRADOR",
    perfilPedido: "GESTOR_GRUPO",
    totalAdministradoresAtivos: 2,
  };

  check(
    validarAlteracaoDePerfil(base).ok,
    "um administrador pode despromover OUTRO, havendo mais do que um",
  );

  const proprio = validarAlteracaoDePerfil({ ...base, alvoId: "admin-1" });
  check(!proprio.ok, "um administrador NÃO se pode despromover a si próprio");
  check(
    !proprio.ok && /repor/.test(proprio.erro),
    "…e a mensagem explica que ficaria sem forma de o repor",
  );

  const ultimo = validarAlteracaoDePerfil({
    ...base,
    totalAdministradoresAtivos: 1,
  });
  check(!ultimo.ok, "o ÚLTIMO administrador não pode ser despromovido");

  // Controlo negativo: promover, ou mexer em quem não é administrador,
  // não é assunto desta guarda.
  check(
    validarAlteracaoDePerfil({
      ...base,
      alvoPerfilActual: "OPERADOR",
      perfilPedido: "ADMINISTRADOR",
      totalAdministradoresAtivos: 1,
    }).ok,
    "controlo negativo: promover a ADMINISTRADOR passa sempre",
  );
  check(
    validarAlteracaoDePerfil({
      ...base,
      alvoPerfilActual: "OPERADOR",
      perfilPedido: "GESTOR_FARMACIA",
      totalAdministradoresAtivos: 1,
    }).ok,
    "controlo negativo: mexer em quem não é administrador passa",
  );
  check(
    validarAlteracaoDePerfil({
      ...base,
      alvoId: "admin-1",
      perfilPedido: "ADMINISTRADOR",
    }).ok,
    "controlo negativo: guardar-se a si próprio SEM mudar de perfil passa",
  );
}

console.log("\n=== estado: não se tranca ninguém para fora ===");
{
  const base = {
    actorId: "admin-1",
    alvoId: "u-2",
    alvoPerfil: "OPERADOR",
    estadoPedido: "INATIVO" as const,
    totalAdministradoresAtivos: 2,
  };
  check(validarAlteracaoDeEstado(base).ok, "desactivar outra pessoa passa");
  check(
    !validarAlteracaoDeEstado({ ...base, alvoId: "admin-1" }).ok,
    "não se pode desactivar a própria conta",
  );
  check(
    !validarAlteracaoDeEstado({
      ...base,
      alvoPerfil: "ADMINISTRADOR",
      totalAdministradoresAtivos: 1,
    }).ok,
    "não se pode desactivar o último administrador",
  );
  check(
    validarAlteracaoDeEstado({ ...base, estadoPedido: "ATIVO", alvoId: "admin-1" }).ok,
    "controlo negativo: REACTIVAR nunca é bloqueado",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
