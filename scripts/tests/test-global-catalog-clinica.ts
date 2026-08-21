/**
 * scripts/tests/test-global-catalog-clinica.ts
 *
 * Fixa as regras da CLÍNICA no catálogo global.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE ESTAS ASSERÇÕES PROTEGEM
 *
 * A clínica tem um perfil de risco diferente do da taxonomia. Uma
 * categoria errada põe o produto na prateleira errada e vê-se ao balcão.
 * Um ATC errado no catálogo NACIONAL atribui a um medicamento uma
 * substância que ele não tem, e chega a todas as farmácias ao mesmo
 * tempo, sem ninguém o ter pedido.
 *
 * Três coisas têm de continuar verdadeiras, e é isto que aqui se fixa:
 *
 *  1. INDEPENDÊNCIA. A clínica não passa pelo gate da classificação. Um
 *     produto com a taxonomia global já imbatível continua a poder subir
 *     o ATC que o global não tem. Foi este o defeito que motivou tudo:
 *     depois da promoção de 2026-08-21, os 1 318 produtos passaram a ser
 *     recusados por "igual ou melhor", e com um gate único isso fechava
 *     a porta a 1 124 ATC para sempre.
 *
 *  2. NÃO-DEGRADAÇÃO. O modelo nunca substitui o INFARMED nem uma
 *     pessoa. Um valor ausente nunca apaga um valor presente.
 *
 *  3. IDEMPOTÊNCIA. Correr duas vezes seguidas não escreve na segunda.
 *     Sem isto, cada passagem do scheduler reescrevia o catálogo
 *     nacional inteiro e o rasto de auditoria deixava de servir para
 *     alguma coisa.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-global-catalog-clinica.ts
 */
import {
  MARGEM_CONFIANCA_CLINICA,
  PRECEDENCIA_CLINICA,
  avaliarClinica,
  avaliarPromocao,
  origemDaClinica,
  origemDaPromocao,
  validarValorClinico,
  type CampoClinico,
  type ClinicaCandidata,
  type ClinicaGlobal,
  type ConhecimentoCandidato,
  type ConhecimentoGlobal,
  type OrigemGlobal,
} from "../../lib/catalog/global-catalog";

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

const cand = (over: Partial<ClinicaCandidata> = {}): ClinicaCandidata => ({
  campo: "CODIGO_ATC",
  valor: "N02BE01",
  origem: "MODELO",
  confianca: 0.95,
  versaoRegras: "ke-2.0",
  motivoOrigem: "decisão do modelo sobre este cnp",
  ...over,
});

const glob = (over: Partial<ClinicaGlobal> = {}): ClinicaGlobal => ({
  campo: "CODIGO_ATC",
  valor: "N02BE01",
  origem: "MODELO",
  confianca: 0.95,
  versaoRegras: "ke-2.0",
  ...over,
});

const mapa = (...gs: ClinicaGlobal[]) =>
  new Map<CampoClinico, ClinicaGlobal>(gs.map((g) => [g.campo, g]));

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== validação estrutural: o ATC é tudo-ou-nada ===");
{
  check(validarValorClinico("CODIGO_ATC", "N02BE01") === "N02BE01", "ATC completo passa");
  check(validarValorClinico("CODIGO_ATC", " n02be01 ") === "N02BE01", "…normaliza espaços e caixa");
  check(validarValorClinico("CODIGO_ATC", "N02") === null, "N02 NÃO passa — grupo anatómico não é substância");
  check(validarValorClinico("CODIGO_ATC", "N02BE0") === null, "seis caracteres não passam");
  check(validarValorClinico("CODIGO_ATC", "N02BE011") === null, "oito caracteres não passam");
  check(validarValorClinico("CODIGO_ATC", "I02BE01") === null, "letra que não é grupo anatómico não passa");
  check(validarValorClinico("CODIGO_ATC", "") === null, "vazio não passa");
  check(validarValorClinico("CODIGO_ATC", null) === null, "null não passa");
}

console.log("\n=== validação estrutural: a DCI não é uma frase ===");
{
  check(validarValorClinico("DCI", "Paracetamol") === "Paracetamol", "substância simples passa");
  check(
    validarValorClinico("DCI", "Perindopril arginina + Indapamida") === "Perindopril arginina + Indapamida",
    "combinação com + passa",
  );
  const frase = "associação de paracetamol com cafeína indicada para o alívio sintomático de dores ligeiras";
  check(validarValorClinico("DCI", frase) === null, "frase longa NÃO passa (e não é truncada para passar)");
  check(validarValorClinico("DCI", "9 mg") === null, "começar por dígito não passa");
}

console.log("\n=== validação estrutural: forma/dosagem/embalagem ===");
{
  check(validarValorClinico("FORMA_FARMACEUTICA", "cáps lib prol") === "cáps lib prol", "forma livre passa");
  check(validarValorClinico("DOSAGEM", "12,5 mg/5 ml") === "12,5 mg/5 ml", "dosagem com vírgula e barra passa");
  check(validarValorClinico("EMBALAGEM", "x 60") === "x 60", "embalagem curta passa");
  check(validarValorClinico("DOSAGEM", "a".repeat(81)) === null, "acima de 80 caracteres não passa");
  check(validarValorClinico("FORMA_FARMACEUTICA", "   ") === null, "só espaços não passa");
}

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== não-degradação: precedência das origens ===");
{
  const ordem: OrigemGlobal[] = ["HUMANO", "REGULATORY", "DETERMINISTICA", "MODELO", "PROPAGADO"];
  let monotona = true;
  for (let i = 1; i < ordem.length; i++) {
    if (PRECEDENCIA_CLINICA[ordem[i]!] <= PRECEDENCIA_CLINICA[ordem[i - 1]!]) monotona = false;
  }
  check(monotona, "HUMANO < REGULATORY < DETERMINISTICA < MODELO < PROPAGADO");

  // O caso que motivou tudo: o INFARMED a chegar depois do modelo.
  const dInfarmed = avaliarClinica(
    [cand({ valor: "C09BA04", origem: "REGULATORY", confianca: 0.9 })],
    mapa(glob({ valor: "N02BE01", origem: "MODELO", confianca: 0.99 })),
  );
  check(dInfarmed.promover.length === 1, "REGULATORY substitui MODELO mesmo com confiança MENOR");

  const dModelo = avaliarClinica(
    [cand({ valor: "N02BE01", origem: "MODELO", confianca: 0.99 })],
    mapa(glob({ valor: "C09BA04", origem: "REGULATORY", confianca: 0.5 })),
  );
  check(dModelo.promover.length === 0, "MODELO NÃO substitui REGULATORY, por muito confiante que esteja");
  check(
    dModelo.recusadas[0]?.motivo.includes("menos autoritaria"),
    "…e o motivo diz que a origem é menos autoritária",
  );

  const dHumano = avaliarClinica(
    [cand({ valor: "N02BE01", origem: "MODELO", confianca: 1 })],
    mapa(glob({ valor: "C09BA04", origem: "HUMANO", confianca: 0 })),
  );
  check(dHumano.promover.length === 0, "MODELO NÃO substitui HUMANO nem com confiança 1 contra 0");

  const dPropagado = avaliarClinica(
    [cand({ origem: "PROPAGADO", valor: "C09BA04" })],
    mapa(glob({ origem: "MODELO", valor: "N02BE01" })),
  );
  check(dPropagado.promover.length === 0, "PROPAGADO (irmão) não substitui MODELO (este cnp)");
}

console.log("\n=== não-degradação: lacunas, e só lacunas ===");
{
  const vazio = avaliarClinica([cand()], mapa());
  check(vazio.promover.length === 1, "o global não sabe nada → preenche");

  const jaLa = avaliarClinica([cand()], mapa(glob()));
  check(jaLa.promover.length === 0, "mesmo valor, mesma origem → não escreve");
  check(jaLa.recusadas[0]?.motivo === "o global ja tem este valor", "…e diz porquê");

  // Um valor ausente não pode apagar. Estruturalmente: quem monta a
  // lista não cria candidato para um campo sem valor, portanto um campo
  // ausente nunca aparece nas recusas nem nas promoções.
  const semCandidato = avaliarClinica([], mapa(glob()));
  check(
    semCandidato.promover.length === 0 && semCandidato.recusadas.length === 0,
    "campo ausente não gera decisão nenhuma — não apaga o que lá está",
  );

  const invalido = avaliarClinica([cand({ valor: "N02" })], mapa(glob()));
  check(invalido.promover.length === 0, "valor inválido não substitui um válido");
  check(invalido.recusadas.length === 1, "…e é contado como recusa, não ignorado em silêncio");
}

console.log("\n=== não-degradação: a margem de confiança ===");
{
  const semMargem = avaliarClinica(
    [cand({ valor: "C09BA04", confianca: 0.96 })],
    mapa(glob({ valor: "N02BE01", confianca: 0.95 })),
  );
  check(semMargem.promover.length === 0, "mesma origem e +0.01 NÃO chega para trocar o valor");

  const comMargem = avaliarClinica(
    [cand({ valor: "C09BA04", confianca: 0.95 + MARGEM_CONFIANCA_CLINICA })],
    mapa(glob({ valor: "N02BE01", confianca: 0.95 })),
  );
  check(comMargem.promover.length === 1, `mesma origem e +${MARGEM_CONFIANCA_CLINICA} troca`);
}

console.log("\n=== aprovação humana: a clínica segue a mesma guarda ===");
{
  const sem = avaliarClinica([cand({ origem: "HUMANO" })], mapa());
  check(sem.promover.length === 0, "clínica de origem HUMANO não sobe sozinha");
  check(sem.recusadas[0]?.aguardaAprovacao === true, "…e fica marcada como à espera de alguém");

  const com = avaliarClinica([cand({ origem: "HUMANO" })], mapa(), {
    aprovacao: { aprovador: "Bruno Reis", motivo: "revisão do catálogo" },
  });
  check(com.promover.length === 1, "com aprovação explícita, sobe");
}

console.log("\n=== origem por mapear não sobe ===");
{
  const d = avaliarClinica([cand({ origem: null, motivoOrigem: "sem fonte conhecida" })], mapa());
  check(d.promover.length === 0, "origem null não sobe");
  check(d.recusadas[0]?.motivo === "sem fonte conhecida", "…e o motivo é o que a atribuição deu");
}

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== atribuição da origem: por igualdade de valor, nunca por defeito ===");
{
  const base = {
    valorProduto: "N02BE01",
    validadoManualmente: false,
    valorRegulatorio: null as string | null,
    valorCache: null as string | null,
    cacheOrigem: null as string | null,
  };

  check(
    origemDaClinica({ ...base, validadoManualmente: true }).origem === "HUMANO",
    "produto validado à mão → HUMANO",
  );
  check(
    origemDaClinica({ ...base, valorRegulatorio: "N02BE01" }).origem === "REGULATORY",
    "valor igual ao RegulatoryRecord → REGULATORY",
  );
  check(
    origemDaClinica({ ...base, valorRegulatorio: "C09BA04" }).origem === null,
    "RegulatoryRecord com valor DIFERENTE não carimba REGULATORY",
  );
  check(
    origemDaClinica({ ...base, valorCache: "N02BE01", cacheOrigem: "CLAUDE" }).origem === "MODELO",
    "valor igual à cache CLAUDE → MODELO",
  );
  check(
    origemDaClinica({ ...base, valorCache: "N02BE01", cacheOrigem: "PROPAGADO" }).origem === "PROPAGADO",
    "valor igual à cache PROPAGADO → PROPAGADO",
  );
  check(
    origemDaClinica({ ...base, valorCache: "N02BE01", cacheOrigem: "CATALOGO_GLOBAL" }).origem === null,
    "veio do catálogo global → NÃO se repromove (sem ciclo de lavagem)",
  );
  check(
    origemDaClinica({ ...base }).origem === null,
    "sem fonte que explique o valor → null, e não um default",
  );
  check(
    origemDaClinica({ ...base, valorCache: "C09BA04", cacheOrigem: "CLAUDE" }).origem === null,
    "cache com valor DIFERENTE não reclama o campo",
  );
  check(
    origemDaClinica({ ...base, valorProduto: " n02be01 ", valorCache: "N02BE01", cacheOrigem: "CLAUDE" }).origem === "MODELO",
    "a igualdade ignora espaços e caixa",
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== INDEPENDÊNCIA: a clínica não passa pelo gate da classificação ===");
{
  const c: ConhecimentoCandidato = {
    cnp: 2134492,
    designacaoReferencia: "VOLTAREN RAPID COMP REV 50 MG X 10",
    productType: "MEDICAMENTO",
    categoria: "MEDICAMENTOS",
    subcategoria: "Analgésicos e Anti-inflamatórios",
    utilizacoes: [],
    confidence: 0.95,
    evidenceType: "TEXT_PATTERN",
    origem: "DETERMINISTICA",
    motivoOrigem: "regras determinísticas",
    fonteOriginal: "TEXT_PATTERN",
    versaoRegras: "ke-2.0",
    verificado: false,
    tenantOrigem: "silveira",
    clinica: [cand({ campo: "CODIGO_ATC", valor: "M01AB05" }), cand({ campo: "DCI", valor: "Diclofenac" })],
  };

  // O estado exacto de depois da promoção de 2026-08-21: taxonomia já
  // no global, com a mesma origem e a mesma confiança — logo recusada — e
  // clínica global vazia.
  const g: ConhecimentoGlobal = {
    cnp: 2134492,
    categoria: "MEDICAMENTOS",
    subcategoria: "Analgésicos e Anti-inflamatórios",
    productType: "MEDICAMENTO",
    confidence: 0.95,
    origem: "DETERMINISTICA",
    versaoRegras: "ke-1.1",
    verificado: false,
    utilizacoes: [],
    clinica: mapa(),
  };

  const d = avaliarPromocao(c, g);
  check(!d.classificacao.promover, "a classificação é recusada — o global já tem igual ou melhor");
  check(
    d.classificacao.motivo === "o global já tem conhecimento igual ou melhor",
    "…exactamente com esse motivo",
  );
  check(d.clinica.promover.length === 2, "…E MESMO ASSIM o ATC e a DCI sobem");
  check(d.promover === true, "…e o produto conta como promovido");
  check(
    origemDaPromocao(c, d) === "MODELO",
    "a origem do registo vem da clínica quando só a clínica sobe",
  );
}

console.log("\n=== …e o inverso: sem clínica, nada muda no comportamento antigo ===");
{
  const c: ConhecimentoCandidato = {
    clinica: [],
    cnp: 1, designacaoReferencia: "x", productType: null,
    categoria: "MEDICAMENTOS", subcategoria: "Analgésicos e Anti-inflamatórios",
    utilizacoes: [], confidence: 0.95, evidenceType: null,
    origem: "DETERMINISTICA", motivoOrigem: "", fonteOriginal: null,
    versaoRegras: "ke-2.0", verificado: false, tenantOrigem: "silveira",
  };
  const g: ConhecimentoGlobal = {
    cnp: 1, categoria: "MEDICAMENTOS", subcategoria: "Analgésicos e Anti-inflamatórios",
    productType: null, confidence: 0.95, origem: "DETERMINISTICA",
    versaoRegras: "ke-1.1", verificado: false, utilizacoes: [],
  };
  const d = avaliarPromocao(c, g);
  check(d.promover === false, "candidato sem clínica e com taxonomia recusada não promove nada");
  check(d.clinica.promover.length === 0 && d.clinica.recusadas.length === 0, "…e a parte clínica fica vazia");
  check(origemDaPromocao(c, d) === null, "…e não há origem de promoção");
}

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== IDEMPOTÊNCIA: a segunda passagem não escreve ===");
{
  // Simula o ciclo real: promove-se, o global fica com o que subiu, e
  // volta a correr-se com o MESMO candidato.
  const candidatos = [
    cand({ campo: "CODIGO_ATC", valor: "M01AB05" }),
    cand({ campo: "DCI", valor: "Diclofenac" }),
    cand({ campo: "FORMA_FARMACEUTICA", valor: "comp revest" }),
  ];

  const primeira = avaliarClinica(candidatos, mapa());
  check(primeira.promover.length === 3, "primeira passagem promove os três campos");

  const globalDepois = mapa(
    ...primeira.promover.map((p) =>
      glob({ campo: p.campo, valor: p.valor, origem: p.origem!, confianca: p.confianca }),
    ),
  );

  const segunda = avaliarClinica(candidatos, globalDepois);
  check(segunda.promover.length === 0, "segunda passagem promove ZERO");
  check(segunda.recusadas.length === 3, "…e recusa os três");
  check(
    segunda.recusadas.every((r) => r.motivo === "o global ja tem este valor"),
    "…todos pelo mesmo motivo: já lá está",
  );

  const terceira = avaliarClinica(candidatos, globalDepois);
  check(terceira.promover.length === 0, "terceira passagem também promove zero (estável, não alternante)");
}

console.log("\n=== IDEMPOTÊNCIA: sem duplicação por campo ===");
{
  // A chave é (cnp, campo). Dois candidatos para o MESMO campo na mesma
  // lista são um erro de quem monta, mas não podem produzir duas
  // escritas conflituantes sem que se veja.
  const d = avaliarClinica(
    [cand({ campo: "DCI", valor: "Paracetamol" }), cand({ campo: "DCI", valor: "Ibuprofeno" })],
    mapa(),
  );
  check(
    d.promover.length + d.recusadas.length === 2,
    "os dois são avaliados — nenhum desaparece em silêncio",
  );
  check(
    d.promover.filter((p) => p.campo === "DCI").length <= 2,
    "…e o segundo é decidido contra o mesmo estado global, não contra o primeiro",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
