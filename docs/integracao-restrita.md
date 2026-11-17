# Informação técnica de «Integração» — só para técnicos internos

Base: `e7db04071af7edbedc001bf75c73ef3e0bc4e808`. **Sem migrations.**

## Modelo de permissão («integration.read»)
`lib/integracao/acesso.ts` → `podeVerIntegracao(session)` / `requireIntegracao()`.

Reutiliza o mecanismo que já separava a equipa da plataforma dos clientes
(`isPlatformAdminSession`, usado pelo `/admin`): perfil ADMINISTRADOR **e** sessão do contexto
**não-tenant** (claim `__legacy__`) **e** email em `PLATFORM_ADMIN_EMAILS` (env do servidor — nenhum
nome/email/id no código).

Porque não uma entrada na matriz de perfis (`permissions-core`): esses perfis são do CLIENTE — o
ADMINISTRADOR de um grupo cria utilizadores com o email que quiser. Por isso mesmo, **o email sozinho
nunca chega**: um utilizador do tenant com o email de um técnico é recusado (testado), porque a sessão
dele é do tenant, não do contexto não-tenant, e o middleware recusa cookies de um contexto no outro.
Falha fechada: env vazia/ausente ⇒ ninguém tem a permissão.

**Atribuir:** acrescentar o email do técnico a `PLATFORM_ADMIN_EMAILS` e ter-lhe um utilizador
ADMINISTRADOR na base do contexto não-tenant. **Retirar:** remover o email da env.

## O que mudou
| | |
|---|---|
| Menu do tenant | «Integração» removida (`app-shell.tsx`). |
| `/configuracoes/integracao` | Já não renderiza nada nem toca na BD: técnico → `/admin/integracao`; qualquer outro → `/dashboard`. |
| Actions do tenant (`retryExportAction`, `cancelExportAction`) | **Removidas** (não existe action para chamar). |
| `/admin/integracao` (novo) | Heartbeat, versão do agent, fila, falhadas, última sincronização por tenant. Gate repetido na página (não depende do layout). Menu do `/admin` ganha «Integração». |
| Operações manuais (re-enviar/cancelar outbox) | Já só existiam em `/admin` com `requirePlatformAdmin` (mesmo predicado). |
| `GET /api/admin/v1/tenants/{slug}/status` | Passa a incluir `integration` (heartbeat, versão, IP, contadores do outbox). Via de produção dos técnicos (bearer admin, domínio admin). Campo aditivo. |
| Detalhe da encomenda | Sem tentativas, outbox id, último erro nem «Timeline de exportação». O **servidor** deixou de ler e enviar esses dados (não ficam escondidos no payload RSC). |
| «Sincronizar agora» (/stock) | Mantido (decisão), sem texto técnico: sem contagens de stock/produtos/fabricantes/designações, sem erro do agent, sem «long-polling». As respostas das actions passam por `estadoParaCliente` (resultado/erro = `null`). Mantém «Última sincronização: …». |

## Mantido ao cliente (de propósito)
Datas/períodos dos relatórios; «Última sincronização»; o estado simples da exportação de uma encomenda
(badge pendente/exportado/falhado, nº do documento SPharm); os botões de re-enviar/cancelar **da
encomenda** em `/encomendas` (operação de negócio sobre a encomenda, não a área «Integração»).

## ⚠ Limitação de produção (a conhecer antes do deploy)
Em produção `ALLOW_LEGACY_DATABASE_FALLBACK=0` e o domínio `admin.spharmmt.com` só serve `/api/admin/*`
(nginx: tudo o resto 404). Logo o **console web `/admin` (incl. `/admin/integracao`) só é utilizável onde
exista contexto não-tenant** (dev/staging/suporte). Em produção os técnicos consultam a integração por
`/api/admin/v1/tenants/{slug}/status` (Wizard/curl). Isto já era assim para todo o `/admin`; não foi alterado.
Se quiserem a página web em produção é uma decisão de infraestrutura à parte (login de `GlobalAdmin`,
que existe no control plane mas ainda não tem login).

## Instalação
Deploy normal. Garantir `PLATFORM_ADMIN_EMAILS` (já existente) só com técnicos internos. Sem variáveis novas.

## Rollback
Voltar a `e7db040`. Sem dados a desfazer.

## Testes
```
npx tsx scripts/tests/test-integracao-restrita.ts      # 39 asserções, sem BD
E2E_DB_*=… npm run e2e:integracao-restrita              # browser real, 112 asserções (ver cabeçalho)
```
