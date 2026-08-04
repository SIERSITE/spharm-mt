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

Owner `deploy:spharmmt`, directórios `2750` (setgid, para o grupo ser herdado),
`umask 027`. `secrets/` é `0700 root:root` — o `deploy` lê com sudo, e os
containers só recebem o que o compose montar explicitamente.

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
