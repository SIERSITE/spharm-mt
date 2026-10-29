# Auditoria dos fabricantes (Garantia) — comando para o contentor `migrate`

## Objetivo

Relatório **só de leitura** sobre o agrupamento de fabricantes do tenant `garantia`: opções antes/depois, grupos com mais de 10 variantes, nomes canónicos, variantes (com relações manuais), aliases, nº de produtos, regras CNP e produtos manuais (CNP), ambiguidades e fabricantes semelhantes que ficaram separados (só candidatos para revisão humana).

Script: `scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts`.

## Comando exato (na VPS, como root/sudo)

```bash
sudo mkdir -p /opt/spharmmt/relatorios && sudo chmod 0700 /opt/spharmmt/relatorios

sudo docker compose \
  -f /opt/spharmmt/docker/compose/docker-compose.yml -p spharmmt \
  --env-file /opt/spharmmt/docker/env/platform.env \
  --env-file /opt/spharmmt/docker/env/stack.env \
  --profile tools run --rm --no-deps \
  -v /opt/spharmmt/relatorios:/relatorios \
  migrate npx tsx scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts \
  --confirmo-read-only --tenant garantia
```

(`--env-file .../stack.env` só se esse ficheiro existir — o wrapper `dc()` de `deploy/scripts/lib/common.sh` faz o mesmo teste. Se o utilizador já usa o alias/wrapper `dc`, é `dc --profile tools run --rm --no-deps -v ... migrate npx tsx ...`.)

Os relatórios ficam no **host** em `/opt/spharmmt/relatorios/auditoria-fabricantes-garantia-<AAAAMMDD>T<HHMMSS>Z.md` e `.json`.

### Porque é seguro com o entrypoint

`deploy/docker/entrypoint.sh` só corre `prisma migrate deploy` / `tenancy:migrate-all` no modo literal `migrate` (o `command` por omissão do serviço). Um comando diferente (`npx …`) cai no ramo `*)`: apenas constrói `DATABASE_URL`/`CONTROL_DATABASE_URL` a partir das peças, deriva o `POSTGRES_ADMIN_URL` em memória (a auditoria não o usa) e faz `exec` do comando. **Nenhuma migração é disparada**, por isso não é preciso `--entrypoint`. Não se deve passar `migrate` como primeiro argumento do comando.

## Pré-requisitos

1. **A imagem `migrator` tem de conter este script.** O `Dockerfile` copia `scripts/diagnostics/` inteiro para a imagem, mas a imagem na VPS só o tem depois de reconstruída a partir do commit que o inclui. Reconstruir (não corre migrações):
   ```bash
   sudo docker compose -f /opt/spharmmt/docker/compose/docker-compose.yml -p spharmmt \
     --env-file /opt/spharmmt/docker/env/platform.env --env-file /opt/spharmmt/docker/env/stack.env \
     --profile tools build migrate
   ```
   (ou o fluxo habitual `deploy/scripts/update-platform.sh`, que faz `dct build migrate`). Sem rebuild, o `npx tsx` falha com `ERR_MODULE_NOT_FOUND`/ficheiro inexistente — nada é lido nem escrito.
2. O ambiente do serviço `migrate` já traz, por `env_file`: `platform.env` (POSTGRES_HOST/PORT/…, `DATABASE_SSLMODE`, `TENANT_DB_SSLMODE`), `app.secrets.env` (`POSTGRES_APP_PASSWORD`, **`TENANT_ENCRYPTION_SECRET`**) e `tools.secrets.env`. O entrypoint deriva `CONTROL_DATABASE_URL`. Nada disto é passado na linha de comandos.
3. O diretório do host montado em `/relatorios` tem de existir (o script **não cria** diretórios e recusa se não existir ou não for gravável). O contentor corre como root, por isso consegue gravar.

## Como ler

* `.md`: Resumo → Top de grupos por variantes → **Casos com mais de dez nomes** (confirma se todas as variantes estão agrupadas) → **Opções ANTES** (uma por fabricante) → **Opções DEPOIS** (grupos com nº de variantes + fabricantes sem prova) → **Grupos** (nome canónico, aliases, produtos distintos por origem, variantes com id/tipo de associação/`RELAÇÃO MANUAL`/aliases, regras CNP, produtos manuais, produtos incluídos cujo fabricante não é membro, produtos de membros fora do grupo) → **Fabricantes semelhantes separados** (candidatos para REVISÃO HUMANA) → **Ambiguidades e sobreposições**.
* `.json`: os mesmos dados, completos (o `.md` corta listas longas a 25 linhas por secção e remete para o JSON).
* A consola mostra só um resumo de números e os caminhos dos ficheiros.

## Garantias de só-leitura

* Exige `--confirmo-read-only`; sem ele recusa antes de abrir qualquer ligação.
* Control plane e tenant: ligações com `default_transaction_read_only=on`; transacção `READ ONLY` (tenant em `REPEATABLE READ`); `SHOW transaction_read_only` tem de dar `on` **antes de qualquer consulta**, senão aborta.
* Só `SELECT` (testado estruturalmente e por xmin/contagens de todas as tabelas, tenant e control plane, antes/depois; testado também ligado como superutilizador). Uma escrita na sessão é rejeitada pela própria base.
* Resolve o tenant pelo mesmo mecanismo do `tenancy:*` (`CONTROL_DATABASE_URL` + tabela `Tenant` + password decifrada com `TENANT_ENCRYPTION_SECRET`, `buildTenantConnectionString`, respeitando `TENANT_DB_SSLMODE`). Slug inexistente ou tenant não `ACTIVE` ⇒ recusa.
* Nunca imprime URL, utilizador, password, host:porta nem chaves (mascarados também em mensagens de erro); o relatório identifica só `tenant <slug> · base <nome>`.
* Escreve apenas `auditoria-fabricantes-<slug>-<UTC>.md/.json` dentro de `--out-dir` (por omissão `/relatorios`), nunca sobrescreve (flag `wx`), modo 0600.

## O que NÃO faz

* Não aceita URL de base de dados (`--url` e URL posicional são recusados); não usa `DATABASE_URL`.
* Não escreve na base, não corre migrações, não cria diretórios, não altera grupos/aliases/regras; não agrupa nada por semelhança de nomes (os candidatos são apenas informação para decisão humana).
* Não é executado pela automação: foi testado só com bases descartáveis; a execução na VPS é manual.
