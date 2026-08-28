/**
 * scripts/control/create-global-admin.ts
 *
 * Cria o PRIMEIRO administrador global da plataforma, na tabela
 * `GlobalAdmin` do control plane.
 *
 * É um script de bootstrap: existe porque a tabela nasce vazia e não há
 * forma de criar o primeiro admin pela aplicação — quem entraria para o
 * fazer ainda não existe.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE ESTE SCRIPT NÃO FAZ, e é deliberado
 * ─────────────────────────────────────────────────────────────────────
 *   · não redefine passwords — se o admin existir, recusa. Um script de
 *     bootstrap que também sabe repor credenciais é um script de
 *     escalonamento de privilégios à espera de acontecer;
 *   · não faz upsert. Ou cria uma linha nova, ou falha e diz porquê;
 *   · não toca na base legacy nem em nenhuma base de tenant. Liga-se
 *     EXCLUSIVAMENTE a `CONTROL_DATABASE_URL`;
 *   · não aceita a password num argumento. Argumentos ficam no histórico
 *     da shell, no `ps` de qualquer utilizador da máquina e nos logs de
 *     auditoria do sudo.
 *
 * ─────────────────────────────────────────────────────────────────────
 * USO
 * ─────────────────────────────────────────────────────────────────────
 *   npm run control:create-global-admin -- --email a@b.pt --nome "Nome"
 *
 * A password é pedida em prompt oculto. Sem terminal (pipeline, CI), é
 * lida do stdin em DUAS linhas — password e confirmação:
 *
 *   printf '%s\n%s\n' "$PWD1" "$PWD2" | npm run control:create-global-admin -- \
 *     --email a@b.pt --nome "Nome"
 *
 * O destino é sempre mostrado (host/base, nunca credenciais) e tem de ser
 * confirmado — `--yes` em automação.
 *
 * Por defeito só cria quando a tabela está VAZIA. Para acrescentar um
 * segundo administrador mais tarde, é preciso pedi-lo explicitamente com
 * `--allow-existing` — nunca acontece por acidente.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CÓDIGOS DE SAÍDA
 * ─────────────────────────────────────────────────────────────────────
 *   0  administrador criado
 *   1  uso incorrecto (argumentos em falta ou inválidos)
 *   7  destino não confirmado (sem --yes num contexto não interactivo,
 *      ou resposta negativa ao pedido de confirmação)
 *   2  CONTROL_DATABASE_URL ausente
 *   3  já existe pelo menos um GlobalAdmin e faltou --allow-existing
 *   4  password inválida (política) ou confirmação diferente
 *   5  email já registado
 *   6  falha de base de dados
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";

/** Mesmo custo do login da aplicação — ver app/configuracoes/utilizadores/actions.ts. */
const BCRYPT_COST = 10;

/**
 * Mesma política mínima da aplicação (8 caracteres). Deliberadamente NÃO
 * é mais exigente: uma password aceite aqui mas recusada pela aplicação
 * criaria um administrador que não consegue entrar.
 */
const MIN_PASSWORD_LENGTH = 8;

/** Formato de email — o mesmo critério prático usado no resto do repo. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EXIT = {
  OK: 0,
  USAGE: 1,
  NO_CONTROL_URL: 2,
  ALREADY_SEEDED: 3,
  BAD_PASSWORD: 4,
  DUPLICATE_EMAIL: 5,
  DB_ERROR: 6,
  ABORTED: 7,
} as const;

/**
 * Descreve o destino da escrita a partir da connection string, SEM
 * credenciais. Devolve "host/base".
 *
 * Existe por uma razão concreta e já vivida: `import "dotenv/config"`
 * carrega o `.env` do repositório. Numa máquina de desenvolvimento esse
 * ficheiro aponta para o control plane de PRODUÇÃO. Correr este script
 * julgando que a variável não estava definida criava um administrador na
 * base errada — e um administrador criado por engano numa base de
 * produção é uma credencial que ninguém sabe que existe.
 *
 * Mostrar o destino e pedir confirmação transforma isso num erro
 * impossível de cometer sem reparar.
 */
function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, "") || "(sem base)";
    return `${u.hostname}/${db}`;
  } catch {
    return "(connection string ilegível)";
  }
}

/** Pergunta s/N no terminal. Qualquer coisa que não seja "s" aborta. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      stdin.removeListener("data", onData);
      stdin.pause();
      resolve(chunk.trim().toLowerCase().startsWith("s"));
    };
    stdin.on("data", onData);
  });
}

/**
 * Tudo o que é diálogo vai para o stderr, nunca para o stdout.
 *
 * Assim `... | jq` ou `... > relatorio.txt` continuam a funcionar, e o
 * prompt não acaba num ficheiro por acidente. O stdout leva só o
 * resultado final, que é auditável.
 */
function say(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ─────────────────────────────────────────────────────────────────────
// Leitura da password
// ─────────────────────────────────────────────────────────────────────

/**
 * Prompt sem eco. Lê carácter a carácter em raw mode e nunca escreve o
 * que foi digitado — nem sequer asteriscos, que revelam o comprimento.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r":
          case "\n":
            cleanup();
            process.stderr.write("\n");
            resolve(buffer);
            return;
          case "\u0003": // Ctrl-C
            cleanup();
            process.stderr.write("\n");
            reject(new Error("interrompido"));
            return;
          case "\u007f": // backspace
          case "\b":
            buffer = buffer.slice(0, -1);
            break;
          default:
            // Ignora sequências de controlo (setas, etc.).
            if (ch >= " ") buffer += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Lê o stdin todo. Usado quando não há terminal. */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

type PasswordInput = { password: string; confirmation: string };

async function readPassword(): Promise<PasswordInput> {
  if (process.stdin.isTTY) {
    const password = await promptHidden("Password do administrador: ");
    const confirmation = await promptHidden("Confirmar password:      ");
    return { password, confirmation };
  }

  // Sem terminal: duas linhas no stdin. A confirmação é exigida também
  // aqui — em automação, um erro de digitação num secret manager produz
  // exactamente o mesmo estrago.
  const raw = await readAllStdin();
  const lines = raw.split(/\r?\n/);
  return { password: lines[0] ?? "", confirmation: lines[1] ?? "" };
}

// ─────────────────────────────────────────────────────────────────────
// Validação
// ─────────────────────────────────────────────────────────────────────

function validatePassword(input: PasswordInput): string | null {
  if (input.password.length === 0) {
    return "password vazia.";
  }
  if (input.password !== input.confirmation) {
    return "a confirmação não coincide com a password.";
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return `password demasiado curta — mínimo ${MIN_PASSWORD_LENGTH} caracteres (mesma política da aplicação).`;
  }
  // `.length`, não `.trim().length`: uma password só de espaços é curta,
  // não é vazia — e quem a rejeita é a regra de comprimento mínimo, não
  // esta. Ver lib/password-policy.ts.
  if (input.password.length === 0) {
    return "password só com espaços.";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        email: { type: "string" },
        nome: { type: "string" },
        "allow-existing": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
  } catch (err) {
    say(`✗ ${err instanceof Error ? err.message : String(err)}`);
    say("  Uso: --email <email> --nome <nome> [--allow-existing]");
    return EXIT.USAGE;
  }
  const values = parsed.values;

  if (values.help) {
    say("Uso: npm run control:create-global-admin -- --email <email> --nome <nome> [--allow-existing] [--yes]");
    say("");
    say("A password é pedida em prompt oculto; sem terminal, é lida do stdin");
    say("em duas linhas (password e confirmação). NUNCA por argumento.");
    say("");
    say("O destino (host/base do control plane) é mostrado e tem de ser");
    say("confirmado. Sem terminal, --yes é obrigatório: `dotenv` carrega o");
    say(".env do repositório, e numa máquina de desenvolvimento esse ficheiro");
    say("aponta para produção.");
    return EXIT.OK;
  }

  // ── Argumentos ─────────────────────────────────────────────────────
  const emailRaw = (values.email ?? "").trim();
  const nome = (values.nome ?? "").trim();

  if (emailRaw === "") {
    say("✗ --email é obrigatório.");
    return EXIT.USAGE;
  }
  if (nome === "") {
    say("✗ --nome é obrigatório.");
    return EXIT.USAGE;
  }
  const email = emailRaw.toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    say(`✗ email inválido: ${email}`);
    return EXIT.USAGE;
  }

  // ── Ligação ────────────────────────────────────────────────────────
  // Verificado ANTES de pedir a password: fazer o operador escrevê-la
  // duas vezes para depois falhar por configuração é desrespeitoso e
  // convida a repetir o comando com a password no histórico.
  if (!process.env.CONTROL_DATABASE_URL || process.env.CONTROL_DATABASE_URL.trim() === "") {
    say("✗ CONTROL_DATABASE_URL em falta.");
    say("  Este script escreve APENAS no control plane e recusa-se a adivinhar a ligação.");
    say("  A base legacy (DATABASE_URL) nunca é usada aqui.");
    return EXIT.NO_CONTROL_URL;
  }

  // ── Confirmação do destino ─────────────────────────────────────────
  const target = describeTarget(process.env.CONTROL_DATABASE_URL);
  say("");
  say(`  Control plane : ${target}`);
  say(`  Administrador : ${email} (${nome})`);
  say("");

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      say("✗ sem terminal e sem --yes: recuso escrever num control plane que não foi confirmado.");
      say("  Confirma o destino acima e repete com --yes.");
      return EXIT.ABORTED;
    }
    const proceed = await confirm(`Criar o administrador em ${target}? [s/N] `);
    if (!proceed) {
      say("✗ abortado — nada foi escrito.");
      return EXIT.ABORTED;
    }
  }

  const prisma = getControlPrismaCli();

  // ── Estado actual ──────────────────────────────────────────────────
  let existing: number;
  try {
    existing = await prisma.globalAdmin.count();
  } catch (err) {
    say(`✗ não foi possível ler a tabela GlobalAdmin: ${err instanceof Error ? err.message : String(err)}`);
    say("  O control plane tem as migrations aplicadas? (npm run control:migrate:deploy)");
    return EXIT.DB_ERROR;
  }

  if (existing > 0 && !values["allow-existing"]) {
    say(`✗ já existem ${existing} administrador(es) global(is).`);
    say("  Este script serve para criar o PRIMEIRO. Para acrescentar outro,");
    say("  é preciso pedi-lo de forma explícita:  --allow-existing");
    say("  Para repor uma password, NÃO é aqui — este script nunca altera credenciais existentes.");
    return EXIT.ALREADY_SEEDED;
  }

  // Email duplicado detectado antes de pedir a password, pela mesma razão.
  try {
    const clash = await prisma.globalAdmin.findUnique({ where: { email }, select: { id: true } });
    if (clash) {
      say(`✗ já existe um administrador global com o email ${email}.`);
      say("  Este script nunca redefine credenciais de um administrador existente.");
      return EXIT.DUPLICATE_EMAIL;
    }
  } catch (err) {
    say(`✗ falha ao verificar o email: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.DB_ERROR;
  }

  // ── Password ───────────────────────────────────────────────────────
  say(`A criar administrador global: ${email} (${nome})`);
  let input: PasswordInput;
  try {
    input = await readPassword();
  } catch (err) {
    say(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.BAD_PASSWORD;
  }

  const problem = validatePassword(input);
  if (problem) {
    say(`✗ ${problem}`);
    return EXIT.BAD_PASSWORD;
  }

  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  } finally {
    // As strings em JavaScript são imutáveis: não há forma de as apagar
    // da memória. O que se pode fazer — e faz-se — é largar as
    // referências assim que deixam de ser precisas, para que o GC as
    // possa recolher e para que nenhuma delas chegue a um log, a um
    // relatório de erro ou a um core dump por descuido.
    input = { password: "", confirmation: "" };
  }

  // ── Escrita ────────────────────────────────────────────────────────
  // Transação com nova contagem lá dentro: entre a verificação acima e
  // este insert pode ter corrido outra instância deste script. Sem esta
  // segunda leitura, duas execuções em paralelo criavam dois "primeiros"
  // administradores.
  let created: { id: string; email: string; nome: string; createdAt: Date };
  try {
    created = await prisma.$transaction(async (tx) => {
      if (!values["allow-existing"]) {
        const n = await tx.globalAdmin.count();
        if (n > 0) {
          throw Object.assign(new Error("ALREADY_SEEDED"), { code: "ALREADY_SEEDED" });
        }
      }
      return tx.globalAdmin.create({
        data: { email, nome, passwordHash, estado: "ACTIVE" },
        select: { id: true, email: true, nome: true, createdAt: true },
      });
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ALREADY_SEEDED") {
      say("✗ outro administrador foi criado entretanto — nada foi escrito.");
      return EXIT.ALREADY_SEEDED;
    }
    if (code === "P2002") {
      say(`✗ já existe um administrador global com o email ${email}.`);
      return EXIT.DUPLICATE_EMAIL;
    }
    say(`✗ falha ao criar o administrador: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.DB_ERROR;
  }

  // ── Auditoria ──────────────────────────────────────────────────────
  // Id, email, nome e timestamp. Nada mais: nem password, nem hash, nem
  // sequer o comprimento de nenhum dos dois.
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      id: created.id,
      email: created.email,
      nome: created.nome,
      estado: "ACTIVE",
      createdAt: created.createdAt.toISOString(),
    })}\n`,
  );
  say("");
  say(`✓ administrador global criado: ${created.email} (id ${created.id})`);
  say("  Guarda a password num gestor de passwords AGORA — não é recuperável.");
  return EXIT.OK;
}

/**
 * Fecha a ligação SE alguma tiver sido aberta.
 *
 * `getControlPrismaCli()` CONSTRÓI o cliente e atira quando
 * CONTROL_DATABASE_URL não está definida. Chamá-lo no handler de saída
 * fazia o processo rebentar depois de já ter decidido o código de saída
 * correcto: o script imprimia "CONTROL_DATABASE_URL em falta", devolvia
 * 2, e o Node terminava com 1 e um stack trace por cima.
 */
async function disconnectQuietly(): Promise<void> {
  try {
    if (!process.env.CONTROL_DATABASE_URL) return;
    await getControlPrismaCli().$disconnect();
  } catch {
    // Fechar uma ligação nunca pode mudar o resultado do comando.
  }
}

main()
  .then(async (code) => {
    await disconnectQuietly();
    process.exit(code);
  })
  .catch(async (err) => {
    // Rede de segurança: uma excepção inesperada não pode arrastar a
    // password para o stderr através de um stack trace.
    say(`✗ erro inesperado: ${err instanceof Error ? err.message : "desconhecido"}`);
    await disconnectQuietly();
    process.exit(EXIT.DB_ERROR);
  });
