/**
 * scripts/tests/test-falha-infraestrutura.ts
 *
 * Fixa a fronteira entre "o produto falhou" e "a conta falhou".
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE ACONTECE SE ISTO SE PERDER
 *
 * A fila conta tentativas POR PRODUTO, com tecto de cinco e backoff
 * exponencial. A contagem existe para impedir que um produto que o
 * modelo nunca vai conseguir classificar gere chamadas para sempre.
 *
 * Quando o que falha é a conta — chave ausente, saldo esgotado, serviço
 * em baixo — nada disso diz respeito ao produto. Se essas falhas
 * contarem como tentativas, uma noite sem saldo queima as cinco
 * tentativas de milhares de produtos que nunca chegaram a ser
 * perguntados, e no dia seguinte, com saldo, eles já não voltam à fila.
 * O pipeline dá-se por concluído tendo processado zero, e ninguém tem
 * como saber que não processou.
 *
 * Em 2026-08-21 a corrida morreu com «Your credit balance is too low».
 * A fila safou-se porque a excepção derrubou o processo ANTES de ela ser
 * fechada — por acidente, não por desenho. É esse acidente que estas
 * asserções substituem por uma regra.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-falha-infraestrutura.ts
 */
import {
  FalhaInfraestrutura,
  classificarFalhaInfra,
  credencialConfigurada,
} from "../../lib/catalog/knowledge-enrichment";
import { runKnowledgeEnrichment } from "../../lib/catalog/knowledge-enrichment-runner";

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

/** Erro com `status`, como o SDK do Anthropic os lança. */
const erroApi = (status: number, message: string) => Object.assign(new Error(message), { status });

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== o saldo esgotado é INFRAESTRUTURA, apesar do HTTP 400 ===");
{
  // A mensagem exacta que matou a corrida de 2026-08-21.
  const real = erroApi(
    400,
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  );
  const f = classificarFalhaInfra(real);
  check(f !== null, "o erro real de saldo é classificado como infraestrutura");
  check(f?.categoria === "SALDO", "…com a categoria SALDO", f?.categoria);
}

console.log("\n=== um 400 NORMAL continua a ser do produto ===");
{
  // Este é o ponto delicado: 400 é, por regra, culpa de quem pergunta.
  // Classificar TODOS os 400 como infraestrutura era a saída fácil e
  // deixava um lote com esquema inválido a repetir-se para sempre sem
  // nunca gastar tentativa.
  const esquema = erroApi(400, "messages.0.content: Input should be a valid list");
  check(classificarFalhaInfra(esquema) === null, "400 de esquema NÃO é infraestrutura — conta tentativa");

  const naoEncontrado = erroApi(404, "model not found");
  check(classificarFalhaInfra(naoEncontrado) === null, "404 não é infraestrutura");

  const semStatus = new Error("resposta do modelo não validou contra o esquema");
  check(classificarFalhaInfra(semStatus) === null, "erro de validação sem status não é infraestrutura");
}

console.log("\n=== credencial: ausente e recusada são ambas infraestrutura ===");
{
  const semChave = new Error("The ANTHROPIC_API_KEY environment variable is missing or empty");
  const f1 = classificarFalhaInfra(semChave);
  check(f1?.categoria === "CREDENCIAL_AUSENTE", "chave em falta → CREDENCIAL_AUSENTE", f1?.categoria);

  const f2 = classificarFalhaInfra(erroApi(401, "authentication_error"));
  check(f2?.categoria === "AUTENTICACAO", "401 → AUTENTICACAO", f2?.categoria);

  const f3 = classificarFalhaInfra(erroApi(403, "permission denied"));
  check(f3?.categoria === "AUTENTICACAO", "403 → AUTENTICACAO", f3?.categoria);
}

console.log("\n=== rate limit e serviço em baixo são infraestrutura ===");
{
  check(classificarFalhaInfra(erroApi(429, "rate_limit_error"))?.categoria === "RATE_LIMIT", "429 → RATE_LIMIT");
  check(
    classificarFalhaInfra(erroApi(529, "overloaded_error"))?.categoria === "SERVICO_INDISPONIVEL",
    "529 → SERVICO_INDISPONIVEL",
  );
  check(
    classificarFalhaInfra(erroApi(500, "internal error"))?.categoria === "SERVICO_INDISPONIVEL",
    "500 → SERVICO_INDISPONIVEL",
  );
  check(
    classificarFalhaInfra(erroApi(503, "service unavailable"))?.categoria === "SERVICO_INDISPONIVEL",
    "503 → SERVICO_INDISPONIVEL",
  );
}

console.log("\n=== uma FalhaInfraestrutura atravessa a classificação intacta ===");
{
  const original = new FalhaInfraestrutura("SALDO", "saldo insuficiente");
  const f = classificarFalhaInfra(original);
  check(f === original, "reclassificar não embrulha nem perde a original");
}

console.log("\n=== a credencial é detectada nas duas variáveis que o SDK aceita ===");
{
  const antes = {
    key: process.env.ANTHROPIC_API_KEY,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    check(credencialConfigurada() === false, "sem nenhuma das duas → false");

    process.env.ANTHROPIC_API_KEY = "   ";
    check(credencialConfigurada() === false, "só espaços não conta como credencial");

    process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
    check(credencialConfigurada() === true, "ANTHROPIC_API_KEY conta");

    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = "token-teste";
    check(credencialConfigurada() === true, "ANTHROPIC_AUTH_TOKEN também conta");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    if (antes.key !== undefined) process.env.ANTHROPIC_API_KEY = antes.key;
    if (antes.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = antes.token;
  }
}

// Assíncrono, e por isso numa função: o `tsx` compila estes scripts para
// CJS, onde `await` de topo não existe.
async function testeRunnerSemCredencial(): Promise<void> {
  console.log("\n=== o runner recusa arrancar sem credencial, ANTES de tocar na fila ===");
  const antes = {
    key: process.env.ANTHROPIC_API_KEY,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  // Um Prisma que grita se alguém lhe tocar. Se o preflight falhar em
  // parar a tempo, é aqui que se vê — e é exactamente o que interessa
  // provar: a fila não pode ser tocada.
  const toques: string[] = [];
  const explode = () => {
    toques.push("tocou na base");
    throw new Error("o preflight devia ter parado antes de tocar na base");
  };
  const prismaGritante = new Proxy({}, {
    get: () => new Proxy(() => {}, { get: () => explode, apply: explode }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  let erro: unknown = null;
  try {
    await runKnowledgeEnrichment(prismaGritante, { dryRun: false, usarGlobal: false });
  } catch (e) {
    erro = e;
  } finally {
    if (antes.key !== undefined) process.env.ANTHROPIC_API_KEY = antes.key;
    if (antes.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = antes.token;
  }

  check(erro instanceof FalhaInfraestrutura, "lança FalhaInfraestrutura, e não um erro genérico");
  check(
    (erro as FalhaInfraestrutura | null)?.categoria === "CREDENCIAL_AUSENTE",
    "…com categoria CREDENCIAL_AUSENTE",
  );
  check(
    String((erro as Error | null)?.message ?? "").includes("fila NÃO foi tocada"),
    "…e a mensagem diz que a fila não foi tocada",
  );
  check(toques.length === 0, "e de facto NÃO tocou na base de dados", toques.join(" | "));
}

void testeRunnerSemCredencial().then(() => {
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
});
