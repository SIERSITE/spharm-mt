/**
 * scripts/probe-infomed-http-replay.ts
 *
 * Prova de conceito: replay HTTP-only do fluxo de pesquisa do INFOMED
 * sem Playwright. Sequência:
 *
 *   1. GET index.xhtml → ViewState + JSESSIONID
 *   2. POST index.xhtml com submit-lupa params → expect redirect XML
 *   3. GET pesquisa-avancada.xhtml → expect HTML com dt-medicamentos
 *   4. (opcional) POST row link → expect redirect com med_guid
 *
 * Se isto funcionar end-to-end, eliminamos Playwright em produção.
 *
 * Não persiste em BD. Apenas log.
 */

import "dotenv/config";

const INDEX_URL = "https://extranet.infarmed.pt/INFOMED-fo/index.xhtml";
const PESQ_URL = "https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function parseSetCookie(header: string | null): string | null {
  if (!header) return null;
  // Set-Cookie pode ter múltiplas — pegamos JSESSIONID
  const m = /JSESSIONID=([^;]+)/.exec(header);
  return m ? m[1] : null;
}

function extractViewState(html: string): string | null {
  // <input type="hidden" name="javax.faces.ViewState" id="..." value="..." />
  const m = /name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  const term = process.argv[2] || "Decapeptyl";

  console.log(`Probe HTTP replay — term="${term}"`);

  // ── 1. GET index.xhtml ─────────────────────────────────────────────
  console.log(`\n[1] GET ${INDEX_URL}`);
  const r1 = await fetch(INDEX_URL, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" },
    redirect: "manual",
  });
  console.log(`    status=${r1.status}`);
  if (!r1.ok && r1.status !== 302) {
    console.error(`    falhou (${r1.status})`);
    process.exit(1);
  }
  const r1Html = await r1.text();
  console.log(`    bytes=${r1Html.length}`);

  const jsessionid = parseSetCookie(r1.headers.get("set-cookie"));
  const viewState = extractViewState(r1Html);
  console.log(`    JSESSIONID:    ${jsessionid?.slice(0, 40) ?? "NULL"}`);
  console.log(`    ViewState:     ${viewState?.slice(0, 50) ?? "NULL"}`);
  if (!jsessionid || !viewState) {
    console.error(`    [fatal] Sem JSESSIONID ou ViewState — anti-bot pode estar a bloquear`);
    process.exit(1);
  }

  // ── 2. POST submit lupa ────────────────────────────────────────────
  console.log(`\n[2] POST submit lupa com term="${term}"`);
  const submitParams = new URLSearchParams();
  submitParams.set("javax.faces.partial.ajax", "true");
  submitParams.set("javax.faces.source", "mainForm:ajax");
  submitParams.set("javax.faces.partial.execute", "@all");
  submitParams.set("javax.faces.partial.render", "mainForm:messages+mainForm:nomesMessage");
  submitParams.set("mainForm:ajax", "mainForm:ajax");
  submitParams.set("mainForm", "mainForm");
  submitParams.set("mainForm:acMinLength_input", term);
  submitParams.set("mainForm:acMinLength_hinput", term);
  submitParams.set("mainForm:chkAutorizadoComercializado_input", "on");
  submitParams.set("javax.faces.ViewState", viewState);

  const r2 = await fetch(INDEX_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Faces-Request": "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: `JSESSIONID=${jsessionid}`,
      Origin: "https://extranet.infarmed.pt",
      Referer: INDEX_URL,
    },
    body: submitParams.toString(),
    redirect: "manual",
  });
  console.log(`    status=${r2.status}`);
  const r2Body = await r2.text();
  console.log(`    bytes=${r2Body.length}`);
  console.log(`    excerpt: ${r2Body.slice(0, 400).replace(/\s+/g, " ")}`);

  // Esperamos um <partial-response> com <redirect url="..."/> ou similar
  const redirMatch = /<redirect[^>]*url="([^"]+)"/i.exec(r2Body);
  if (redirMatch) {
    console.log(`    ✓ redirect detectado: ${redirMatch[1]}`);
  } else {
    console.log(`    ✗ sem redirect — pode ter falhado o submit`);
  }

  // ── 3. GET pesquisa-avancada.xhtml ─────────────────────────────────
  console.log(`\n[3] GET ${PESQ_URL}`);
  const r3 = await fetch(PESQ_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      Cookie: `JSESSIONID=${jsessionid}`,
      Referer: INDEX_URL,
    },
  });
  console.log(`    status=${r3.status}`);
  const r3Html = await r3.text();
  console.log(`    bytes=${r3Html.length}`);

  // Parse rows da datatable
  const rowsMatch = r3Html.match(/<tr[^>]*data-ri="\d+"[^>]*>[\s\S]*?<\/tr>/g);
  console.log(`    linhas dt-medicamentos: ${rowsMatch?.length ?? 0}`);
  if (rowsMatch && rowsMatch.length > 0) {
    console.log(`    Primeiras linhas:`);
    for (const row of rowsMatch.slice(0, 5)) {
      const ri = /data-ri="(\d+)"/.exec(row)?.[1];
      const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g);
      if (!cells) continue;
      // cell 0: hidden MED_ID
      const medId = />(\d+)</.exec(cells[0])?.[1];
      // cell 1: Nome (contém <a>...nome</a>)
      const nome = /<a[^>]*linkNome[^>]*>([^<]+)<\/a>/.exec(cells[1])?.[1] ?? "?";
      // cell 2: DCI (texto directo)
      const dci = cells[2]?.replace(/<[^>]+>/g, "").trim() ?? "?";
      // cell 3: Forma
      const forma = cells[3]?.replace(/<[^>]+>/g, "").trim() ?? "?";
      // cell 4: Dosagem
      const dosagem = cells[4]?.replace(/<[^>]+>/g, "").trim() ?? "?";
      // cell 5: Titular
      const titular = cells[5]?.replace(/<[^>]+>/g, "").trim() ?? "?";
      console.log(
        `      [ri=${ri}] medId=${medId} · "${nome}" · dci="${dci.slice(0, 40)}" · ${forma.slice(0, 30)} · ${dosagem} · ${titular.slice(0, 30)}`,
      );
    }
  }

  // ViewState NOVO da pesquisa-avancada (precisa para Step 4)
  const viewState3 = extractViewState(r3Html);
  console.log(`    ViewState pesquisa-avancada: ${viewState3?.slice(0, 50) ?? "NULL"}`);

  // ── 4. POST click row 0 → expect redirect com med_guid ───────────
  if (rowsMatch && rowsMatch.length > 0 && viewState3) {
    console.log(`\n[4] POST click linkNome row 0 → resolver med_guid`);
    const clickParams = new URLSearchParams();
    clickParams.set("javax.faces.partial.ajax", "true");
    clickParams.set("javax.faces.source", "mainForm:dt-medicamentos:0:linkNome");
    clickParams.set("javax.faces.partial.execute", "mainForm:dt-medicamentos:0:linkNome");
    clickParams.set("mainForm", "mainForm");
    clickParams.set(
      "mainForm:dt-medicamentos:0:linkNome",
      "mainForm:dt-medicamentos:0:linkNome",
    );
    clickParams.set("javax.faces.ViewState", viewState3);

    const r4 = await fetch(PESQ_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: `JSESSIONID=${jsessionid}`,
        Origin: "https://extranet.infarmed.pt",
        Referer: PESQ_URL,
      },
      body: clickParams.toString(),
      redirect: "manual",
    });
    console.log(`    status=${r4.status}`);
    const r4Body = await r4.text();
    console.log(`    bytes=${r4Body.length}`);
    console.log(`    excerpt: ${r4Body.slice(0, 600).replace(/\s+/g, " ")}`);
    const guidMatch = /med_guid=([a-zA-Z0-9-]+)/i.exec(r4Body);
    if (guidMatch) {
      console.log(`    ✓ med_guid resolved direct: ${guidMatch[1]}`);
    } else {
      console.log(`    (med_guid não no response — provavelmente em session; tenta Step 5)`);

      // ── 5. GET detalhes-medicamento.xhtml SEM query — server resolve via session
      console.log(`\n[5] GET detalhes-medicamento.xhtml (session-based, sem query)`);
      const r5 = await fetch(
        "https://extranet.infarmed.pt/INFOMED-fo/detalhes-medicamento.xhtml",
        {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
            Cookie: `JSESSIONID=${jsessionid}`,
            Referer: PESQ_URL,
          },
          redirect: "manual",
        },
      );
      console.log(`    status=${r5.status}`);
      // Se 302, segue redirect (com med_guid?)
      const location = r5.headers.get("location");
      if (location) {
        console.log(`    Location: ${location}`);
        const guidInLoc = /med_guid=([a-zA-Z0-9-]+)/i.exec(location);
        if (guidInLoc) console.log(`    ✓ med_guid via redirect Location: ${guidInLoc[1]}`);
      }
      const r5Body = await r5.text();
      console.log(`    bytes=${r5Body.length}`);
      // Procurar nome do medicamento — confirma que é o detail page certo
      const nomeMatch = /id="detalheMedNomeMed"[^>]*>([^<]+)</i.exec(r5Body);
      if (nomeMatch) {
        console.log(`    ✓ detail page renderizado — nome: "${nomeMatch[1].trim()}"`);
      } else {
        console.log(`    excerpt: ${r5Body.slice(0, 400).replace(/\s+/g, " ")}`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("Probe completa. Ver acima para sucesso/falha de cada step.");
  console.log("─".repeat(60));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
