# SPharm.MT — Guia do Operador

Versão de bolso. Imprimir e ter à mão.

---

## O que está instalado no teu PC

| Componente | Onde | O que faz |
|---|---|---|
| Agente SPharm.MT | `C:\spharmmt\agent\` | Liga ao SQL Server da farmácia (read-only) e envia dados ao SaaS |
| `agent.config.json` | mesma pasta | Credenciais + endpoints. **Não editar a não ser com instruções** |
| Task Scheduler task | "SPharm.MT — Daily Pipeline" | Corre o agente todos os dias às 03:00 automaticamente |
| Logs | `C:\spharmmt\agent\logs\` | Histórico do que correu, dia a dia |

---

## O que vês todos os dias

Não precisas de fazer nada. O agente corre sozinho às 03:00 e envia
os dados de **ontem** para o SaaS. De manhã podes confirmar abrindo
o navegador em:

```
https://<endereço-do-saas>/relatorios/vendas-mensais
https://<endereço-do-saas>/analise-operacional
```

Devem mostrar o mês corrente com os dados actualizados.

---

## Quando avisar o admin

Avisa **imediatamente** se:

- O PC esteve **desligado** durante mais de 24h
- O SQL Server da farmácia **deixou de arrancar** ou está em manutenção
- A internet do PC esteve em baixo a noite/madrugada (entre 02:30 e 04:00)
- Recebeste alerta visual no Task Scheduler ("Last Run Result" não é 0)

Avisa **no próprio dia** se:

- O relatório mensal aparece vazio (sem produtos)
- Os números do mês têm valores estranhos (negativos, zeros em massa)
- O ecrã `/admin/pipeline` mostra um erro vermelho

Avisa **na semana seguinte** se:

- Os candidatos a ruptura/excesso parecem desfasados da realidade
- Há produtos sempre presentes em "Stock negativo" ou "Sem stockMin/Max"

---

## Comandos de diagnose (se admin pedir)

Tudo na pasta `C:\spharmmt\agent\`. Duplo-click no .bat correspondente.

| Ficheiro | Quando usar |
|---|---|
| `run-health.bat` | "O agente está vivo?" — testa conexão SQL + SaaS |
| `run-test-connection.bat` | Mais detalhe da ligação |
| `run-daily-pipeline-auto.bat` | Forçar o pipeline manualmente (igual ao Task Scheduler) |
| `run-daily-sync-dry-run.bat` | Ver o que **vai** ser enviado sem enviar (pergunta data) |

Resultado é mostrado no ecrã + escrito em `logs\`.

---

## O que NÃO fazer

- ❌ **Não apagar nada** em `C:\spharmmt\agent\`
- ❌ **Não editar** `agent.config.json` (contém credenciais)
- ❌ **Não correr** dois pipelines ao mesmo tempo (já há um lockfile,
  mas evita)
- ❌ **Não desligar o PC à noite**. O agente precisa dele ligado às
  03:00.
- ❌ **Não mover** a pasta de `C:\spharmmt\agent\` para outro sítio
  sem avisar o admin

---

## Quando há actualização do agente

O admin avisa por email/telefone. Tipicamente:

1. Recebes um ZIP novo (`SPharmMT-Agent-YYYY-MM-DD-revN.zip`)
2. Extrair em `C:\Temp\` (qualquer pasta temporária)
3. **Copiar** o teu `agent.config.json` e a pasta `logs\` actuais
4. **Apagar** `C:\spharmmt\agent\` antiga
5. **Mover** a nova pasta extraída para `C:\spharmmt\agent\`
6. **Restaurar** o `agent.config.json` e os `logs\`
7. Right-click → Run na task do Task Scheduler para confirmar

Em alternativa: pedir ao admin para fazer remoto via TeamViewer.

---

## Contactos

- **Admin SPharm.MT:** [preencher nome + telefone + email]
- **Hora preferida para chamadas:** [preencher]
- **Canal alternativo (Slack/Teams):** [preencher]

---

## Histórico de versões do agente

| Data | Versão (rev) | Notas |
|---|---|---|
| 2026-05-14 | rev13 | Adicionado daily-pipeline + auto-bat para Task Scheduler |
| 2026-05-14 | rev12 | Adicionado processaStocks no payload de vendas |
| 2026-05-14 | rev11 | Adicionado inspect-codigoid para diagnose de orphans |
| 2026-05-13 | rev9-10 | Bootstrap + daily-sync iniciais |
