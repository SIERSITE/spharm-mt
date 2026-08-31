# Local Agent — Checklist de Segurança

Princípios invariantes da operação do agent. **Confirmar antes de cada deployment** num novo cliente / nova farmácia.

---

## 1. Login SQL Server — read-only dedicado

✅ **OBRIGATÓRIO:**
- Criar login SQL Server **dedicado** para o agent (ex: `spharm_readonly`).
- Atribuir **apenas** `db_datareader` na BD SPharm.
- Atribuir **`db_denydatawriter`** explicitamente (cinto + suspensórios).
- Password forte aleatória (mínimo 20 caracteres, mistura).

❌ **NUNCA:**
- ❌ Usar `sa` ou outro login com permissões de admin.
- ❌ Usar o login que a aplicação SPharm usa (esse tem permissões de escrita).
- ❌ Atribuir `db_owner`, `db_ddladmin`, `db_datawriter` ou qualquer role com escrita.
- ❌ Atribuir permissões a nível de server (sysadmin, securityadmin).

**Comando de criação correcto** (template em [`RUN_DISCOVERY.md` §2](RUN_DISCOVERY.md)):
```sql
USE master;
CREATE LOGIN spharm_readonly WITH PASSWORD = '<PW>', CHECK_POLICY = OFF;
USE SPHARM;
CREATE USER spharm_readonly FOR LOGIN spharm_readonly;
EXEC sp_addrolemember 'db_datareader', 'spharm_readonly';
EXEC sp_addrolemember 'db_denydatawriter', 'spharm_readonly';
```

**Verificação periódica** (uma vez por trimestre):
```sql
-- Lista permissões do login agent
USE SPHARM;
SELECT m.name AS role_name, u.name AS user_name
FROM sys.database_role_members rm
JOIN sys.database_principals m ON rm.role_principal_id = m.principal_id
JOIN sys.database_principals u ON rm.member_principal_id = u.principal_id
WHERE u.name = 'spharm_readonly';
-- Esperado: 2 linhas — db_datareader e db_denydatawriter. Nada mais.
```

---

## 2. Rede — manter SQL Server fora da internet

✅ **OBRIGATÓRIO:**
- O SQL Server fica na rede local da farmácia (LAN ou VPN privada).
- O agent corre no mesmo servidor ou em PC da mesma LAN.
- Acesso à internet feito **apenas pelo agent**, com saída TLS apenas para o endpoint SaaS configurado (`{{SAAS_ENDPOINT}}`).

❌ **NUNCA:**
- ❌ Expor a porta 1433 do SQL Server à internet pública.
- ❌ Configurar port-forwarding no router para o SQL Server.
- ❌ Permitir RDP do SQL Server a partir da internet sem VPN.

**Verificação:** do exterior da rede da farmácia, este comando deve falhar (timeout/refused):
```bash
telnet <IP-publico-farmacia> 1433
```

---

## 3. Credenciais SQL Server — ficam locais

✅ **GARANTIA TÉCNICA** (verificável por code review do agent):
- `ERP_SQLSERVER_USER` e `ERP_SQLSERVER_PASSWORD` são lidos apenas em `agent/src/config.ts`.
- Usados apenas em `agent/src/sql-client.ts` para abrir o `mssql` ConnectionPool.
- **Nunca enviados** em nenhuma chamada HTTP para a SaaS.
- **Mascarados** em todos os logs (`maskSecret` em `config.ts` → `"s****y"`).

✅ **OBRIGATÓRIO:**
- `agent/.env` permanece no servidor da farmácia. Não copiar para laptops do dev.
- `.env` está no `.gitignore` global e do agent — não pode ser commitado.
- Para diagnose remota, o dev pede ao operador para correr `npm run agent:health` e enviar **apenas o output** (que já vem mascarado).

❌ **NUNCA:**
- ❌ Enviar `.env` por email, Slack, Teams ou outro canal.
- ❌ Tirar screenshots do `.env` com password visível.
- ❌ Cola o conteúdo do `.env` em chat de suporte (mesmo "só para o dev ver").

**Quando precisas comunicar a password ao dev** (raro): vault partilhado (1Password, Bitwarden) ou chamada telefónica/vídeo com partilha temporária. Nunca em texto persistente.

---

## 4. Ingest key — comunicação ao agent

✅ **OBRIGATÓRIO:**
- A ingest key é **64 caracteres hex** gerada pelo dev via `npm run tenancy:issue-ingest-key` (no repo SaaS).
- O dev mostra a key em claro **uma única vez** (no terminal dele). Anota-a num vault. Sem retry sem rotação.
- O dev comunica a key ao operador por canal seguro (vault partilhado ou chamada).
- O operador cola no `agent/.env` directamente — não passa por intermediários nem ficheiros temporários.

✅ **ROTAÇÃO:**
- Se houver suspeita de leak (PC roubado, screenshot acidental, ex-funcionário com acesso), pede ao dev para correr `tenancy:issue-ingest-key -- --slug <tenant> --rotate`.
- Resultado: a key anterior fica **imediatamente inválida** (401 em todos os agents que a usavam). A nova key tem de ser actualizada no `.env` de cada agent.

❌ **NUNCA:**
- ❌ Reutilizar a mesma key em múltiplos tenants (impossível por design — uma key = um tenant).
- ❌ Partilhar a key entre dev e ops sem vault — usar 1Password / Bitwarden.

---

## 5. Discovery não envia dados comerciais

✅ **GARANTIA TÉCNICA** (verificável em `agent/src/commands/discover.ts`):
- Queries usadas: apenas `sys.schemas`, `sys.tables`, `sys.columns`, `sys.types`, `sys.indexes`, `sys.index_columns`, `sys.foreign_keys`, `sys.foreign_key_columns`, `sys.triggers`, `sys.partitions` (row counts estimados).
- A única excepção: **MIN/MAX de colunas-data** em tabelas candidatas (ex: `SELECT MIN([data]) FROM [Venda]`). Não lê outras colunas, não lê nenhuma linha individual.
- **Output ficheiros** (`spharm-sqlserver-discovery.{json,md}`): contêm nomes de tabelas/colunas, tipos, índices, FKs, contagem aproximada de linhas, e datas min/max. **Nenhum dado de paciente, venda, produto, preço, ou stock.**

✅ **PODE ser enviado pelo operador para o dev** em canais normais (email, drive partilhado).

❌ **APÓS os comandos futuros `bootstrap` e `daily-sync`** o cenário muda — esses enviam dados reais para a SaaS via HTTPS autenticado. Quando esses comandos forem implementados, este documento ganha uma secção §6 com as garantias específicas (idempotência, sem dados de paciente clinicamente identificáveis sem consentimento, etc.). **Não correr esses comandos ainda — não estão implementados na v0.1.**

---

## 6. Logs do agent

✅ **MASCARADOS por defeito:**
- `ingestKey` → `a*****f` no resumo de config
- `sqlUser` → `s*******y`
- `sqlPassword` → `***`
- `connectionUrl` (SaaS) → não logada em claro (não tem credentials embebidas, mas mantemos o padrão)

✅ **OBRIGATÓRIO antes de enviar logs ao dev:**
- Inspecciona o output a olho. Se vires algo que pareça um secret em claro, **edita antes de enviar** (Find & Replace para `***`).
- Em particular: erros do mssql podem incluir trechos de SQL com valores. O agent trunca a 500 chars mas erros raros podem deixar passar.

❌ **NUNCA:**
- ❌ Activar `DEBUG=*` ou modo verbose extra sem saber o que vai ser exposto.

---

## 7. Auditoria — `lastAgentHeartbeatAt`

Cada chamada do agent ao endpoint `/api/outbox/v1/heartbeat` actualiza no control plane da SaaS:
- `Tenant.lastAgentHeartbeatAt` (timestamp UTC)
- `Tenant.lastAgentIp` (IP visto pela SaaS)
- `Tenant.lastAgentVersion` (do User-Agent do agent)

O dev pode consultar no painel admin se um agent **deixou de fazer heartbeat** (sinal de queda do servidor da farmácia, problema de rede, ou key revogada).

Para o operador da farmácia: nada a configurar. Mas saber que existe esta visibilidade — não é "fire and forget".

---

## 8. Resumo — 1 página

| Categoria | Regra invariante |
|---|---|
| **Login SQL** | Dedicado read-only (`db_datareader` + `db_denydatawriter`). Nunca `sa`. |
| **Rede** | SQL Server fora da internet pública. Agent é a única ponte. |
| **Credenciais SQL** | Ficam no `.env` local. Nunca enviadas à SaaS. Nunca em chat. |
| **Ingest key** | Vault partilhado para distribuir. Rotação imediata em suspeita de leak. |
| **Discovery** | Apenas metadata. Sem dados comerciais. Outputs podem ir por email. |
| **Logs** | Secrets mascarados por defeito. Verifica antes de enviar. |
| **Auditoria** | Heartbeat actualiza control plane — dev tem visibilidade. |
