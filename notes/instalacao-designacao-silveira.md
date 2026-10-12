# Instalação coordenada — designação autoritativa da Silveirense (aplicação + worker + agent rev97)

Revisão a instalar: a indicada em `SHA` (SHA final da branch
`feat/pesquisa-impressao-designacao-silveirense`). **Sem migrations.**
Pacote do agent: `spharmmt-agent-base-rev97.zip`.

## Regra final (o que esta entrega faz)

* Tenant `silveira`. A **Silveirense** (o `Farmacia.id` configurado em
  `SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID`, comparado com a farmácia autenticada no pedido do
  agent; **não** depende de `codigoANF`, que as farmácias não têm) é a fonte da designação: uma designação
  **não vazia** substitui sempre a actual — **mesmo que `"designacao"` esteja em
  `camposManuais`** (é a única excepção a essa protecção).
* **Todos os outros campos** em `camposManuais` (`flagGenerico`, `flagMnsrmNCompart`, …) continuam
  protegidos; fabricantes, fornecedores e classificações não são tocados.
* Designação vazia nunca substitui. As outras farmácias só definem a designação ao **criar** o
  produto; depois, nunca a substituem (manual ou não).
* Outros tenants: comportamento inalterado (a protecção de `camposManuais` mantém-se).
* Um só caminho de escrita: `bulkUpsertProdutosByCnp` (modo `AUTORITATIVA`) e o passo leve
  (`aplicarDesignacoesAutoritativas`), ambos governados por `decidirDesignacao`.

## Gerar o pacote do agent

Na máquina de build, com o checkout **limpo e no SHA final** (o carimbo `commit=` do bundle
sai do `git rev-parse HEAD`):

```bash
git checkout --detach <SHA> && git status --short          # tem de estar vazio
PUBLIC_APP_URL=https://app.spharmmt.com npm run agent:package
# → dist-agent/spharmmt-agent-base-rev97.zip   (+ dist-agent/SPharmMT-Agent/)
sha256sum dist-agent/spharmmt-agent-base-rev97.zip
```

O build **recusa árvore suja** e grava `MANIFEST.json` na raiz do ZIP (rev, commit completo,
branch, data UTC, sha256 e tamanho de cada ficheiro). **Verificar antes de distribuir:**

```bash
unzip -p dist-agent/spharmmt-agent-base-rev97.zip MANIFEST.json | head -8   # rev=97, commit=<SHA>, dirty=false
```

> A rev96 (ZIP de 12/10/2026) foi retirada: mesmo código de agent, mas sem manifesto e com o
> commit abreviado de um SHA intermédio (`7fe28b8`) no bundle. Não instalar a rev96.

`PUBLIC_APP_URL` é o endpoint que fica selado em `agent.config.example.json`; usar **o mesmo
valor que a VPS tem em `/opt/spharmmt/docker/env/platform.env`** (confirmar antes:
`grep ^PUBLIC_APP_URL /opt/spharmmt/docker/env/platform.env`). A revisão `rev97` vem de
`agent/build.mjs`.

## Instalação — ordem obrigatória

Convenções (na VPS): `DC` = compose da stack.

```bash
SHA=<SHA final>
DC="sudo docker compose -p spharmmt --profile tools \
  --env-file /opt/spharmmt/docker/env/platform.env \
  --env-file /opt/spharmmt/docker/env/stack.env"
cd /opt/spharmmt/docker/compose
```

**0. Preparação.**

```bash
cd <clone do repositório> && git fetch origin && git checkout --detach "$SHA" && git status --short   # vazio
sudo /opt/spharmmt/scripts/backup-platform.sh --label pre-designacao
docker exec spharmmt-app printenv APP_REVISION          # anotar: é a REVISÃO ANTERIOR (rollback)
```

**1. Imagem de ferramentas nova (só o `migrator`; não toca em web/worker).** O diagnóstico novo
vive nela.

```bash
export APP_BUILD_CONTEXT=<clone do repositório> APP_REVISION="$SHA"
cd /opt/spharmmt/docker/compose && $DC build migrate
```

**2. Diagnóstico ANTES** (read-only):

```bash
$DC run --rm migrate npm run diag:designacao-silveira -- --tenant=silveira
```

Esperado antes de configurar: `ESTADO=INVALIDA:NAO_CONFIGURADO`, com a lista das farmácias
(id, nome, estado, nº de produtos).

**3. Identificar a Silveirense** na lista do passo 2, pelo **`Farmacia.id`**. Em produção é
`cmsmx87dk000201obow8qp7et` — confirmar que a linha com esse id é «Farmácia Silveirense». Não se
escreve nada na base: **não há** código ANF a criar nem comando de configuração.

**4. Configurar a variável** (persistida em `platform.env`; sobrevive ao `install-platform.sh`
desta revisão em diante). O id vive **só** aqui, nunca no código:

```bash
FID=cmsmx87dk000201obow8qp7et      # o Farmacia.id da Silveirense (só letras e dígitos)
F=/opt/spharmmt/docker/env/platform.env
if grep -q '^SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID=' "$F"; then
  sudo sed -i "s/^SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID=.*/SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID=${FID}/" "$F"
else
  echo "SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID=${FID}" | sudo tee -a "$F" >/dev/null
fi
grep ^SILVEIRA_DESIGNACAO "$F"
```

**5. Instalar aplicação e worker** (deploy rápido: constrói, recria só `web` e `worker`, recusa-se
se houver migrations — não há — e faz rollback automático se o healthcheck falhar):

```bash
sudo /opt/spharmmt/scripts/deploy-app.sh --clone <clone do repositório> "$SHA"
```

Os containers são recriados e passam a ler a variável do passo 4. A imagem `migrator` já foi
construída no passo 1.

**6. Instalar o novo agent.**

*6a. Servir o pacote (Admin Wizard / novas instalações):*

```bash
scp dist-agent/spharmmt-agent-base-rev97.zip deploy@<vps>:/tmp/
sudo cp -p /opt/spharmmt/agent-base/spharmmt-agent-base.zip /opt/spharmmt/agent-base/spharmmt-agent-base.zip.anterior
sudo install -m 0644 -o deploy -g spharmmt /tmp/spharmmt-agent-base-rev97.zip /opt/spharmmt/agent-base/spharmmt-agent-base.zip
```

*6b. Em cada farmácia (obrigatório na **Silveirense**; recomendado na Segurado, que só passa a
fazer um GET extra).* Fora de uma corrida do agent (sem `daily-pipeline`/`sync-now` activos),
no PC da farmácia, em PowerShell, com `<AGENT>` = pasta onde o agent está instalado:

```powershell
$agent = '<AGENT>'; $zip = 'C:\Temp\spharmmt-agent-base-rev97.zip'
Copy-Item $agent "$agent.rev-anterior" -Recurse            # cópia para rollback
Expand-Archive $zip C:\Temp\agent-rev97 -Force
robocopy C:\Temp\agent-rev97 $agent /E /XF agent.config.json /XD logs output run
```

Preserva `agent.config.json` (farmácia/tenant/chave), `logs`, `output` e `run`. Confirmar a revisão:

```powershell
cd $agent; .\node.exe agent.cjs health          # o banner mostra rev=97
Get-Content .MANIFEST.json | Select-String '"rev"|"commit"|"builtAtUtc"'
```

**7. Reiniciar o necessário.** Web e worker já foram recriados no passo 5. Os agents correm por
tarefa agendada: não há processo a reiniciar; a próxima corrida (`daily-pipeline` ou
`sync-now`) usa o código novo.

**8. Diagnóstico DEPOIS** (tem de dar `ESTADO=VALIDA`, exit 0):

```bash
cd /opt/spharmmt/docker/compose && $DC run --rm migrate npm run diag:designacao-silveira -- --tenant=silveira
# (compara também com o que a app vê:)
docker exec spharmmt-app printenv SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID
```

**9. «Atualizar agora» na Silveirense** (/stock → escolher a farmácia → «Sincronizar agora»).

**10. Confirmar o contador.** O botão mostra «… · Designações alteradas: N». Na base:

```sql
-- execuções recentes (details guarda designacoesAlteradas/Verificadas)
SELECT "startedAt", status, details FROM "PipelineRun" WHERE kind = 'sync-now' ORDER BY "startedAt" DESC LIMIT 3;
```

Uma 2.ª execução deve mostrar `Designações alteradas: 0` (idempotente). Na Segurado o botão
**não** mostra o contador de designações.

## Rollback coordenado

A ordem é inversa e **qualquer combinação é segura**: o agent novo tolera um SaaS sem o endpoint
(404 ⇒ passo saltado, registado no log) e o agent antigo funciona com o SaaS novo (só não faz
o passo do catálogo inteiro).

1. **Agents** (PC da farmácia): parar tarefas, restaurar a cópia:
   `Remove-Item $agent -Recurse -Force; Rename-Item "$agent.rev-anterior" (Split-Path $agent -Leaf)`.
2. **Pacote servido:** `sudo mv /opt/spharmmt/agent-base/spharmmt-agent-base.zip.anterior /opt/spharmmt/agent-base/spharmmt-agent-base.zip`.
3. **Aplicação/worker:** `sudo /opt/spharmmt/scripts/deploy-app.sh --clone <clone> <REVISÃO ANTERIOR>`
   (sem migrations; a imagem anterior também fica etiquetada `…:rollback-<rev>`).
4. **Variável** (opcional): deixar — nas revisões antigas é ignorada. Para a remover, apagar a
   linha em `platform.env` e recriar web/worker.
5. As designações **já substituídas** pela Silveirense não são repostas automaticamente; se for
   preciso, restaurar da cópia `pre-designacao` (`restore-platform.sh --list`).
