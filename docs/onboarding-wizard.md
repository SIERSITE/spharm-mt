# Onboarding Wizard v1 — guia rápido

> **Nota (2026-05-15):** este wizard CLI foi **substituído** pelo
> **[Admin Wizard gráfico](admin-wizard.md)** como ponto de entrada oficial.
> Duplo-click em `SPharmMT-Admin-Wizard.bat` na raiz do repo (ou no
> `.exe` em `dist-admin/`). Este documento descreve o `onboarding-wizard.bat`
> que continua a funcionar como **fallback técnico** para o developer.

Wrapper interactivo Windows para onboarding completo de grupos/farmácias.
Operador **não precisa de decorar comandos npm**. Tudo via menu.

## Arrancar

Na raiz do repo (admin machine, com `.env.local` configurado):

```
onboarding-wizard.bat
```

(Duplo-click no Explorer também funciona.)

Requer Windows + PowerShell 5+ (vem em qualquer Windows 10/11) + `npm`
disponível no PATH.

## Menu principal

```
═══════════════════════════════════════════════════════════════════
  SPharm.MT — Onboarding Wizard
═══════════════════════════════════════════════════════════════════

  1. Criar novo grupo / tenant
  2. Adicionar farmácia a grupo existente
  3. Gerar ZIP agent para farmácia
  4. Ver status de grupo
  5. Rodar pilot:precheck
  6. FLUXO COMPLETO: novo grupo + N farmácias + ZIPs
  0. Sair

  Logs do dia : logs\onboarding-2026-05-14.log
```

## Quando usar o quê

| Cenário | Opção |
|---|---|
| Primeira vez — grupo novo com 1+ farmácias **e** ZIPs prontos | **6** (fluxo completo) |
| Já tens o tenant criado, precisas só de adicionar mais 1 farmácia | 2 + 3 |
| Já tens tenant + farmácia, precisas só do ZIP | 3 |
| Confirmar que onboarding está bem | 4 (status) + 5 (precheck) |
| Operação individual atómica | 1, 2 ou 3 |

## Fluxo completo (opção 6) — passo a passo

1. Wizard pergunta:
   - Slug do grupo (ex: `farmacia-internacional-1`)
   - Nome do grupo (ex: `Farmácia Internacional, Lda`)
   - Email do admin
   - Endpoint SaaS (default: `PUBLIC_APP_URL` do ambiente; em produção `https://app.spharmmt.com`)
   - Quantas farmácias (1-20)
2. Para cada farmácia pergunta nome, código ANF e healthcheck URL
3. Mostra **plano completo** + pede `CONFIRMO`
4. Executa em sequência:
   - `tenancy:create` (BD Neon + migrations + admin + ingest key)
   - `tenancy:add-farmacia` × N
   - `admin:package-agent` × N **reutilizando a mesma key** (sem `--rotate`
     entre farmácias — não invalida ZIPs anteriores)
5. Mostra resumo final:
   - Caminhos absolutos dos ZIPs
   - Credenciais admin + ingest key **uma vez**
   - Próximos passos no PC de cada farmácia

## Safety net

- **Plano antes de executar** em cada opção destrutiva
- **CONFIRMO** obrigatório
- Duplicados (slug ou farmácia) **abortam** sem efeitos
- **Secrets nunca vão para o log** — só aparecem no terminal e desaparecem
  quando fechas a janela
- Logs append-only em `logs\onboarding-YYYY-MM-DD.log` (apenas eventos,
  tempos, ok/fail, slugs/nomes — **não** keys, **não** passwords)

## Output esperado no fim do fluxo completo

```
─── Resumo ───
Grupo criado: farmacia-internacional-1
Tenant id:    cmp5...

Farmácias criadas:
  · Farmácia Internacional Sede
  · Farmácia Internacional Boavista

ZIPs gerados:
  · Farmácia Internacional Sede
      C:\projetos\spharm-mt\dist-agent\clients\farmacia-internacional-1-2026-05-14-ab12cd.zip
  · Farmácia Internacional Boavista
      C:\projetos\spharm-mt\dist-agent\clients\farmacia-internacional-1-2026-05-14-ef34gh.zip

Credenciais do admin (anotar AGORA — não recuperáveis):
  email    : admin@example.pt
  password : <gerada>

Ingest key (mesma em todos os ZIPs deste grupo):
  <64 hex>

Próximos passos no PC de cada farmácia:
  1. Copiar o ZIP correspondente e extrair em C:\spharmmt\agent\
  2. Editar agent.config.json apenas para completar sqlServer.password
  3. Correr run-test-connection.bat
  4. Criar Task Scheduler com run-daily-pipeline-auto.bat
     (ver docs/daily-pipeline-task-scheduler.md)
```

## Limitações conhecidas v1

- **Sem rollback automático no fluxo completo.** Se `add-farmacia` falha
  para a farmácia 3 de 5, as 1+2 ficam criadas. O wizard continua para
  as 4+5; admin decide manualmente o que fazer com a 3 depois.
- **Sem reuse de tenant em curso.** Se interromperes o fluxo a meio,
  re-arrancar a opção 6 vai recusar (slug duplicado). Continuar
  manualmente com opções 2+3.
- **Não regista password SQL no ZIP** — operador completa no PC.
  Argumento `--sql-password` está disponível no `admin:package-agent`
  CLI directo mas não exposto no wizard por segurança.

## Como adicionar 2ª farmácia a grupo existente

```
> onboarding-wizard.bat
> 2  ↵
Slug do grupo: meu-grupo
Nome da farmácia: Farmácia Nova
Código ANF: FN002
...
CONFIRMO ↵
✓ Farmácia criada

> 3  ↵
Slug do grupo: meu-grupo
Nome da farmácia: Farmácia Nova
Endpoint SaaS: <enter para default>
Healthcheck URL: https://hc-ping.com/<uuid>
Tens a ingest key actual do grupo? Y/N: Y ↵
Cola a key: ******* (não logada)
...
CONFIRMO ↵
✓ ZIP gerado: C:\projetos\spharm-mt\dist-agent\clients\meu-grupo-2026-05-14-xy12.zip
```

## Recuperação de falhas

| Sintoma | Acção |
|---|---|
| `tenancy:create` falha com network/Neon | Ver logs, corre `npm run tenancy:cleanup-failed --slug X --confirm` antes de retry |
| `add-farmacia` exit 2 | Farmácia duplicada — ok, usa nome diferente |
| `package-agent` falha "Build base em falta" | Correr `npm run agent:package` antes de re-tentar |
| Wizard fecha inesperadamente | Logs em `logs\onboarding-YYYY-MM-DD.log` mostram último step. Continuar manualmente com opções 2+3. |

## Não usar para

- ❌ Apagar tenant — usa `npm run tenancy:cleanup-failed` ou SQL directo
- ❌ Renomear farmácia — SQL directo na BD do tenant
- ❌ Diagnose de pipeline em produção — usa `/admin/pipeline` ou `pipeline:health`
