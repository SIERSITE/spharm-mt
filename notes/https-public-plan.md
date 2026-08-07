# HTTPS público — admin.spharmmt.com e app.spharmmt.com

Plano de execução, fase a fase, com o operador a correr os comandos e
validação de cada resultado antes de avançar. DNS já resolvido.

Objectivo: eliminar a dependência do túnel SSH para o Admin Wizard,
separando o domínio administrativo do operacional.

VPS: `164.132.85.211`, raiz da plataforma em `/opt/spharmmt`.

---

## 0. Pré-requisitos

O domínio passou a ser **`.com`** (era `.pt` nas versões anteriores
deste documento). Todas as referências foram actualizadas.

### 0.1 DNS — RESOLVIDO (verificado 2026-08-07)

```
admin.spharmmt.com  @1.1.1.1 -> 164.132.85.211   @8.8.8.8 -> 164.132.85.211
app.spharmmt.com    @1.1.1.1 -> 164.132.85.211   @8.8.8.8 -> 164.132.85.211
zona spharmmt.com   NS  kim.ns.cloudflare.com, sage.ns.cloudflare.com
CAA                 nenhum (qualquer CA pode emitir)
```

Confirmado em dois resolvers independentes.

**A zona está na Cloudflare, mas os registos devolvem o IP de origem** —
ou seja, estão em modo *DNS only*, sem o proxy laranja. É o que este
plano pressupõe. Se o proxy da Cloudflare for ligado:

- o HTTP-01 deixa de chegar à VPS da forma esperada;
- o certificado do Let's Encrypt na origem deixa de ser o que o browser
  vê (passa a ser o da Cloudflare);
- o `X-Forwarded-For` passa a vir da Cloudflare e o `$remote_addr` deixa
  de ser o cliente real.

Não ligar o proxy sem rever este documento.

### 0.2 `sudo` exige password — EXECUÇÃO PELO OPERADOR

O utilizador `deploy` autentica por chave (`~/.ssh/spharmmt_prod_nova`),
mas `sudo -n` responde `a password is required`. Todas as fases precisam
de `sudo`: `ufw`, `certbot`, `install-stack.sh`, cópia dos certificados,
`systemd`.

Decisão: **os comandos são executados pelo operador**, uma fase de cada
vez, com validação de cada resultado antes de avançar. Sem partilha de
password e sem regras temporárias de sudoers.

### 0.3 Caminhos corrigidos

A primeira versão deste plano assumiu caminhos tirados das variáveis do
repositório, sem os confrontar com a VPS. O real é outro:

| Assumido (errado) | Real |
|---|---|
| `/opt/spharmmt/env/platform.env` | `/opt/spharmmt/docker/env/platform.env` |
| `/opt/spharmmt/env/stack.env` | `/opt/spharmmt/docker/env/stack.env` |

Também: o compose vive em `/opt/spharmmt/docker/compose/docker-compose.yml`
e o contexto de build é `/opt/spharmmt/app` (que **não** é um checkout
git — não tem `.git`).

Consequência se não fosse corrigido: os `sed -i` da fase 2 falhavam, e o
`tee -a` da fase 5 **criava um ficheiro novo no sítio errado** — a stack
ficava sem `PROXY_HTTPS_PORT` e o sintoma só aparecia mais tarde.

### 0.4 Estado actual da VPS (apenas leitura, nada alterado)

```
containers   spharmmt-{app,proxy,worker,postgres}  todos healthy (22h)
proxy        80/tcp -> 127.0.0.1:8080  (fechado ao exterior)
proxy/conf   só spharmmt.conf — falta spharmmt-proxy-common.inc
proxy/certs  vazio
certbot      não instalado
URLs         PUBLIC_APP_URL / SPHARMMT_PUBLIC_ENDPOINT = http://164.132.85.211
             AGENT_BASE_ZIP_URL = http://127.0.0.1:8080/... (só pelo túnel)
             ADMIN_API_URL  ausente
SESSION_COOKIE_SECURE=0     SCHEDULER_ENABLED=0     TENANT_FALLBACK_ENABLED=1
disco        / 54G livres · /data 49G livres
```

---

## 1. Registos DNS a criar

| Tipo | Nome | Valor | TTL |
|------|------|-------|-----|
| `A` | `admin.spharmmt.com` | `164.132.85.211` | 300 |
| `A` | `app.spharmmt.com` | `164.132.85.211` | 300 |

São só estes dois. Sem `AAAA` (a VPS não tem IPv6 nesta stack), sem
`CNAME`, sem wildcard.

**Porquê sem `*.app.spharmmt.com`:** os tenants resolvem-se pelo primeiro
label do subdomínio (`lib/runtime-config.ts`), portanto o alvo final é
`sier.app.spharmmt.com`. Mas um certificado wildcard não pode ser emitido
por HTTP-01 — obriga a desafio DNS-01 com credencial de API do
fornecedor de DNS. Como `TENANT_FALLBACK_ENABLED=1` já resolve o tenant
por cookie/query, o wildcard não é necessário nesta fase e fica para
quando os Agents entrarem.

Confirmar propagação antes de pedir o certificado:

```bash
dig +short admin.spharmmt.com @1.1.1.1
dig +short app.spharmmt.com   @1.1.1.1
# ambos têm de devolver exactamente: 164.132.85.211
```

Se o certificado for pedido antes da propagação, o Let's Encrypt falha a
validação e conta para o limite de 5 falhas por hora.

---

## 2. Decisões — CONFIRMADAS

### 2.1 O porto 80 fica aberto (confirmado)

Só para `/.well-known/acme-challenge/` e um 301 para HTTPS. Nada da
aplicação passa em claro por lá. DNS-01 fica excluído nesta fase.

Razão: o Let's Encrypt valida HTTP-01 no porto 80, e sem ele não há
renovação automática. As alternativas — DNS-01 (credencial de API do
fornecedor de DNS guardada na VPS) e TLS-ALPN-01 (obriga a parar o nginx
a cada renovação) — foram postas de lado.

### 2.2 `ADMIN_API_URL` não tem efeito no servidor

Não existe nenhuma referência a `ADMIN_API_URL` no código. Escrevê-lo no
`platform.env` é registo documental — o valor que o técnico escreve no
Wizard. Fica registado para não parecer que passa a ter efeito.

### 2.3 Email Let's Encrypt

`grp.cc.spharm@sier.pt` — recebe os avisos de expiração.

### 2.4 Separação por caminho (confirmada, imposta pelo nginx)

| Domínio | Serve | Devolve 404 |
|---------|-------|-------------|
| `admin.spharmmt.com` | `/api/admin/*`, `/agent-base/*`, `/healthz` | aplicação web, `/api/ingest/*` |
| `app.spharmmt.com` | aplicação web, `/api/ingest/*`, `/_next/*`, `/healthz` | `/api/admin/*` |

Consequência: o `AGENT_BASE_ZIP_URL` passa a apontar para
`admin.spharmmt.com/agent-base/…`, porque quem descarrega o template é o
Wizard. O `SPHARMMT_PUBLIC_ENDPOINT` (destino de ingestão dos Agents)
aponta para `app.spharmmt.com`. É esta a separação que se quer.

Risco: se algum caminho administrativo não estiver na lista, deixa de
responder no domínio admin. Mitigado por validar cada função do Wizard
antes de fechar a fase, e o rollback é remover um ficheiro de conf.

---

## 3. Alterações de código (commit antes de tocar na VPS)

1. **`deploy/docker/docker-compose.yml`** — mapeamento 443 no proxy
   (`${PROXY_BIND}:${PROXY_HTTPS_PORT:-443}:443`, só activo quando a
   variável existir) e volume do webroot ACME.
2. **`deploy/docker/proxy/spharmmt.conf`** — `location ^~
   /.well-known/acme-challenge/` servida do webroot, antes de tudo.
3. **`deploy/docker/proxy/spharmmt-tls.conf`** — ficheiro NOVO com os
   dois `server {}` de 443. Só é copiado para o directório de conf
   **depois** de os certificados existirem: o nginx recusa arrancar se
   `ssl_certificate` apontar para um ficheiro que não existe, e isso
   deixaria a stack sem proxy nenhum.
4. **`deploy/scripts/install-stack.sh`** — escrever `PROXY_HTTPS_PORT` e
   `ACME_DIR` no `stack.env`, preservando o valor existente como já faz
   para `PROXY_BIND`.
5. **`deploy/scripts/renew-hook.sh`** — deploy-hook de renovação.

O nginx precisa de dois ficheiros de conf em vez de um porque a ordem
importa: primeiro só HTTP (para obter o certificado), depois HTTP+TLS.

---

## 4. Comandos, por ordem

Cada fase é reversível sozinha. **Parar e reportar se alguma falhar** —
não avançar para a seguinte.

### Fase 0 — rede de segurança

```bash
sudo /opt/spharmmt/scripts/backup-platform.sh --label pre-https
sudo cp /opt/spharmmt/docker/env/platform.env  /root/platform.env.pre-https
sudo cp /opt/spharmmt/docker/env/stack.env     /root/stack.env.pre-https
sudo cp -r /opt/spharmmt/proxy/conf     /root/proxy-conf.pre-https
```

Sem isto não há rollback rápido da configuração.

### Fase 1 — código novo e reconstrução

```bash
cd /tmp && rm -rf spharmmt && git clone https://github.com/SIERSITE/spharm-mt.git spharmmt
cd /tmp/spharmmt && git log -1 --format='%H %s'
```

Editar `/opt/spharmmt/docker/env/platform.env` (o ficheiro diz explicitamente
que é seguro editar à mão):

```ini
PUBLIC_APP_URL=https://app.spharmmt.com
NEXT_PUBLIC_APP_URL=https://app.spharmmt.com
SPHARMMT_PUBLIC_ENDPOINT=https://app.spharmmt.com
ADMIN_API_URL=https://admin.spharmmt.com
AGENT_BASE_ZIP_URL=https://admin.spharmmt.com/agent-base/spharmmt-agent-base-rev44.zip
SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:8080,164.132.85.211,admin.spharmmt.com,app.spharmmt.com
SESSION_COOKIE_SECURE=0
```

`SESSION_COOKIE_SECURE` fica a **0** — sobe só na fase 6, depois de o
HTTPS estar confirmado. Se subir agora, o login pelo túnel deixa de
funcionar (o browser descarta o cookie sobre HTTP) e ficamos sem acesso.

```bash
cd /tmp/spharmmt/deploy/scripts && sudo ./install-stack.sh --yes
```

Reconstrói a imagem (~10 min): `PUBLIC_APP_URL` e
`SERVER_ACTIONS_ALLOWED_ORIGINS` entram no bundle no build, não em
runtime. O proxy continua em `127.0.0.1:8080` — nada mudou para fora.

Validar pelo túnel antes de continuar. As três primeiras verificações
existem porque as alterações ao `install-stack.sh` (instalar o `.inc`,
preservar `PROXY_HTTPS_PORT`, criar o webroot ACME) **não são exercidas
por nenhum teste local** — esta é a sua primeira execução real. Se o
`.inc` não for instalado, o nginx morre no arranque com `open() ...
failed`, porque o `spharmmt.conf` inclui-o.

```bash
ls -l /opt/spharmmt/proxy/conf/
# tem de listar: spharmmt.conf  E  spharmmt-proxy-common.inc
ls -ld /opt/spharmmt/proxy/acme
grep -E '^(PROXY_HTTPS_PORT|ACME_DIR)=' /opt/spharmmt/docker/env/stack.env
sudo docker exec spharmmt-proxy nginx -t
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz   # 200
```

### Fase 2 — abrir o 80 (só ACME + redirect)

```bash
sudo sed -i 's/^PROXY_BIND=.*/PROXY_BIND=0.0.0.0/'     /opt/spharmmt/docker/env/stack.env
sudo sed -i 's/^PROXY_HTTP_PORT=.*/PROXY_HTTP_PORT=80/' /opt/spharmmt/docker/env/stack.env
sudo mkdir -p /opt/spharmmt/proxy/acme
sudo chown deploy:spharmmt /opt/spharmmt/proxy/acme
sudo ufw allow 80/tcp
sudo /opt/spharmmt/scripts/update-platform.sh --no-build
```

Confirmar que o desafio ACME é servido nos dois nomes:

```bash
echo teste | sudo tee /opt/spharmmt/proxy/acme/.well-known/acme-challenge/probe >/dev/null
curl -s http://admin.spharmmt.com/.well-known/acme-challenge/probe   # teste
curl -s http://app.spharmmt.com/.well-known/acme-challenge/probe     # teste
sudo rm -f /opt/spharmmt/proxy/acme/.well-known/acme-challenge/probe
```

Se isto não devolver `teste`, o certbot vai falhar — parar aqui.

### Fase 3 — certificado

Ensaio primeiro. O `--dry-run` não gasta o limite de emissões:

```bash
sudo apt-get update && sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /opt/spharmmt/proxy/acme \
  -d admin.spharmmt.com -d app.spharmmt.com \
  --agree-tos --no-eff-email -m grp.cc.spharm@sier.pt --dry-run
```

Só se o ensaio passar:

```bash
sudo certbot certonly --webroot -w /opt/spharmmt/proxy/acme \
  -d admin.spharmmt.com -d app.spharmmt.com \
  --agree-tos --no-eff-email -m grp.cc.spharm@sier.pt
```

**Um certificado com os dois nomes** — uma emissão, uma renovação.

### Fase 4 — deploy-hook e certificados no sítio

O certbot escreve em `/etc/letsencrypt/live/`, que não está montado no
container. Sem o hook, a renovação dentro de 90 dias corre com sucesso e
o nginx continua a servir o certificado velho até expirar — falha
silenciosa, e o sintoma aparece só no dia em que o browser recusa o site.

```bash
sudo install -m 0755 /tmp/spharmmt/deploy/scripts/renew-hook.sh \
  /etc/letsencrypt/renewal-hooks/deploy/spharmmt.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/spharmmt.sh   # primeira cópia
ls -l /opt/spharmmt/proxy/certs/
# fullchain.pem 0644 · privkey.pem 0640 (o verify-platform.sh verifica isto)
```

### Fase 5 — activar TLS

```bash
sudo cp /tmp/spharmmt/deploy/docker/proxy/spharmmt-tls.conf /opt/spharmmt/proxy/conf/
sudo docker exec spharmmt-proxy nginx -t     # validar ANTES de aplicar
echo 'PROXY_HTTPS_PORT=443' | sudo tee -a /opt/spharmmt/docker/env/stack.env
sudo ufw allow 443/tcp
sudo /opt/spharmmt/scripts/update-platform.sh --no-build
```

Validação:

```bash
curl -sI https://admin.spharmmt.com/healthz | head -1        # 200
curl -sI https://app.spharmmt.com/healthz   | head -1        # 200
curl -s -o /dev/null -w '%{http_code}\n' https://admin.spharmmt.com/api/admin/v1/tenants   # 401 (sem token)
curl -s -o /dev/null -w '%{http_code}\n' https://app.spharmmt.com/api/admin/v1/tenants     # 404 (separação)
curl -s -o /dev/null -w '%{http_code}\n' https://admin.spharmmt.com/login                  # 404 (separação)
echo | openssl s_client -connect admin.spharmmt.com:443 -servername admin.spharmmt.com 2>/dev/null \
  | openssl x509 -noout -dates -subject -ext subjectAltName
```

Confirmar que o PostgreSQL continua fechado:

```bash
sudo ss -ltnp | grep -E ':5432' || echo "5432 nao escuta publicamente — correcto"
sudo ufw status numbered
```

### Fase 6 — cookie seguro (só depois do HTTPS confirmado)

```bash
sudo sed -i 's/^SESSION_COOKIE_SECURE=.*/SESSION_COOKIE_SECURE=1/' /opt/spharmmt/docker/env/platform.env
sudo /opt/spharmmt/scripts/update-platform.sh --no-build
```

Runtime, sem reconstruir. Testar o login em `https://app.spharmmt.com`
**antes** de fechar a sessão SSH.

### Fase 7 — renovação automática

```bash
systemctl list-timers certbot.timer
sudo certbot renew --dry-run
```

O `--dry-run` corre o deploy-hook a sério, portanto prova a cadeia toda.

**HSTS fica de fora**, como pedido. Só depois de semanas de HTTPS
estável — uma vez anunciado, o browser recusa HTTP e não há rollback
possível do lado do cliente.

### Fase 8 — Wizard

Base URL para `https://admin.spharmmt.com`. Sem túnel, sem SSH.

---

## 5. Rollback

Cada fase desfaz-se sozinha. O túnel SSH continua a funcionar em todas
elas, porque o bind local nunca é removido.

| Falha em | Reverter com | Efeito |
|----------|--------------|--------|
| Fase 1 (build) | `cp /root/platform.env.pre-https /opt/spharmmt/docker/env/platform.env` + `install-stack.sh --yes` | Volta ao estado anterior (~10 min de reconstrução) |
| Fase 2 (80) | `PROXY_BIND=127.0.0.1`, `PROXY_HTTP_PORT=8080`, `ufw delete allow 80/tcp`, `update-platform.sh --no-build` | Fecha ao exterior outra vez |
| Fase 3 (certbot) | Nada a desfazer — o certbot não altera a stack | Repetir depois de corrigir DNS/webroot |
| Fase 5 (TLS) | `rm /opt/spharmmt/proxy/conf/spharmmt-tls.conf` + `update-platform.sh --no-build` | Volta a HTTP; a stack fica de pé |
| Fase 6 (cookie) | `SESSION_COOKIE_SECURE=0` + `update-platform.sh --no-build` | Login volta a funcionar por HTTP |

Rollback total:

```bash
sudo cp /root/platform.env.pre-https /opt/spharmmt/docker/env/platform.env
sudo cp /root/stack.env.pre-https    /opt/spharmmt/docker/env/stack.env
sudo rm -f /opt/spharmmt/proxy/conf/spharmmt-tls.conf
sudo rm -f /etc/letsencrypt/renewal-hooks/deploy/spharmmt.sh
sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp
cd /tmp/spharmmt/deploy/scripts && sudo ./install-stack.sh --yes
```

O `pgdata` não é tocado em fase nenhuma deste plano. O rollback também
não lhe toca.

### O que este plano não faz

Não mexe no Agent, no PostgreSQL, na ingestão nem na lógica de negócio.
Não activa o scheduler. Não cria tenants. Não desliga a Vercel nem a
Neon. Não activa HSTS.

---

## 6. Riscos conhecidos

**Reconstrução da imagem na fase 1.** É o passo mais demorado e o único
que reconstrói o bundle. Se falhar, a stack fica com a imagem anterior a
correr — não há corte de serviço, mas as variáveis novas não entram.

**Uma janela com o 80 público antes do TLS.** Entre as fases 2 e 5 a
aplicação responde em HTTP no exterior. É curta e o cookie de sessão
ainda não é `secure`, mas convém não fazer login pelo domínio público
nessa janela. Depois da fase 5 o 80 passa a 301.

**Separação por caminho.** Se algum caminho administrativo ficar fora da
lista do vhost admin, deixa de responder. Descobre-se na validação de
cada função do Wizard; corrige-se acrescentando a `location`.

**Limite de emissões do Let's Encrypt.** 5 falhas por hora por conjunto
de domínios. Daí o `--dry-run` obrigatório antes da emissão real.
