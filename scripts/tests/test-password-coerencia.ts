/**
 * scripts/tests/test-password-coerencia.ts
 *
 * A mesma password tem de valer o mesmo em todos os caminhos.
 *
 * ─────────────────────────────────────────────────────────────────────
 * OS DOIS DEFEITOS QUE ISTO GUARDA
 *
 * 1. `trim` ASSIMÉTRICO — e foi isto que trancou uma conta real.
 *
 *    O `loginAction` fazia `String(formData.get("password")).trim()`. As
 *    três escritas — `createUtilizador`, `updateUtilizador`,
 *    `alterarPassword` — não faziam. O hash ficava sobre `"segredo "` e
 *    a comparação era sempre contra `"segredo"`.
 *
 *    Em 2026-08-28 o `f.silveirense@gmail.com` deixou de conseguir
 *    entrar depois de definir a password em Configurações. O hash TINHA
 *    mudado — provado contra catorze cópias de segurança diárias — mas
 *    nunca autenticava. Nenhum dos dois lados estava errado sozinho: era
 *    a diferença entre eles.
 *
 * 2. PASSWORD CURTA IGNORADA EM SILÊNCIO.
 *
 *    `updateUtilizador` só escrevia `if (input.password.length >= 8)`.
 *    Abaixo disso saltava a escrita e devolvia `{ ok: true }`. A
 *    interface dizia "guardado", a password ficava a anterior.
 *
 * E um terceiro, que não é de password mas vinha no mesmo formulário:
 * o `mustChangePassword` nascia sempre `true` em edição, e gravar a
 * ficha de alguém para corrigir o nome mandava-o para o ecrã de troca
 * de password no login seguinte.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O bcrypt aqui é o de verdade, não uma imitação: as asserções sobre
 * espaços fazem `hash` e `compare` a sério, e é isso que prova que a
 * assimetria trancava mesmo a conta.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-password-coerencia.ts
 */
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { MIN_CARACTERES, validarNovaPassword } from "../../lib/password-policy";
import {
  validarPasswordAdministrativa,
  devePersistirPassword,
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

/** O ficheiro sem comentários: a nota que EXPLICA o defeito nomeia-o. */
function codigo(caminho: string): string {
  return readFileSync(caminho, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

async function main() {
  console.log("\n=== uma password com espaços nas pontas autentica COM eles ===");
  {
    const COM = "  segredo com espaços  ";
    const SEM = COM.trim();

    // Como a aplicação grava: sem aparar.
    const hash = await bcrypt.hash(COM, 10);

    check(
      await bcrypt.compare(COM, hash),
      "a password exacta, espaços incluídos, autentica",
    );
    check(
      !(await bcrypt.compare(SEM, hash)),
      "a mesma password SEM os espaços NÃO autentica",
    );
    check(
      !(await bcrypt.compare(COM.trimStart(), hash)),
      "faltar só o espaço da frente já chega para falhar",
    );
    check(
      !(await bcrypt.compare(COM.trimEnd(), hash)),
      "faltar só o espaço do fim já chega para falhar",
    );

    // E o simétrico: gravar aparado e tentar entrar com os espaços.
    const hashAparado = await bcrypt.hash(SEM, 10);
    check(
      await bcrypt.compare(SEM, hashAparado),
      "controlo negativo: gravada sem espaços, entra sem espaços",
    );
    check(
      !(await bcrypt.compare(COM, hashAparado)),
      "…e não entra com eles",
    );

    // A ESTRUTURA do defeito: gravar cru, comparar aparado.
    const comoEra = await bcrypt.compare(COM.trim(), await bcrypt.hash(COM, 10));
    check(
      comoEra === false,
      "reprodução do defeito: gravar cru e comparar aparado nunca bate",
    );
  }

  console.log("\n=== nenhum caminho apara a password ===");
  {
    const login = codigo("app/login/actions.ts");
    check(
      /formData\.get\("password"\) \|\| ""\)\s*;/.test(login),
      "login: lê a password sem .trim()",
    );
    check(
      !/get\("password"\)[^;]*\.trim\(\)/.test(login),
      "login: não sobra nenhum .trim() na password",
    );
    // Controlo negativo: o EMAIL continua normalizado.
    check(
      /get\("email"\)[^;]*\.trim\(\)\.toLowerCase\(\)/.test(login),
      "controlo negativo: o email continua a ser normalizado",
    );

    const caminhos: Array<[string, string]> = [
      ["app/configuracoes/utilizadores/actions.ts", "criação/edição pela interface"],
      ["app/alterar-password/actions.ts", "troca pelo próprio"],
      ["lib/admin/ops/add-user.ts", "criação por operação de admin"],
      ["scripts/admin/reset-user-password.ts", "reset pela linha de comandos"],
      ["scripts/tenancy/add-user.ts", "criação pela linha de comandos"],
      ["scripts/control/create-global-admin.ts", "criação do admin global"],
      ["lib/admin/create-client-workflow.ts", "criação de tenant"],
      ["scripts/tenancy/provision-tenant.ts", "aprovisionamento de tenant"],
    ];
    for (const [ficheiro, descricao] of caminhos) {
      const src = codigo(ficheiro);
      const suspeitas = (src.match(/[Pp]assword[A-Za-z]*\s*(\?\.)?\.?trim\(\)/g) ?? []).concat(
        src.match(/trim\(\)[^;\n]*[Pp]assword/g) ?? [],
      );
      check(
        suspeitas.length === 0,
        `${descricao}: sem trim de password`,
        suspeitas.join(" | "),
      );
    }
  }

  console.log("\n=== o mínimo é UM só, e é o da aplicação ===");
  {
    check(MIN_CARACTERES >= 10, `MIN_CARACTERES = ${MIN_CARACTERES}`);

    const src = codigo("app/configuracoes/utilizadores/actions.ts");
    check(
      !/length < 8/.test(src) && !/length >= 8/.test(src),
      "a criação/edição deixou de ter o 8 escrito à mão",
    );
    check(
      /validarPasswordAdministrativa\(/.test(src),
      "…e usa a regra partilhada",
    );

    const cliente = codigo("components/settings/utilizadores-client.tsx");
    check(
      /MIN_CARACTERES/.test(cliente),
      "o rótulo do campo mostra o mínimo real, não um número copiado",
    );
  }

  console.log("\n=== password curta: erro explícito, nada gravado ===");
  {
    const curta = "a".repeat(MIN_CARACTERES - 1);

    const naCriacao = validarPasswordAdministrativa(curta, true);
    check(!naCriacao.ok, "criação: password curta é recusada");
    check(
      !naCriacao.ok && new RegExp(String(MIN_CARACTERES)).test(naCriacao.erro),
      "…com o mínimo na mensagem",
      !naCriacao.ok ? naCriacao.erro : "",
    );

    const naEdicao = validarPasswordAdministrativa(curta, false);
    check(!naEdicao.ok, "edição: password curta é recusada — não é ignorada");
    check(
      !naEdicao.ok && /Nada foi guardado/.test(naEdicao.erro),
      "…e a mensagem diz que nada foi guardado",
      !naEdicao.ok ? naEdicao.erro : "",
    );

    check(
      validarPasswordAdministrativa("a".repeat(MIN_CARACTERES), false).ok,
      "no mínimo exacto passa",
    );
    check(
      validarPasswordAdministrativa("", false).ok,
      "edição com campo vazio passa — significa 'manter'",
    );
    check(
      validarPasswordAdministrativa(undefined, false).ok,
      "edição sem campo passa",
    );
    check(
      !validarPasswordAdministrativa("", true).ok,
      "criação com campo vazio é recusada",
    );
    check(
      !validarPasswordAdministrativa(undefined, true).ok,
      "criação sem campo é recusada",
    );

    // A regra do não-aparar aplicada ao mínimo.
    check(
      !validarPasswordAdministrativa("   ", false).ok,
      "'   ' é CURTA (três caracteres), não vazia",
    );
    check(
      validarPasswordAdministrativa(" ".repeat(MIN_CARACTERES), false).ok,
      `${MIN_CARACTERES} espaços são uma password válida — não se apara`,
    );

    // Só o campo preenchido dá origem a escrita.
    check(!devePersistirPassword(""), "campo vazio não gera escrita");
    check(!devePersistirPassword(undefined), "campo ausente não gera escrita");
    check(devePersistirPassword(" "), "um único espaço JÁ é conteúdo");
    check(devePersistirPassword("a".repeat(MIN_CARACTERES)), "password válida gera escrita");
  }

  console.log("\n=== a validação acontece ANTES de qualquer escrita ===");
  {
    const src = readFileSync("app/configuracoes/utilizadores/actions.ts", "utf8");
    const i = src.indexOf("export async function updateUtilizador");
    const corpo = src.slice(i);

    const posValidacao = corpo.indexOf("validarPasswordAdministrativa");
    const posTransaccao = corpo.indexOf("$transaction");
    check(posValidacao >= 0 && posTransaccao >= 0, "ambos existem no update");
    check(
      posValidacao < posTransaccao,
      "a validação da password vem antes da transacção",
      `validacao@${posValidacao} transaccao@${posTransaccao}`,
    );
    // Nada parcial: se a password for recusada, o nome e o perfil também
    // não são gravados.
    check(
      /if \(!passwordOk\.ok\) return \{ ok: false as const, error: passwordOk\.erro \};[\s\S]{0,80}try \{/.test(
        corpo,
      ),
      "recusar a password devolve antes do try — nada é gravado parcialmente",
    );
    check(
      !/length >= 8\s*\n?\s*\? \{ passwordHash/.test(corpo),
      "a escrita condicional silenciosa desapareceu",
    );
    check(
      /devePersistirPassword\(input\.password\)/.test(corpo),
      "…substituída por uma condição que só distingue 'preenchido' de 'vazio'",
    );
  }

  console.log("\n=== mustChangePassword não nasce true em edição ===");
  {
    const src = codigo("components/settings/utilizadores-client.tsx");
    check(
      !/useState\(true\)/.test(src),
      "já não existe useState(true) para a flag",
    );
    check(
      /mode === "create" \? true : initial\?\.mustChangePassword \?\? false/.test(src),
      "criação → true; edição → o valor real do utilizador",
    );

    const accoes = codigo("app/configuracoes/utilizadores/actions.ts");
    check(
      /input\.mustChangePassword !== undefined/.test(accoes),
      "o servidor só escreve a flag se o formulário disser alguma coisa",
    );

    // O tipo tem de trazer o valor real da base, senão o inicial é uma
    // adivinha.
    const dados = readFileSync("lib/utilizadores-data.ts", "utf8");
    check(
      /mustChangePassword: boolean/.test(dados) &&
        /mustChangePassword: u\.mustChangePassword/.test(dados),
      "a listagem traz o mustChangePassword real de cada conta",
    );
  }

  console.log("\n=== a troca pelo próprio continua com as suas regras ===");
  {
    const dez = "a".repeat(MIN_CARACTERES);
    check(!validarNovaPassword("", dez, dez).ok, "exige a password actual");
    check(!validarNovaPassword("actual", dez, "outra").ok, "confirmação tem de coincidir");
    check(
      !validarNovaPassword("actual", "a".repeat(MIN_CARACTERES - 1), "a".repeat(MIN_CARACTERES - 1)).ok,
      "aplica o mínimo",
    );
    check(!validarNovaPassword(dez, dez, dez).ok, "a nova tem de ser diferente da actual");
    check(validarNovaPassword("actual", dez, dez).ok, "controlo negativo: um caso válido passa");

    // E não apara: "  x  " e "x" são passwords diferentes.
    const comEspacos = `  ${dez}  `;
    check(
      validarNovaPassword(dez, comEspacos, comEspacos).ok,
      "a nova com espaços é aceite e é DIFERENTE da actual sem eles",
    );

    const src = codigo("app/alterar-password/actions.ts");
    check(
      /String\(formData\.get\("nova"\) \?\? ""\)/.test(src),
      "lê a nova password sem aparar",
    );
    check(/bcrypt\.hash\(nova, 10\)/.test(src), "cifra com custo 10");
    check(/bcrypt\.compare\(actual/.test(src), "confirma a password actual");
    check(/user\.password_changed/.test(src), "regista user.password_changed na AuditLog");
    check(
      /where: \{ id: utilizador\.id \}/.test(src) && /sessao\.sub/.test(src),
      "só mexe na conta da sessão actual",
    );
    check(
      !/perfil:\s*(input|formData)/.test(src),
      "não deixa alterar o perfil por este caminho",
    );
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
