# deploy/ — Infraestrutura reproduzível do SPharm.MT

Preparação automatizada de uma VPS Ubuntu 24.04 para produção. O objectivo
é que qualquer VPS nova fique pronta **apenas correndo scripts** — sem passos
manuais, sem configuração implícita, sem "e depois é preciso lembrar de...".

Os scripts vivem em `deploy/scripts/` no repositório e são instalados em
`/opt/spharmmt/scripts/` na VPS. Correm a partir de qualquer um dos dois sítios.

---

## Execução real — procedimento completo

Segue esta ordem. Os passos 0 a 2 fazem-se **antes** de tocar na VPS e são o
que separa um erro recuperável de uma reinstalação.

### Passo 0 — Painel do fornecedor (antes de tudo)

Confirma, no painel, que tens:

| Requisito | Porque é obrigatório |
|---|---|
| **Consola de emergência / VNC / rescue mode** | É a **única** via de recuperação se te trancares fora por SSH. Abre-a uma vez agora para confirmar que funciona e que sabes a password. Sem isto, **não uses `--disable-root-login`.** |
| **Snapshots disponíveis** | Único rollback real do `apt dist-upgrade`. |
| **Firewall de rede do painel** | Muitos fornecedores têm uma firewall à frente da VPS. Se uma porta parecer fechada apesar do UFW a permitir, é aqui. Deixa 22/tcp aberto. |
| **IP público fixo e anotado** | Vais precisar dele em todos os comandos. |
| **Portas SMTP de saída** | Muitos fornecedores bloqueiam 25/465/587 por omissão. Só relevante mais tarde (envio de relatórios), mas pedir o desbloqueio costuma demorar dias — pede já. |

### Passo 1 — Snapshot

No painel, cria um snapshot da VPS limpa e dá-lhe um nome reconhecível
(`spharmmt-pre-bootstrap`). O `bootstrap` faz `dist-upgrade`; se algo correr
mal a nível de kernel, este snapshot é o caminho de volta.

### Passo 2 — Chave SSH (na tua máquina Windows)

```powershell
# Gerar o par, se ainda não existir. A passphrase é a tua última defesa
# se o portátil for comprometido — usa uma.
ssh-keygen -t ed25519 -a 100 -C "deploy@spharmmt" -f $env:USERPROFILE\.ssh\spharmmt_prod

# Copiar a chave PÚBLICA para a área de transferência (é esta que vai para a VPS)
Get-Content $env:USERPROFILE\.ssh\spharmmt_prod.pub | Set-Clipboard

# Confirmar o que copiaste (deve começar por "ssh-ed25519 AAAA")
Get-Content $env:USERPROFILE\.ssh\spharmmt_prod.pub
```

**Guarda a chave privada** (`spharmmt_prod`, sem `.pub`) no gestor de
passwords. Nunca a envies para a VPS.

Opcional — atalho em `%USERPROFILE%\.ssh\config`:

```
Host spharmmt
    HostName <IP_DA_VPS>
    User deploy
    IdentityFile ~/.ssh/spharmmt_prod
    IdentitiesOnly yes
```

### Passo 3 — Bootstrap

Liga-te como root (credenciais do fornecedor) e **mantém esta sessão aberta
até ao fim do passo 5**:

```bash
ssh root@<IP_DA_VPS>

apt-get update && apt-get install -y git
git clone https://github.com/SIERSITE/spharm-mt.git /tmp/spharmmt
cd /tmp/spharmmt/deploy/scripts

# Opcional mas recomendado: ver o que faria, sem alterar nada
./bootstrap-vps.sh --dry-run --ssh-key "ssh-ed25519 AAAA... deploy@spharmmt"

# Execução real (cola a chave pública do passo 2)
./bootstrap-vps.sh --ssh-key "ssh-ed25519 AAAA... deploy@spharmmt" --yes
```

Demora 5–15 min, quase tudo no `apt dist-upgrade`. No fim imprime um
relatório e grava-o em `/opt/spharmmt/logs/monitoring/bootstrap-report-*.txt`.

Se tiveres IP fixo no escritório, acrescenta `--admin-ip <o-teu-ip>`: restringe
o SSH a essa origem e isenta-a do fail2ban.

### Passo 3b — Disco de dados (só se a VPS tiver um segundo disco)

O bootstrap diz-te se detectou discos livres. Se sim e quiseres dedicá-los aos
dados — ver [Disco dedicado aos dados](#disco-dedicado-aos-dados-opcional):

```bash
./prepare-data-disk.sh                      # relatório, não altera nada
./prepare-data-disk.sh --device /dev/sdb    # APAGA TUDO nesse disco
```

Fazê-lo **antes** do passo 4 evita ter de migrar dados depois.

### Passo 4 — Plataforma

```bash
./install-platform.sh --yes

# Copia os segredos para o gestor de passwords AGORA.
# Sem TENANT_ENCRYPTION_SECRET, nenhuma base de tenant volta a ser acessível.
cat /opt/spharmmt/secrets/platform.secrets.env
```

### Passo 5 — Validar o acesso ANTES de fechar a sessão root

**Numa segunda janela do terminal**, com a sessão root ainda aberta:

```powershell
ssh -i $env:USERPROFILE\.ssh\spharmmt_prod deploy@<IP_DA_VPS> "whoami; sudo -n true || echo 'sudo pede password (normal)'"
```

Tem de devolver `deploy`. **Só depois disto podes fechar a sessão root.**

### Passo 6 — Validação final e reboot

```bash
sudo /opt/spharmmt/scripts/verify-platform.sh     # tem de dar 0 falhas
sudo reboot
# esperar ~40s, voltar a entrar e revalidar:
sudo /opt/spharmmt/scripts/verify-platform.sh
```

Um servidor que valida mas não sobrevive a um reboot não está pronto.

### Passo 7 (opcional, só depois de 5 e 6 passarem) — desactivar o root

```bash
sudo /opt/spharmmt/scripts/bootstrap-vps.sh --disable-root-login --skip-upgrade --yes
```

Só faz isto se a consola de emergência do passo 0 estiver confirmada.

### Passo 8 — Stack aplicacional

A partir do **checkout do repositório** (não de `/opt/spharmmt/scripts`: o
`install-stack.sh` precisa do `Dockerfile`, do compose e dos scripts de init
que estão ao lado dele).

```bash
cd /tmp/spharmmt && git pull
cd deploy/scripts && sudo ./install-stack.sh --yes
```

O primeiro build demora — `npm ci`, `next build` e o Chromium do puppeteer.
A sequência é: código → artefactos → segredos derivados → `stack.env` →
build → PostgreSQL → **migrations num container próprio** → web, worker e
proxy → validação.

No fim, `verify-platform.sh` tem de dar 0 falhas e o acesso faz-se por túnel
SSH, porque as portas 80/443 continuam fechadas:

```powershell
ssh -i $env:USERPROFILE\.ssh\spharmmt_prod -L 8080:127.0.0.1:8080 deploy@<IP_DA_VPS>
# e abrir http://127.0.0.1:8080 no browser
```

### Passo 9 — Abrir ao exterior (só depois de o passo 8 validar)

```bash
sudo sed -i 's/^PROXY_BIND=.*/PROXY_BIND=0.0.0.0/;s/^PROXY_HTTP_PORT=.*/PROXY_HTTP_PORT=80/' \
  /opt/spharmmt/docker/env/stack.env
sudo ufw allow 80/tcp
sudo /opt/spharmmt/scripts/update-platform.sh --no-build --skip-backup
```

O que fecha a porta é o **endereço de bind**, não a UFW: o Docker escreve
regras iptables avaliadas antes das dela, e um `ports: 80:80` fica acessível
à Internet mesmo com a UFW a negar.

---

## Stack aplicacional

Cinco serviços, dos quais quatro sobem com a stack:

| Serviço | Imagem | Exposto? | Notas |
|---|---|---|---|
| `postgres` | `postgres:17.6-bookworm` | **Não** — sem `ports:` | Dados em `/data/postgres/data`, afinado para 8 GB, `--data-checksums` |
| `web` | `spharmmt-app:local` | Não — só o proxy lhe fala | Next standalone, utilizador não-root (UID 10001) |
| `worker` | **a mesma** imagem da web | Não | Scheduler local; `SCHEDULER_ENABLED=0` |
| `proxy` | `nginx:1.29-alpine` | `127.0.0.1:8080` | Único ponto de entrada |
| `migrate` | `spharmmt-app:local-migrator` | — | Perfil `tools`; corre e termina |

### Ficheiros de configuração, e quem é dono de cada um

| Ficheiro | Escrito por | Papel |
|---|---|---|
| `/etc/spharmmt/platform.conf` | `install-platform.sh` | Caminhos e limiares, lido por todos os scripts |
| `docker/env/platform.env` | `install-platform.sh` | Configuração de **runtime**, entregue dentro dos containers |
| `docker/env/stack.env` | `install-stack.sh` | Só **interpolação** do compose (contexto de build, tag, bind) |
| `secrets/platform.secrets.env` | `install-platform.sh` | **Fonte de verdade** dos segredos. Nunca regenerada |
| `secrets/postgres.secrets.env` | `install-stack.sh` | Derivado: 2 chaves, só para o PostgreSQL |
| `secrets/app.secrets.env` | `install-stack.sh` | Derivado: 6 chaves, sem a password de superutilizador |

São dois ficheiros de ambiente e não um porque o `install-platform.sh`
reescreve o `platform.env` por inteiro a cada execução: chaves da stack
escritas lá desapareciam na reinstalação seguinte da plataforma.

Os ficheiros derivados existem para dar a cada serviço só o que ele precisa.
O PostgreSQL não vê `TENANT_ENCRYPTION_SECRET` (que decifra as credenciais
de **todos** os tenants) e a aplicação não vê a password de superutilizador.

### Segredos e `docker compose config`

`docker compose config` **lê os `env_file` e imprime os valores** dentro de
`environment:`. Para inspeccionar ou colar num relatório:

```bash
docker compose -f /opt/spharmmt/docker/compose/docker-compose.yml -p spharmmt \
  --env-file /opt/spharmmt/docker/env/platform.env \
  --env-file /opt/spharmmt/docker/env/stack.env \
  config --no-env-resolution
```

### Migrations

Nunca correm durante o `build` nem no arranque do servidor web. Correm num
container próprio (`migrate`), uma vez, e o código de saída decide se a stack
sobe. Ordem: control plane → base legacy → bases de tenant (a ausência de
tenants não é erro).

```bash
cd /opt/spharmmt/docker/compose
sudo docker compose -p spharmmt --profile tools \
  --env-file /opt/spharmmt/docker/env/platform.env \
  --env-file /opt/spharmmt/docker/env/stack.env \
  run --rm migrate
```

### Scheduler

Desligado. O worker arranca, diz que está desligado e fica ocioso.

```bash
# Ver o plano
docker exec spharmmt-worker node scripts/workers/scheduler.mjs --list

# Disparar um job à mão (ignora SCHEDULER_ENABLED de propósito —
# é assim que se valida antes de ligar)
docker exec spharmmt-worker node scripts/workers/scheduler.mjs --once refresh-ipf

# Ligar, quando os dados estiverem migrados e validados
sudo sed -i 's/^SCHEDULER_ENABLED=.*/SCHEDULER_ENABLED=1/' /opt/spharmmt/docker/env/platform.env
sudo /opt/spharmmt/scripts/update-platform.sh --no-build --service worker
```

O plano deste worker e o `vercel.json` têm de ser mudados em conjunto —
divergirem significa que um alojamento faz o que o outro não faz.

### Server Actions atrás do proxy

Duas coisas distintas, e ambas davam `Invalid Server Actions request`.

**1. O `Host` estava a ser reescrito.** Em nginx, **um** `proxy_set_header`
dentro de um `location` **cancela a herança de todos** os do nível acima.
O `location /` tinha um, e com ele perdia o `Host`: o nginx caía no
default `$proxy_host` e a aplicação recebia `Host: spharmmt_web` — o nome
do bloco `upstream`.

```
location /          →  host=spharmmt_web   xfh=(vazio)     ← partido
location /_next/…   →  host=127.0.0.1      xfh=127.0.0.1   ← correcto
```

Isto também partia, em silêncio, a resolução de tenant por subdomínio.
**Não acrescentar `proxy_set_header` a um `location` sem repetir todos os
do bloco `server`** — há um teste que o impede.

**2. `SERVER_ACTIONS_ALLOWED_ORIGINS`.** O Next compara o `Origin` do
browser com o `Host`; atrás de um proxy divergem de forma legítima
(acesso por IP, por túnel SSH, por um domínio que o container não
conhece). A lista é a excepção explícita.

| | |
|---|---|
| Formato | CSV, sem protocolo: `127.0.0.1:8080,164.132.85.211,app.spharm.pt,*.app.spharm.pt` |
| Onde se edita | `docker/env/platform.env` |
| Quando tem efeito | **só depois de reconstruir a imagem** — o Next fixa-a no bundle do servidor |
| Curinga global | recusado (`*`, `**`, `*:*`) pelo próprio build e pelo `install-stack.sh` |
| Curinga de subdomínio | permitido (`*.app.spharm.pt`) |
| Sem a variável, em produção | usa o host de `PUBLIC_APP_URL`; se também faltar, **o build falha** |

Falhar o build é deliberado: mais vale isso do que entregar uma imagem
onde ninguém consegue autenticar-se.

Mudar a lista:

```bash
sudo nano /opt/spharmmt/docker/env/platform.env    # SERVER_ACTIONS_ALLOWED_ORIGINS=
cd /tmp/spharmmt/deploy/scripts && sudo ./install-stack.sh --yes
```

Verificar o que a imagem aceita, sem a desmontar:

```bash
sudo docker compose -p spharmmt exec -T web \
  sh -c 'grep -o "\"allowedOrigins\":\[[^]]*\]" .next/required-server-files.json'
```

### Primeiro administrador global

A tabela `GlobalAdmin` do control plane nasce vazia, e não há forma de a
preencher pela aplicação — quem entraria para o fazer ainda não existe.

```bash
cd /opt/spharmmt/docker/compose
sudo docker compose -p spharmmt --profile tools \
  --env-file /opt/spharmmt/docker/env/platform.env \
  --env-file /opt/spharmmt/docker/env/stack.env \
  run --rm -T migrate \
  npm run --silent control:create-global-admin -- \
    --email admin@spharm.pt --nome "Administrador Global" --yes
```

Sem `-T` há terminal e a password é pedida em **prompt oculto**, duas
vezes. Com `-T` (ou em automação) é lida do **stdin, em duas linhas**:

```bash
printf '%s\n%s\n' "$PW" "$PW" | sudo docker compose ... run --rm -T migrate \
  npm run --silent control:create-global-admin -- --email ... --nome ... --yes
```

Nunca por argumento: argumentos ficam no histórico da shell, no `ps` de
qualquer utilizador da máquina e nos logs do sudo.

Confirmar sem revelar o hash:

```bash
sudo docker compose -p spharmmt exec -T postgres \
  psql -U postgres -d spharmmt_control -c \
  'SELECT id, email, nome, estado, "createdAt" FROM "GlobalAdmin" ORDER BY "createdAt"'
```

Regras do script, e nenhuma é acidental:

| Regra | Porquê |
|---|---|
| só cria com a tabela **vazia** | acrescentar outro exige `--allow-existing`, explícito |
| **nunca** redefine passwords | um script de bootstrap que repõe credenciais é escalonamento de privilégios à espera de acontecer |
| **nunca** faz upsert | ou cria uma linha nova, ou falha e diz porquê |
| mostra o destino e exige confirmação | `dotenv` carrega o `.env` do repositório, que numa máquina de desenvolvimento aponta para **produção** |
| só `CONTROL_DATABASE_URL` | a base legacy nunca é aberta |
| bcrypt custo 10 | o mesmo do login; mínimo 8 caracteres, a mesma política da aplicação |

Códigos de saída: `0` criado · `1` uso · `2` sem `CONTROL_DATABASE_URL` ·
`3` já há admins · `4` password inválida ou confirmação diferente ·
`5` email já registado · `6` falha de base de dados · `7` destino não
confirmado.

Testado de ponta a ponta em `deploy/tests/live-global-admin.sh`
(PostgreSQL descartável; precisa de Docker):

```bash
./deploy/tests/live-global-admin.sh
```

### Dono do PGDATA

`/data/postgres/data` **não pertence ao `deploy`.** Pertence ao utilizador
`postgres` da imagem — uid **999** em `postgres:17-bookworm`.

```
2700 deploy:spharmmt  →  o cluster arranca (o entrypoint é root)
                      →  PANIC: could not open control file "pg_control":
                         Permission denied
                      →  FATAL: could not stat data directory
```

Uma base que arranca bem e morre no primeiro checkpoint é o pior modo de
falha: a mensagem não aponta para permissões e já há tráfego em cima.

Regras, todas em `ensure_pgdata_dir` (`lib/common.sh`), usada pelo
`bootstrap-vps.sh`, `install-platform.sh`, `prepare-data-disk.sh` e
`install-stack.sh`:

- modo **0700**, dono **uid 999**;
- o uid vem da **imagem configurada** (`pg_image_uid_gid`), não é assumido,
  e fica gravado em `platform.conf` (`SPHARMMT_PG_UID`/`_GID`);
- **nenhum script toca no PGDATA com o PostgreSQL a correr.** Avisa e não
  mexe — um `chown` a quente não falha na altura e leva o servidor a PANIC
  no checkpoint seguinte. Para corrigir: parar a stack, correr o script,
  voltar a subir.

Só o **uid** é verificado. O entrypoint da imagem faz `chown postgres` sem
grupo, portanto um cluster criado de raiz fica `999:0` e um corrigido à mão
fica `999:999` — os dois funcionam, e com 0700 o grupo não tem acesso
nenhum. Exigir gid 999 reprovaria qualquer instalação nova.

O `verify-platform.sh` compara o uid numérico e corre um `CHECKPOINT`
explícito, que é o único teste que distingue "configurado bem" de
"consegue mesmo escrever".

Reproduzido de ponta a ponta em `deploy/tests/live-pgdata.sh` (cluster a
sério, volume descartável; precisa de Docker):

```bash
./deploy/tests/live-pgdata.sh
```

### Permissões do reverse proxy

| Caminho | Modo | Porquê |
|---|---|---|
| `proxy/conf` | **0755** | Configuração pública. O nginx do container é outro uid e tem de a atravessar |
| `proxy/conf/*.conf` | **0644** | Idem |
| `proxy/certs` | 0750 | Restrito — é aqui que vivem chaves privadas |
| `proxy/certs/*.key`, `privkey*.pem` | 0640 ou mais restrito | Aplicado por `enforce_tls_key_modes` |

A política genérica **2750 não serve** para `proxy/conf`, e a razão não é
óbvia: o processo master do nginx arranca como root, mas o compose faz
`cap_drop: ALL` — e `DAC_OVERRIDE`, a capability que deixa o root ignorar
os bits de permissão, vai nesse lote. Sem ela, o uid 0 é tratado como
"others" sobre um directório do uid 1000:

```
/opt/spharmmt/proxy/conf  2750 deploy:spharmmt
→ ls /etc/nginx/conf.d: Permission denied
→ nenhum server {} carregado
→ o nginx arranca e não escuta na porta 80
→ healthcheck: Connection refused
```

O nginx **arranca na mesma** e o `nginx -t` **passa** — verificado: um
`conf.d` vazio é sintaxe válida. É por isso que o `install-stack.sh`
valida o conteúdo e as permissões, e prova o acesso com o utilizador
`nginx` real, **antes** de recriar o container.

Reproduzido de ponta a ponta em `deploy/tests/live-proxy.sh` (containers
a sério; precisa de Docker, corre-se à mão):

```bash
./deploy/tests/live-proxy.sh
```

### Origens das Server Actions: por que o build tem de falhar

`SERVER_ACTIONS_ALLOWED_ORIGINS` é a única configuração que **não** pode
ser lida em runtime: o Next fixa `allowedOrigins` no bundle do servidor.
Mudá-la obriga a **reconstruir a imagem** — um `docker compose up` não
chega.

O caminho tem cinco elos:

```
platform.env  →  install-stack.sh  →  stack.env  →  build arg  →  ARG/ENV  →  bundle
 (o operador)      (lê e valida)      (compose)     (compose)    (Dockerfile)
```

Já se partiu duas vezes, e nenhuma das duas aparecia num grep:

1. uma crase num comentário dentro do heredoc `<<EOF` matava o
   instalador no passo 4 — o `stack.env` nunca chegava a ser escrito, e
   o build seguia sem as variáveis. Coberto agora por
   `deploy/tests/test-heredoc-safety.sh`;
2. o serviço `migrate` não passava os build args. **O `migrate` também
   precisa deles**: o stage `migrator` faz `COPY --from=builder`,
   portanto construí-lo corre o `npm run build` — e sem origens esse
   build falha, com um erro que parece das migrations.

O `install-stack.sh` verifica agora a propagação **no `docker compose
config` já interpolado**, antes de iniciar o build: ver a sintaxe
`${VAR:-}` no ficheiro não prova que o valor chega lá.

Prova de ponta a ponta, com imagens verdadeiras (precisa de Docker,
corre-se à mão):

```bash
./deploy/tests/live-build-args.sh
```

Constrói os dois targets, lê o `required-server-files.json` de dentro da
imagem e confirma que, com as variáveis vazias, **ambos os builds
falham**.

### Comandos de administração (perfil `tools`)

Os utilitários que já existiam continuam a ser **os** comandos. Não há
fluxo paralelo nem versão self-hosted de nada: o que muda é onde correm.

```bash
sudo docker compose --profile tools run --rm migrate npm run <comando> -- <flags>
```

O que a imagem `migrator` serve está listado, um por linha, em
[`deploy/docker/tools-scripts.txt`](docker/tools-scripts.txt). Essa lista
não é decorativa: o build resolve cada comando no `package.json`, segue o
**fecho transitivo dos imports** e falha se algum ficheiro não estiver na
imagem.

```
[audit-tools] 22 entrypoints e 100 módulos verificados, todos presentes
```

Foi assim que se descobriu que `tenant:create` — o comando oficial de
criação de clientes — apontava para `scripts/admin/create-client.ts`, que
o Dockerfile não copiava. O sintoma aparecia só na VPS, a meio do
onboarding:

```
ERR_MODULE_NOT_FOUND: /app/scripts/admin/create-client.ts
```

Para saber que ficheiros um comando novo arrasta consigo:

```bash
node deploy/docker/audit-tools-entrypoints.mjs . --list
```

**Suportado na imagem**: `db:migrate:deploy`, `control:*`, `tenancy:*`,
`tenant:create`, `tenancy:create`, `tenant:onboard`,
`admin:reset-user-password`, `env:doctor`.

**Deliberadamente fora**: `agent:*` (corre na farmácia), `admin-wizard:*`
(PowerShell, máquina do operador), `catalog:*` (entra quando o catálogo
entrar), `ingest:*` (manutenção pontual), `test:*`/`lint`/`typecheck`/
`dev`/`build`/`start` (desenvolvimento), `scheduler` (corre no `runner`).

### Credenciais administrativas: `POSTGRES_ADMIN_URL`

`tenant:create --provider=local --create-db` faz `CREATE ROLE` e
`CREATE DATABASE`. Isso exige superutilizador — que o utilizador da
aplicação não tem, e não deve ter.

A ligação administrativa é **derivada em memória pelo entrypoint**, só
nos modos de ferramentas, a partir de `POSTGRES_SUPERUSER_PASSWORD`:

```
secrets/tools.secrets.env   0600 root:root   montado SÓ pelo serviço migrate
        │
        └── entrypoint.sh → POSTGRES_ADMIN_URL (+ TENANT_DB_HOST/PORT)
```

Consequências, e são o ponto:

- o URL **não existe em ficheiro nenhum** — nem no `stack.env`, nem no
  `platform.env`, nem dentro da imagem;
- não aparece em `docker compose config`, que é o output que se cola nas
  mensagens a pedir ajuda;
- o `web` e o `worker` não montam o ficheiro de onde ele sai, e o
  entrypoint ainda lhes limpa `POSTGRES_ADMIN_URL`,
  `POSTGRES_SUPERUSER_PASSWORD` e `POSTGRES_SUPERUSER` antes de arrancar.
  Um erro de configuração deixa de ser uma escalada de privilégio;
- o container é `--rm`: quando termina, o ambiente vai com ele.

O contrato do CLI não mudou. `--provider=neon` e `--provider=manual`
continuam a funcionar exactamente como antes, e sem superutilizador
nenhum.

### Admin Wizard contra a VPS: o acesso por IP NÃO chega

O wizard autentica-se com `ADMIN_API_TOKENS` — um bearer token enviado em
**todos** os pedidos, incluindo os que criam clientes e devolvem senhas e
ingest keys. Em HTTP simples, esse token e esses segredos viajam em claro
por toda a rede entre o técnico e o servidor.

Portanto, uma de duas, e não há terceira:

**Túnel SSH** (o que usar já, antes de haver domínio):

```bash
ssh -L 8080:127.0.0.1:8080 deploy@<ip-da-vps>
# no wizard: endpoint = http://127.0.0.1:8080
```

O `PROXY_BIND=127.0.0.1` do `platform.env` garante que não há mais nada a
escutar de fora — o túnel é a única porta.

**HTTPS público** (quando houver domínio): descomentar o bloco TLS em
`proxy/spharmmt.conf`, pôr os certificados em `/opt/spharmmt/proxy/certs`,
`PROXY_BIND=0.0.0.0`, `SESSION_COOKIE_SECURE=1` e
`PUBLIC_APP_URL=https://…`.

**Abrir o porto 8080 ao mundo sem TLS não é uma alternativa aceitável**:
expõe o token de administração da plataforma inteira a qualquer
intermediário de rede.

### Criar o primeiro tenant

```bash
sudo docker compose --profile tools run --rm migrate \
  npm run --silent tenant:create -- \
    --slug sier \
    --name "SIER" \
    --admin-email <email-do-administrador> \
    --farmacias "Farmácia A,Farmácia B" \
    --provider=local --create-db
```

Correr **primeiro com `--dry-run`**: valida tudo e não escreve nada.

A senha do administrador e a ingest key são impressas **uma única vez**.
Omitir `--admin-password` para que seja gerada.

Depois:

```bash
# schema da base do tenant
... run --rm migrate npm run --silent tenancy:migrate-all

# confirmar
... run --rm migrate npm run --silent tenancy:list
... run --rm migrate npm run --silent tenancy:status -- --tenant sier
... run --rm migrate npm run --silent tenancy:health
```

Enquanto não houver subdomínios, o acesso faz-se por
`http://<host>:8080/login?__tenant=sier` — exige
`TENANT_FALLBACK_ENABLED=1` no `platform.env`.

O ciclo completo — criar, migrar, listar, farmácias, utilizadores, reset
de senha, ingest key, acesso HTTP, desactivar, reactivar — está coberto
por um teste que levanta uma stack inteira e descartável:

```bash
./deploy/tests/live-tenant-lifecycle.sh    # 33 verificações
```

### Guarda do `refresh-ipf`

`REFRESH_IPF_MULTI_TENANT_ENABLED` decide o fluxo do
`/api/jobs/refresh-ipf`. **A 0 por defeito, e a ausência da variável
também conta como 0.**

| Valor | Fluxo |
|---|---|
| ausente, `0`, `false`, `no` | **legacy** single-DB contra `DATABASE_URL` — exactamente o que corre hoje na Vercel |
| `1`, `true`, `yes` | multi-tenant: itera os tenants ACTIVE, com `SyncRun` e lock |

A resposta traz `"mode": "legacy"` ou `"mode": "multi-tenant"`, o que
permite confirmar o fluxo activo sem entrar no servidor:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:8080/api/jobs/refresh-ipf?dry=1" | grep -o '"mode":"[^"]*"'
```

O mesmo build corre na Vercel, onde o cron continua agendado. Sem esta
guarda, o disparo seguinte mudaria de comportamento sozinho — passaria a
escrever nas bases dos tenants em vez da base actual, sem ninguém ter
decidido isso.

Ligar só depois de, **por esta ordem**: catálogo instalado, tenants reais
criados, jobs validados à mão com `--once`, `SCHEDULER_ENABLED=1` nesta
VPS, e o cron equivalente da Vercel desligado. Ligar antes do último
ponto põe dois schedulers a escrever nas mesmas bases.

```bash
sudo sed -i 's/^REFRESH_IPF_MULTI_TENANT_ENABLED=.*/REFRESH_IPF_MULTI_TENANT_ENABLED=1/' \
  /opt/spharmmt/docker/env/platform.env
sudo /opt/spharmmt/scripts/update-platform.sh --no-build --service web
```

---

## Recuperação se a nova sessão SSH falhar

Sintoma: `ssh deploy@<ip>` devolve `Permission denied (publickey)` ou fica em
timeout.

**Se ainda tens a sessão root aberta** — é para isso que ela existe:

```bash
# 1. Ver o que o sshd está mesmo a aplicar (a config efectiva, não o ficheiro)
sshd -T | grep -iE 'passwordauthentication|permitrootlogin|allowusers|pubkey|port'

# 2. Ver a razão exacta da recusa, em tempo real (tenta ligar noutra janela)
journalctl -u ssh -f

# 3. Confirmar que a chave está onde deve, com as permissões certas
ls -la ~deploy/.ssh/
ssh-keygen -l -f ~deploy/.ssh/authorized_keys      # tem de listar a tua chave

# 4. Foste banido pelo fail2ban? (3 tentativas falhadas = 2h)
fail2ban-client status sshd
fail2ban-client set sshd unbanip <O_TEU_IP>

# 5. Desfazer o endurecimento (volta a aceitar password)
rm -f /etc/ssh/sshd_config.d/99-spharmmt-hardening.conf
sshd -t && systemctl reload ssh

# 6. Firewall a bloquear?
ufw status verbose
ufw disable        # último recurso, reactivar depois
```

**Se já não tens sessão nenhuma** — abre a consola de emergência do painel do
fornecedor, entra como root e corre os passos 5 e 6 acima. Se a consola não
der login, arranca em **rescue mode**, monta o disco e apaga
`/etc/ssh/sshd_config.d/99-spharmmt-hardening.conf`.

**Se nada disto resolver**, restaura o snapshot do passo 1. É por isso que ele
existe.

Causas mais frequentes, por ordem: chave pública colada incompleta (falta o
fim da linha), `authorized_keys` com permissões erradas (tem de ser `600`, e
`.ssh` `700`), ban do fail2ban, e firewall de rede do fornecedor.

---

## Opções mais usadas

```bash
# Restringir o SSH ao IP do escritório (e isentá-lo do fail2ban)
sudo ./bootstrap-vps.sh --ssh-key "..." --admin-ip 203.0.113.10 --yes

# Ver o que faria, sem alterar nada
sudo ./bootstrap-vps.sh --dry-run --ssh-key "..."

# Re-execução (idempotente) sem repetir o dist-upgrade
sudo ./bootstrap-vps.sh --skip-upgrade --yes

# Já com domínio: activa o cookie de sessão seguro
sudo ./install-platform.sh --public-url https://app.spharmmt.app --yes
```

---

## Os scripts

| Script | O que faz | Destrutivo? |
|---|---|---|
| `bootstrap-vps.sh` | SO, timezone/locale/hostname, swap, unattended-upgrades, utilizador `deploy`, UFW, SSH por chave, fail2ban, Docker, `/opt/spharmmt`, permissões, logs, monitorização, backups | Não |
| `install-docker.sh` | Docker Engine + Compose v2 do repositório oficial, `daemon.json`, grupo, rede | Não |
| `install-platform.sh` | Configuração central, segredos, `platform.env`, scripts operacionais, timer de backup, sobe a stack se existir | Não |
| `prepare-data-disk.sh` | Deteta discos livres (read-only por defeito); com `--device`, prepara um disco dedicado aos dados: GPT, ext4, `/data`, fstab por UUID | **Sim, com `--device`** |
| `install-stack.sh` | PostgreSQL + web + worker + proxy: código, artefactos, segredos derivados, build, migrations, arranque, validação. **Corre a partir do checkout**, não de `/opt` | Não |
| `verify-platform.sh` | Checklist de 12 secções sobre todo o servidor | Não (só lê) |
| `update-platform.sh` | Backup → snapshot de imagens → pull/build → up → espera healthchecks → rollback automático se falhar | Sim (com rollback) |
| `backup-platform.sh` | `pg_dump -Fc` por base + globals + config, checksums, manifesto, retenção | Não |
| `restore-platform.sh` | Restauro verificado, com dump de segurança prévio | **Sim** |
| `healthcheck.sh` | Sonda de 15 em 15 min (disco, RAM, CPU, serviços, containers, PG, backups) | Não |
| `lib/common.sh` | Biblioteca partilhada: logging, idempotência, checks, locks, códigos de saída | — |

### Contrato comum

Todos os scripts (excepto `healthcheck.sh`, deliberadamente auto-contido):

- **Param ao primeiro erro** — `set -Eeuo pipefail` + trap `ERR` que imprime
  ficheiro, linha e comando exactos.
- **Produzem log** em `/var/log/spharmmt/<script>-<timestamp>.log`, com
  symlink `-latest.log`. Cai para `/tmp` se não houver permissões.
- **Validam pré-condições** antes de tocar em nada (root, SO, comandos,
  espaço em disco, estado dos serviços).
- **Validam pós-condições** e terminam com relatório de checks.
- **São idempotentes** — correr duas vezes não destrói nada. Ficheiros só são
  reescritos quando o conteúdo muda, e sempre com backup `.spharmmt-bak-<ts>`.
- **Usam lock** (`flock`) — duas execuções em simultâneo não se atropelam.
- **Aceitam** `--dry-run`, `--yes`, `--verbose`, `--no-color`, `--help`.

### Códigos de saída

| Código | Significado |
|---|---|
| 0 | Sucesso |
| 1 | Erro de execução |
| 2 | Pré-condição não satisfeita |
| 3 | Pós-condição falhou (correu, mas o resultado não valida) |
| 4 | Uso incorrecto |
| 5 | Outra instância a correr |
| 6 | Abortado pelo operador |

---

## Operação corrente

```bash
# Estado do servidor
sudo /opt/spharmmt/scripts/verify-platform.sh
sudo /opt/spharmmt/scripts/verify-platform.sh --section seguranca
sudo /opt/spharmmt/scripts/verify-platform.sh --json /tmp/estado.json

# Healthcheck agora + histórico
sudo -u deploy /opt/spharmmt/monitoring/checks/healthcheck.sh
tail -50 /opt/spharmmt/logs/monitoring/healthcheck.log
systemctl list-timers 'spharmmt-*'

# Backup manual
sudo /opt/spharmmt/scripts/backup-platform.sh
sudo /opt/spharmmt/scripts/backup-platform.sh --only spharmmt_control --label pre-migracao

# Restauro
sudo /opt/spharmmt/scripts/restore-platform.sh --list
sudo /opt/spharmmt/scripts/restore-platform.sh --set 20260804-032000 --database spharmmt_control

# Actualização
sudo /opt/spharmmt/scripts/update-platform.sh          # stack
sudo /opt/spharmmt/scripts/update-platform.sh --os     # stack + SO
sudo /opt/spharmmt/scripts/update-platform.sh --rollback
```

---

## Disco dedicado aos dados (opcional)

Numa VPS com dois discos — sistema em `/dev/sda`, um segundo disco vazio em
`/dev/sdb` — vale a pena dedicar o segundo aos dados. A aplicação e a
configuração ficam pequenas e recriáveis em `/opt/spharmmt`; o que cresce
(PostgreSQL, backups) fica isolado num volume próprio, que se pode redimensionar,
snapshotar ou mover sem tocar no sistema.

**Nada disto acontece automaticamente.** O `bootstrap-vps.sh` deteta discos
livres, diz que existem e como usá-los — e não lhes toca. Formatar é sempre um
comando separado e deliberado.

```bash
# 1. Ver o que existe. READ-ONLY, não altera nada.
sudo /opt/spharmmt/scripts/prepare-data-disk.sh

# 2. Preparar o disco escolhido. APAGA TUDO nesse disco.
sudo /opt/spharmmt/scripts/prepare-data-disk.sh --device /dev/sdb

# 3. Fazer a plataforma passar a usá-lo
sudo /opt/spharmmt/scripts/install-platform.sh --yes
sudo /opt/spharmmt/scripts/verify-platform.sh
```

O passo 2 cria GPT → uma partição → ext4 (label `spharmmt-data`) → monta em
`/data` → escreve no `/etc/fstab` **por UUID** → valida → cria
`/data/postgres`, `/data/docker`, `/data/backups`.

### Como o disco é recusado

O script só aceita um disco **completamente** vazio. Aborta, dizendo porquê,
se detetar: partições, filesystem, assinatura de LVM/RAID/LUKS, montagem
activa, holders no `/sys`, uso como swap, se não for um disco inteiro (tem de
ser `/dev/sdb`, não `/dev/sdb1`), se for o disco do sistema, ou se tiver menos
de 10 GiB. Não sabe distinguir lixo do backup de alguém — por isso não tenta.

A confirmação exige escrever o caminho exacto do dispositivo. `--yes` **não
chega**: é preciso também `--confirm-erase`, para que nenhuma automação apague
um disco por arrastamento.

### Onde ficam as coisas

| | Sem disco dedicado | Com disco dedicado |
|---|---|---|
| Aplicação, configuração, segredos, scripts | `/opt/spharmmt` | `/opt/spharmmt` |
| PostgreSQL | `/opt/spharmmt/postgres` | `/data/postgres` |
| Backups | `/opt/spharmmt/backups` | `/data/backups` |
| Docker data-root | `/var/lib/docker` | `/var/lib/docker` (`/data/docker` reservado) |

A resolução é feita em `lib/common.sh` e fixada em `platform.conf` pelo
`install-platform.sh`. **Sem disco dedicado, todos os caminhos ficam exactamente
onde sempre estiveram** — a alteração é retrocompatível.

`/data/docker` é criado mas **não** é usado: mudar o data-root do Docker obriga
a parar o daemon e mover dados, e este pacote nunca move dados.

### A falha que esta arquitectura introduz

Se `/data` não montar num arranque, o directório continua a existir — é o ponto
de montagem. As escritas passam a ir para o disco de sistema **sem erro
nenhum**, enchem-no, e no arranque seguinte esses dados ficam invisíveis por
baixo da montagem.

Contra isso: `require_data_root_mounted()` corre antes de qualquer escrita no
`backup-platform.sh`, `restore-platform.sh` e `install-platform.sh`; o
`healthcheck.sh` reporta **CRIT** e o `verify-platform.sh` falha se o volume
estiver configurado e desmontado. A montagem usa `nofail`, para que um disco
avariado não deixe a máquina presa no boot sem acesso SSH.

### Migrar dados já existentes

Não é automático, por desenho. Se já houver dados em `/opt/spharmmt` quando o
disco entrar ao serviço, o `install-platform.sh` avisa e imprime o `rsync`
sugerido — mas a decisão sobre qual é a fonte de verdade, e com a stack parada,
é do operador.

## Estrutura em disco

```
/opt/spharmmt/                  aplicação e configuração (pequeno, recriável)
├── app/            código/artefactos da aplicação
├── logs/           app/ postgres/ proxy/ monitoring/ backups/
├── docker/         compose/ · env/ · build/
├── proxy/          conf/ · certs/
├── scripts/        os scripts operacionais + lib/
├── monitoring/     checks/ · state/
└── secrets/        0700 root:root — platform.secrets.env

<DATA_ROOT>/                    dados (o que cresce)
├── postgres/       data/ (volume, 0700) · conf/ · init/
├── backups/        postgres/{daily,weekly,monthly} · files/ · tmp/ · POLICY.md
└── docker/         reservado para o data-root do Docker (não aplicado)

/etc/spharmmt/platform.conf     configuração central (lida por todos os scripts)
/var/log/spharmmt/              logs dos scripts
```

`<DATA_ROOT>` é `/data` quando há disco dedicado e `/opt/spharmmt` quando não
há — ver [Disco dedicado aos dados](#disco-dedicado-aos-dados-opcional).

### Política de permissões

Owner `deploy:spharmmt`, `umask 027`. Os modos **não são uniformes** — cada
diretório tem a expectativa que faz sentido para o que guarda, e o
`verify-platform.sh` verifica cada um pela sua regra:

| Caminho | Modo | Owner | Porquê |
|---|---|---|---|
| `/opt/spharmmt` e subdirectórios | `2750` | `deploy:spharmmt` | setgid para o grupo ser herdado pelo conteúdo criado por qualquer membro |
| `secrets/` | `0700` **sem setgid** | `root:root` | não há grupo a herdar; o setgid só alargaria a superfície. O `deploy` lê com sudo |
| `secrets/*` (ficheiros) | `0600` | `root:root` | sem excepções; qualquer excepção futura fica documentada em `enforce_secret_file_modes()` |
| `postgres/data` | `0700` ou `2700` | `deploy:spharmmt` | o PostgreSQL só recusa bits de grupo/others (`S_IRWXG\|S_IRWXO`); o setgid não entra nessa máscara |
| `backups/postgres` | `0700` ou `2700` | `deploy:spharmmt` | idem |
| `docker/env/` | `2750` | `deploy:spharmmt` | lido pelo `deploy` ao subir a stack |

**Armadilha do `chmod`, que já custou uma divergência real:** o GNU chmod
**preserva** setuid/setgid em *directórios* quando o modo é numérico — mesmo
com 4 dígitos. Sobre um directório `2750`, `chmod 0700` deixa `2700`. E um
directório criado dentro de um pai com setgid herda-o logo no `mkdir`. Por
isso `ensure_dir()` limpa os bits especiais com `chmod a-s` antes de aplicar
um modo que não os inclui — sem isso, `ensure_dir .../secrets 0700` produzia
`2700` silenciosamente.

Os UID/GID de `postgres/data` serão revistos quando o container PostgreSQL
for introduzido.

---

## Decisões e porquê

**Ordem: firewall → SSH → root.** Cada passo só fecha uma via de acesso depois
de a seguinte estar provada. A regra de SSH entra na UFW antes do `enable`; a
password só é desligada quando existe uma chave pública válida; o root só é
desactivado com flag explícita e com o `deploy` já validado. Qualquer alteração
ao `sshd` passa por `sshd -t` e é revertida automaticamente se inválida, e usa-se
`reload` em vez de `restart` para nunca derrubar a sessão em curso.

**UTC no sistema operativo.** Evita saltos de DST em cron e backups e alinha com
os crons que já estavam definidos em UTC. A apresentação em hora local é
responsabilidade da aplicação.

**Docker do repositório oficial, com `daemon.json` obrigatório.** Sem
`log-opts`, um container verboso enche os 125 GB — é a causa nº1 de disco cheio
em hosts Docker. `live-restore` mantém os containers vivos durante um restart do
daemon.

**Docker fura o UFW.** O Docker escreve regras de iptables avaliadas *antes* das
do UFW: um container publicado em `0.0.0.0` fica exposto à internet apesar de o
`ufw status` dizer "deny". A protecção é publicar sempre em `127.0.0.1:porta:porta`
— e o `verify-platform.sh` verifica-o explicitamente (secção 2, "PostgreSQL NÃO
exposto em 0.0.0.0").

**`backend = systemd` no fail2ban.** A configuração default lê `/var/log/auth.log`,
que pode não existir na 24.04 — o que parte a jail silenciosamente. O `banaction = ufw`
mantém os bans dentro da firewall em vez de criar cadeias iptables paralelas.

**Segredos gerados uma vez, nunca regenerados.** `TENANT_ENCRYPTION_SECRET`
decifra as passwords de todas as bases de tenant; regenerá-lo tornaria os
tenants inacessíveis de forma irreversível. Numa segunda execução só são
acrescentadas as chaves em falta.

**Backup verificado, restauro que recusa.** Cada dump é validado com
`pg_restore --list` antes de ser promovido, e leva SHA-256. O restauro recusa
qualquer conjunto sem checksum válido e tira um dump de segurança da base actual
antes de lhe tocar. Um backup corrompido que restaura em silêncio é pior do que
um backup em falta.

**`.gitattributes` com `*.sh text eol=lf`.** O repositório é desenvolvido em
Windows com `core.autocrlf=true`; sem esta regra os scripts chegam à VPS com CRLF
e falham todos com `bad interpreter: /usr/bin/env bash^M`.

---

## Verificar os scripts antes de alterar

```bash
# Sintaxe
for f in deploy/scripts/lib/common.sh deploy/scripts/*.sh; do bash -n "$f" || echo "FALHOU $f"; done

# Análise estática — correr DE DENTRO de deploy/scripts para que o -x
# consiga seguir o `source lib/common.sh`
cd deploy/scripts && shellcheck -x -s bash lib/common.sh *.sh
```

Ambos têm de devolver 0. Há **13 directivas de supressão** no código, cobrindo
4 códigos distintos. Todas são locais (aplicam-se à linha seguinte) e todas têm
comentário a justificar — nenhuma é global nem por ficheiro:

| Código | Onde | Porquê |
|---|---|---|
| SC2034 | `lib/common.sh` (constantes `EX_*`, `CHANGES_MADE`), `install-docker.sh` (`APT_UPDATED`), `install-platform.sh` (`CHANGES_MADE`) | Variáveis de biblioteca, lidas pelos scripts consumidores — invisível ao analisar cada ficheiro isoladamente |
| SC2012 | `backup-platform.sh` (`ls -la` no manifesto) | Listagem para leitura humana, não parseada; nomes gerados por nós |
| SC1090 | Carregamento de `platform.secrets.env` | Ficheiro gerado em runtime, caminho não constante por definição |
| SC1091 | `. /etc/os-release` no relatório | Só existe no alvo Ubuntu, não no ambiente de análise |

## Lacunas conhecidas

1. **Os backups não saem da máquina.** Existem, são verificados e têm retenção —
   mas ficam no mesmo disco dos dados. Não protegem contra perda da VPS, falha de
   disco ou ransomware. Definir `BACKUP_REMOTE_TARGET` em `platform.conf` e
   implementar o envio (object storage + cifra) é o trabalho aberto mais urgente.
2. **Os alertas são locais.** O healthcheck escreve em ficheiro e no journal; se a
   VPS cair, ninguém é notificado. Fecha-se com um monitor externo
   (Healthchecks.io / Uptime Kuma noutro host) a fazer ping ao timer.
3. **Restauro nunca testado ≠ backup.** O ciclo completo `backup → restore` só é
   validável depois de o PostgreSQL existir. Fazê-lo uma vez, contra uma base
   descartável, antes de confiar na infraestrutura.
4. **Servidor único, sem redundância.** Falha de host = indisponibilidade total.
   É decisão de negócio, não técnica — fica registada.
5. **80/443 fechados.** Deliberado enquanto não há proxy. `verify-platform.sh`
   inverte a verificação assim que a stack existir.

---

## Fase seguinte

Com `verify-platform.sh` a devolver 0, o servidor está pronto para receber:
`docker-compose.yml` da plataforma → PostgreSQL (bind em `127.0.0.1`) →
reverse proxy → aplicação. Nada nesta fase precisa de ser refeito.
