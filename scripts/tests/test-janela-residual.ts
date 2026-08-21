/**
 * scripts/tests/test-janela-residual.ts
 *
 * `--limite=N` são N produtos PROCESSÁVEIS, não N linhas lidas.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * A leitura era `order by cnp limit N` e a pré-selecção corria depois.
 * Os produtos que a pré-selecção exclui por CONDIÇÃO — subcategoria sem
 * utilização plausível, designação opaca — não recebem cache e por isso
 * não saem do residual. Voltam a ser dos N mais baixos na corrida
 * seguinte, e na seguinte.
 *
 * No silveira, em 2026-08-21, a progressão foi esta:
 *
 *   corrida das 14:34    3 de 25 eram peso morto   (12%)
 *   corrida das 14:50   10 de 25                   (40%)
 *   corrida seguinte    12 de 25                   (48%)
 *
 * com 2 184 condicionais em 18 454 residuais (11,8%). O ponto de chegada
 * é uma janela inteiramente ocupada por produtos que não vão a lado
 * nenhum, com ~16 000 processáveis parados acima da fronteira. Não é
 * lentidão: é paragem.
 *
 * Estas asserções falham na leitura de página única e passam na
 * paginada. O controlo negativo está no fim e mede exactamente isso.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-janela-residual.ts
 */
import {
  MIN_CNP,
  lerJanelaProcessavel,
  corpoResidual,
} from "../../lib/catalog/knowledge-enrichment-runner";
import { agruparFamilias, preselecionar } from "../../lib/catalog/preselection";

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

// ─── Fixture ──────────────────────────────────────────────────────────

type Produto = {
  cnp: number;
  designacao: string;
  nivel1: string | null;
  nivel2: string | null;
};

/** Nome só de letras e único por cnp — designações repetidas fundiriam
 *  tudo numa família e o teste passaria a medir outra coisa. */
const soLetras = (n: number) => {
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26);
  } while (x > 0);
  return `Zeta${s}`;
};

const EXCLUIDA = "MEDICAMENTOS > Oftálmicos";
const subExcluidas = new Set([EXCLUIDA]);

/** Condicional: em subcategoria específica de cobertura nula. */
const condicional = (cnp: number): Produto => ({
  cnp,
  designacao: soLetras(cnp),
  nivel1: "MEDICAMENTOS",
  nivel2: "Oftálmicos",
});

/** Processável: por classificar, portanto vai ao modelo. */
const processavel = (cnp: number): Produto => ({
  cnp,
  designacao: soLetras(cnp),
  nivel1: null,
  nivel2: null,
});

/**
 * Prisma falso que serve páginas a sério: honra o cursor `$5` e o limite
 * `$4`, e regista o que lhe pediram.
 *
 * O cursor é o quinto parâmetro porque é isso que `corpoResidual`
 * escreve — a asserção sobre o SQL está mais abaixo e é o que impede
 * este duplo de concordar com um contrato que já não existe.
 */
function prismaPaginado(produtos: Produto[]) {
  const paginas: Array<{ cursor: number; limite: number; devolvidos: number[] }> = [];
  return {
    paginas,
    prisma: {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (/as nivel1/i.test(sql)) {
          return produtos.map((p) => ({ ...p, utilizacoes: [] }));
        }
        const limite = Number(params[3] ?? 0);
        const cursor = Number(params[4] ?? 0);
        const linhas = produtos
          .filter((p) => p.cnp >= MIN_CNP && p.cnp > cursor)
          .sort((a, b) => a.cnp - b.cnp)
          .slice(0, limite);
        paginas.push({ cursor, limite, devolvidos: linhas.map((l) => l.cnp) });
        return linhas.map((p) => ({
          cnp: p.cnp,
          designacao: p.designacao,
          productType: null,
          categoriaAtual: p.nivel1,
          subcategoriaAtual: p.nivel2,
          estrato: p.nivel2 ? "SEM_UTILIZACOES" : "NAO_CLASSIFICADO",
        }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const janela = async (produtos: Produto[], alvo: number, tamanhoPagina: number) => {
  const { prisma, paginas } = prismaPaginado(produtos);
  const contexto = produtos.map((p) => ({ ...p, utilizacoes: [] as string[] }));
  const j = await lerJanelaProcessavel(prisma, {
    alvoProcessaveis: alvo,
    contexto,
    familias: agruparFamilias(contexto),
    subExcluidas,
    tamanhoPagina,
  });
  const processaveis = j.linhas.filter((l) => {
    const d = j.preselecao.get(l.cnp)?.destino;
    return d === "ENVIAR" || d === "REPRESENTANTE";
  }).length;
  return { ...j, paginas, processaveis };
};

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════
  console.log("\n=== o SQL tem mesmo um cursor, e é o $5 ===");
  {
    const com = corpoResidual(undefined, false, true);
    const sem = corpoResidual(undefined, false, false);
    check(com.includes("and p.cnp > $5"), "com cursor, o WHERE tem `p.cnp > $5`");
    check(!sem.includes("$5"), "sem cursor, o SQL fica exactamente como era");
    check(com.includes('where p.cnp >= $1'), "o piso do cnp continua a ser o $1");
  }

  console.log("\n=== 80 condicionais à frente de 20 processáveis ===");
  {
    // A forma exacta do problema, em pequeno: se a leitura parasse na
    // primeira página, a corrida não faria trabalho nenhum.
    const produtos = [
      ...Array.from({ length: 80 }, (_, i) => condicional(2_000_000 + i)),
      ...Array.from({ length: 20 }, (_, i) => processavel(2_100_000 + i)),
    ];
    const j = await janela(produtos, 25, 10);

    check(j.processaveis === 20, `atravessou os 80 e trouxe os 20 processáveis (${j.processaveis})`);
    check(j.esgotado, "…e declara que o residual se esgotou antes de encher a janela");
    // 11 e não 10: a décima página vem cheia, e uma página cheia não
    // distingue "acabou" de "há mais". A leitura vazia seguinte é o preço
    // de saber que acabou — uma consulta, e a alternativa era um COUNT
    // por página.
    check(j.paginas.length === 11, `…em 11 páginas de 10, a última vazia (${j.paginas.length})`, JSON.stringify(j.paginas.map((p) => p.devolvidos.length)));
    check(j.paginas.at(-1)?.devolvidos.length === 0, "…e só a última é que veio vazia");
    check(j.cnpsLidos === 100, `…tendo lido os 100 (${j.cnpsLidos})`);

    // A comparação que interessa: a leitura antiga.
    const contexto = produtos.map((p) => ({ ...p, utilizacoes: [] as string[] }));
    const antiga = produtos.slice(0, 25);
    const preAntiga = preselecionar(
      antiga.map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        productType: null,
        categoriaAtual: p.nivel1,
        subcategoriaAtual: p.nivel2,
        estrato: (p.nivel2 ? "SEM_UTILIZACOES" : "NAO_CLASSIFICADO") as never,
      })),
      contexto,
      { subcategoriasExcluidas: subExcluidas },
    );
    const processaveisAntigos = antiga.filter((p) => {
      const d = preAntiga.get(p.cnp)?.destino;
      return d === "ENVIAR" || d === "REPRESENTANTE";
    }).length;
    check(
      processaveisAntigos === 0 && j.processaveis === 20,
      "CONTROLO NEGATIVO: `limit 25` dava 0 processáveis; a janela dá 20",
      `antiga=${processaveisAntigos} nova=${j.processaveis}`,
    );
  }

  console.log("\n=== a janela pára quando tem os N que lhe pediram ===");
  {
    const produtos = [
      ...Array.from({ length: 80 }, (_, i) => condicional(2_000_000 + i)),
      ...Array.from({ length: 120 }, (_, i) => processavel(2_100_000 + i)),
    ];
    const j = await janela(produtos, 25, 10);
    check(j.processaveis === 25, `trouxe exactamente 25 processáveis (${j.processaveis})`);
    check(!j.esgotado, "…e não declara esgotado — havia mais");
    check(j.cnpsLidos < 200, `…sem ler o residual todo (${j.cnpsLidos} de 200)`);
    check(
      j.foraDaJanela === j.cnpsLidos - j.linhas.length,
      "…e o excedente lido é contado como 'fora da janela'",
      `fora=${j.foraDaJanela} lidos=${j.cnpsLidos} janela=${j.linhas.length}`,
    );
    check(
      j.cnpsLidos === j.linhas.length + j.foraDaJanela + j.semContexto + j.jaConhecidosGlobal,
      "…e a soma fecha: lido = janela + fora + sem-contexto + global",
    );
  }

  console.log("\n=== a forma da produção: 11,8% de condicionais ===");
  {
    // 2 000 residuais com a mesma proporção medida no silveira, e os
    // condicionais à cabeça, que é onde eles se acumulam.
    const produtos = [
      ...Array.from({ length: 236 }, (_, i) => condicional(2_000_000 + i)),
      ...Array.from({ length: 1764 }, (_, i) => processavel(2_100_000 + i)),
    ];
    const j = await janela(produtos, 25, 250);
    check(j.processaveis === 25, `25 processáveis apesar dos 236 condicionais à frente (${j.processaveis})`);
    check(j.paginas.length === 2, `…em 2 páginas de 250 (${j.paginas.length})`);
    // A primeira página levou os 236 condicionais E os 14 processáveis
    // que couberam nos 250. O cursor é o último cnp devolvido, e não o
    // fim do bloco de condicionais: a fronteira é a chave, não a classe.
    check(j.paginas[1].cursor === 2_100_013, `…e a segunda página arranca no último cnp da primeira (${j.paginas[1].cursor})`);
    check(j.linhas.length === 261, `…a janela leva 236 condicionais + 25 processáveis (${j.linhas.length})`);
    check(j.cnpsLidos === 500 && j.foraDaJanela === 239, `…e o resto da página fica contado como fora da janela (lidos=${j.cnpsLidos} fora=${j.foraDaJanela})`);
  }

  console.log("\n=== paginação: sem duplicar e sem saltar ===");
  {
    const produtos = Array.from({ length: 97 }, (_, i) => processavel(2_000_000 + i * 7));
    const j = await janela(produtos, 90, 10);
    const lidos = j.paginas.flatMap((p) => p.devolvidos);
    check(new Set(lidos).size === lidos.length, "nenhum cnp lido duas vezes");
    const esperado = produtos.map((p) => p.cnp).slice(0, lidos.length);
    check(
      JSON.stringify(lidos) === JSON.stringify(esperado),
      "e a sequência lida é o prefixo exacto por ordem de cnp — sem buracos",
    );
    check(
      j.paginas.every((p, i) => (i === 0 ? p.cursor === MIN_CNP - 1 : p.cursor === j.paginas[i - 1].devolvidos.at(-1))),
      "cada página arranca no último cnp da anterior",
    );
  }

  console.log("\n=== famílias sobrevivem à fronteira entre páginas ===");
  {
    // Se cada página fosse pré-seleccionada isoladamente, o irmão da
    // página 2 não seria reconhecido como irmão do da página 1 — e em vez
    // de um representante e um dependente havia dois envios pagos.
    const irmaos = [2_000_000, 2_000_050].map((cnp) => ({
      cnp,
      designacao: "Movalis Comprimidos",
      nivel1: null,
      nivel2: null,
    }));
    const enchimento = Array.from({ length: 48 }, (_, i) => processavel(2_000_001 + i));
    const produtos = [irmaos[0], ...enchimento, irmaos[1]].sort((a, b) => a.cnp - b.cnp);
    const j = await janela(produtos, 50, 10);

    check(j.paginas.length >= 2, `a família ficou mesmo partida por páginas (${j.paginas.length})`);
    check(
      j.preselecao.get(2_000_000)?.destino === "REPRESENTANTE",
      "o irmão da página 1 é REPRESENTANTE",
      String(j.preselecao.get(2_000_000)?.destino),
    );
    check(
      j.preselecao.get(2_000_050)?.destino === "PROPAGAR",
      "o irmão da última página é PROPAGAR, não um segundo envio pago",
      String(j.preselecao.get(2_000_050)?.destino),
    );
    check(
      j.preselecao.get(2_000_050)?.representanteCnp === 2_000_000,
      "…e aponta ao representante certo",
    );
  }

  console.log("\n=== o dependente atravessa o corte com o seu representante ===");
  {
    // O corte cai no N-ésimo processável. Um dependente logo a seguir não
    // custa chamada nenhuma: deixá-lo de fora obrigava a família a ser
    // paga outra vez na corrida seguinte.
    const produtos = [
      processavel(2_000_000),
      { cnp: 2_000_001, designacao: "Movalis Comprimidos", nivel1: null, nivel2: null },
      { cnp: 2_000_002, designacao: "Movalis Comprimidos", nivel1: null, nivel2: null },
      processavel(2_000_003),
    ];
    const j = await janela(produtos, 2, 10);
    check(j.processaveis === 2, `dois processáveis, como pedido (${j.processaveis})`);
    check(
      j.linhas.some((l) => l.cnp === 2_000_002),
      "e o dependente entrou na janela apesar de estar depois do corte",
      j.linhas.map((l) => l.cnp).join(","),
    );
    check(
      !j.linhas.some((l) => l.cnp === 2_000_003),
      "…mas o processável seguinte ficou de fora — o tecto é o tecto",
    );
  }

  console.log("\n=== residual vazio e alvo zero não entram em ciclo ===");
  {
    const vazio = await janela([], 25, 10);
    check(vazio.linhas.length === 0 && vazio.esgotado, "residual vazio devolve nada e declara esgotado");
    check(vazio.paginas.length === 1, "…tendo tentado uma página, não zero nem mil");

    const zero = await janela([processavel(2_000_000)], 0, 10);
    check(zero.paginas.length === 0, "alvo zero não lê nada");
    check(zero.linhas.length === 0, "…e não devolve nada");
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);

}

main().then(() => {
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
});
