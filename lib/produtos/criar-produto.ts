/**
 * lib/produtos/criar-produto.ts
 *
 * As regras de uma ficha de produto criada à mão.
 *
 * ── Porque é um módulo puro ──────────────────────────────────────────
 *
 * Validação de identidade de produto é a coisa mais fácil de duplicar:
 * um pouco no formulário, um pouco na acção do servidor, e as duas
 * cópias a divergir no dia em que uma regra muda. Aqui não há Prisma,
 * não há React, não há `server-only` — o formulário e o servidor
 * chamam a MESMA função e o teste exercita-a sem montar nada.
 *
 * A separação que interessa: este módulo decide o que é uma ficha
 * VÁLIDA. Não decide se o produto já existe — isso exige a base de
 * dados e vive em `resolver-lista-codigos`/na acção.
 */
import { MIN_CNP_CATALOGAVEL } from "@/lib/catalog/cnp-catalogavel";

/** Onde a criação foi iniciada. Vai para a auditoria. */
export type ContextoCriacao = "STOCK" | "ENCOMENDA";

export const CONTEXTOS_CRIACAO: readonly ContextoCriacao[] = ["STOCK", "ENCOMENDA"];

/**
 * Os campos que uma ficha manual pode trazer.
 *
 * TODOS pertencem a `Produto` — o catálogo do tenant. Nenhum pertence a
 * `ProdutoFarmacia`, e a omissão é deliberada: stock, PMC, PUC, PVP da
 * farmácia, última venda e validade são observações de uma farmácia
 * concreta sobre um artigo concreto. Inventá-los num formulário seria
 * escrever dados operacionais que ninguém observou.
 *
 * Uma ficha manual sem farmácia nenhuma tem esses campos simplesmente
 * ausentes — que é a verdade, e é o que os ecrãs mostram.
 */
export type FichaManual = {
  /** Obrigatório. Chave canónica do catálogo. */
  cnp: number;
  /** Obrigatória. É o mínimo para alguém reconhecer o artigo. */
  designacao: string;
  dci?: string | null;
  codigoATC?: string | null;
  dosagem?: string | null;
  formaFarmaceutica?: string | null;
  embalagem?: string | null;
  /** Nome do fabricante/titular. Resolvido para `fabricanteId` no servidor. */
  fabricante?: string | null;
  /** Nome da categoria canónica (nível 1). Resolvido no servidor. */
  categoria?: string | null;
  /** Nome da subcategoria canónica (nível 2). Resolvido no servidor. */
  subcategoria?: string | null;
  grupoHomogeneo?: string | null;
  flagGenerico?: boolean;
};

export type ErroValidacao = {
  campo: keyof FichaManual | "geral";
  mensagem: string;
};

/** Comprimento máximo dos campos de texto livre. */
const MAX_TEXTO = 300;

/**
 * O ATC tem uma forma, e vale a pena exigi-la.
 *
 * Cinco níveis da OMS: 1 letra, 2 dígitos, 1 letra, 1 letra, 2 dígitos —
 * `A10BX16`. Um código parcial é legítimo (alguém pode saber só `A10B`),
 * por isso aceitam-se os prefixos válidos. O que não se aceita é texto
 * livre: um `codigoATC` com a designação lá dentro estraga qualquer
 * filtro hierárquico por prefixo, e é o tipo de lixo que só se descobre
 * meses depois.
 *
 * Medido na produção: os 4 456 ATC existentes têm TODOS 7 caracteres.
 */
const ATC = /^[A-Z](\d{2}([A-Z]([A-Z](\d{2})?)?)?)?$/;

export function normalizarAtc(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return s.length > 0 ? s : null;
}

/** Aparado, colapsado, ou `null` quando fica vazio. */
export function texto(v: string | null | undefined): string | null {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

/**
 * A ficha é criável?
 *
 * Devolve TODOS os erros, não o primeiro: um formulário que corrige um
 * erro de cada vez obriga a três submissões para três campos.
 */
export function validarFichaManual(f: FichaManual): ErroValidacao[] {
  const erros: ErroValidacao[] = [];

  // ── CNP ───────────────────────────────────────────────────────────
  if (!Number.isInteger(f.cnp) || f.cnp <= 0) {
    erros.push({ campo: "cnp", mensagem: "CNP em falta ou inválido." });
  } else if (f.cnp <= MIN_CNP_CATALOGAVEL) {
    // A fronteira de `lib/catalog/cnp-catalogavel.ts`. Abaixo dela estão
    // taxas, serviços e atos clínicos do ERP — códigos que só existem
    // dentro de UMA instalação Softreis.
    //
    // Criar uma ficha central com um código local seria criar um produto
    // que nenhuma outra farmácia reconhece, que o enriquecimento recusa
    // (`ehCnpCatalogavel` devolve false) e que nunca cruzará com fonte
    // regulamentar nenhuma. Recusar é mais honesto do que deixar nascer
    // uma ficha inerte.
    erros.push({
      campo: "cnp",
      mensagem:
        `CNP ${f.cnp} está abaixo de ${MIN_CNP_CATALOGAVEL.toLocaleString("pt-PT")} — ` +
        "é um código interno do ERP (taxa, serviço, ato clínico) e não um produto de catálogo.",
    });
  } else if (String(f.cnp).length > 12) {
    erros.push({ campo: "cnp", mensagem: "CNP demasiado longo." });
  }

  // ── Designação ────────────────────────────────────────────────────
  const d = texto(f.designacao);
  if (d === null) {
    erros.push({ campo: "designacao", mensagem: "Designação obrigatória." });
  } else if (d.length < 3) {
    erros.push({ campo: "designacao", mensagem: "Designação demasiado curta." });
  } else if (d.length > MAX_TEXTO) {
    erros.push({ campo: "designacao", mensagem: `Designação acima de ${MAX_TEXTO} caracteres.` });
  }

  // ── ATC ───────────────────────────────────────────────────────────
  const atc = normalizarAtc(f.codigoATC);
  if (atc !== null && !ATC.test(atc)) {
    erros.push({
      campo: "codigoATC",
      mensagem: "Código ATC inválido. Formato: A, A10, A10B, A10BX ou A10BX16.",
    });
  }

  // ── Restantes textos ──────────────────────────────────────────────
  for (const campo of [
    "dci",
    "dosagem",
    "formaFarmaceutica",
    "embalagem",
    "fabricante",
    "categoria",
    "subcategoria",
    "grupoHomogeneo",
  ] as const) {
    const v = texto(f[campo] as string | null | undefined);
    if (v !== null && v.length > MAX_TEXTO) {
      erros.push({ campo, mensagem: `Acima de ${MAX_TEXTO} caracteres.` });
    }
  }

  return erros;
}

/**
 * Os campos que o utilizador preencheu — a lista que vai para
 * `Produto.camposManuais` e que o ERP passa a não poder sobrepor.
 *
 * SÓ os preenchidos. Um campo deixado em branco não é uma decisão de
 * que o campo deva ficar vazio: é a ausência de informação, e bloquear
 * o ERP sobre ele impediria o produto de ser enriquecido para sempre —
 * exactamente o contrário do que a ficha manual serve.
 *
 * Devolve apenas os campos que o ERP REALMENTE escreve. `dci`,
 * `codigoATC`, `dosagem` e os restantes nunca são tocados pela
 * ingestão; marcá-los seria ruído a fingir protecção, e sugeriria uma
 * ameaça que não existe. Ver `bulkUpsertProdutosByCnp`.
 */
export function camposManuaisDe(f: FichaManual): string[] {
  const out: string[] = [];
  if (texto(f.designacao) !== null) out.push("designacao");
  if (f.flagGenerico === true) out.push("flagGenerico");
  return out;
}

/** A ficha normalizada, pronta a escrever. */
export type FichaNormalizada = {
  cnp: number;
  designacao: string;
  dci: string | null;
  codigoATC: string | null;
  dosagem: string | null;
  formaFarmaceutica: string | null;
  embalagem: string | null;
  fabricante: string | null;
  categoria: string | null;
  subcategoria: string | null;
  grupoHomogeneo: string | null;
  flagGenerico: boolean;
  camposManuais: string[];
};

/**
 * Normaliza. ATIRA se a ficha for inválida — quem chama valida primeiro
 * e mostra os erros; chegar aqui com ficha inválida é erro de programa,
 * não de utilizador.
 */
export function normalizarFichaManual(f: FichaManual): FichaNormalizada {
  const erros = validarFichaManual(f);
  if (erros.length > 0) {
    throw new Error(
      `[criar-produto] ficha inválida: ${erros.map((e) => `${e.campo}: ${e.mensagem}`).join("; ")}`,
    );
  }
  return {
    cnp: f.cnp,
    designacao: texto(f.designacao)!,
    dci: texto(f.dci),
    codigoATC: normalizarAtc(f.codigoATC),
    dosagem: texto(f.dosagem),
    formaFarmaceutica: texto(f.formaFarmaceutica),
    embalagem: texto(f.embalagem),
    fabricante: texto(f.fabricante),
    categoria: texto(f.categoria),
    subcategoria: texto(f.subcategoria),
    grupoHomogeneo: texto(f.grupoHomogeneo),
    flagGenerico: f.flagGenerico === true,
    camposManuais: camposManuaisDe(f),
  };
}

/**
 * O que a criação devolve.
 *
 * `criado: false` NÃO é um erro — é o CNP já existir. O chamador usa o
 * produto na mesma, que é o que faz o botão «Criar produto» nunca
 * deixar o utilizador num beco: ou cria, ou entrega-lhe o que já lá
 * estava, e em ambos os casos ele continua o que estava a fazer.
 */
export type ResultadoCriacao =
  | { ok: true; criado: boolean; produtoId: string; cnp: number; designacao: string }
  | { ok: false; erros: ErroValidacao[] };
