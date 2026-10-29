<#
.SYNOPSIS
  Compara OFFLINE 2 ou mais relatorios JSON do diagnostico classification-audit (Silveirense, Garantia, SIER, ...).

.DESCRIPTION
  Le apenas os ficheiros .json indicados (nao liga a SQL Server, ao SPharm.MT nem a rede) e imprime as diferencas
  relevantes: impressao do ambiente, lookup Etico_NETT (codigos / descricoes / mapeamento), colunas de dbo.Stocks,
  metadados de Generico (tipo, anulavel, default, NULL), contagens por categoria, Processa_Stocks, cobertura e
  divergencias MT x ERP, alertas do mapeamento. So escreve em stdout e, se pedido, no ficheiro -Out. Texto ASCII.

  Relatorios de versoes antigas (sem as seccoes v2) sao aceites: os campos em falta aparecem como "n/d".

.PARAMETER Reports   Dois ou mais relatorios .json (auditoria-classificacao.json).
.PARAMETER Labels    Rotulos opcionais (um por relatorio). Omissao: o nome da base de dados de cada relatorio.
.PARAMETER Out       Ficheiro de texto onde gravar tambem a saida (opcional). Nunca sobrescreve um dos relatorios.
.EXAMPLE
  .\Compare-AuditReports.ps1 -Reports C:\r\silveirense.json, C:\r\garantia.json, C:\r\sier.json -Out C:\r\comparacao.txt
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string[]]$Reports,
  [string[]]$Labels,
  [string]$Out
)
$ErrorActionPreference = 'Stop'

$script:linhas = New-Object System.Collections.Generic.List[string]
$script:diferencas = 0
# Tudo o que sai e ASCII (a consola do Windows pode nao ser UTF-8): acentos das descricoes do ERP sao removidos.
function Ascii([string]$t) { $d = $t.Normalize([Text.NormalizationForm]::FormD); $sb = New-Object Text.StringBuilder; foreach ($c in $d.ToCharArray()) { if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($c) } }; return ($sb.ToString() -replace '[\u00AB\u00BB]', '"' -replace '\u00D7', 'x' -replace '[^\x20-\x7E]', '?') }
function Escreve([string]$t = '') { $script:linhas.Add((Ascii $t)) }
function Titulo([string]$t) { Escreve ''; Escreve ('== ' + $t + ' ==') }

# navegacao segura: Get-P $obj 'a.b.c' -> $null se algum nivel nao existir
function Get-P($obj, [string]$caminho) {
  $o = $obj
  foreach ($p in $caminho.Split('.')) {
    if ($null -eq $o) { return $null }
    $prop = $o.PSObject.Properties[$p]
    if ($null -eq $prop) { return $null }
    $o = $prop.Value
  }
  return $o
}
function Txt($v) { if ($null -eq $v) { return 'n/d' } if ($v -is [bool]) { return ($(if ($v) { 'sim' } else { 'nao' })) } return "$v" }

try {
  $Reports = @($Reports | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' })
  if ($Labels) { $Labels = @($Labels | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' }) }
  if ($Reports.Count -lt 2) { throw 'sao precisos pelo menos 2 relatorios (-Reports a.json, b.json)' }
  if ($Labels -and $Labels.Count -ne $Reports.Count) { throw 'o numero de -Labels tem de ser igual ao de -Reports' }
  $R = @()
  for ($i = 0; $i -lt $Reports.Count; $i++) {
    $f = $Reports[$i]
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "relatorio nao encontrado: $f" }
    if ([IO.Path]::GetExtension($f).ToLower() -ne '.json') { throw "so se comparam relatorios .json: $f" }
    try { $j = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw "JSON invalido: $f" }
    if ($null -eq (Get-P $j 'cabecalho.pacote')) { throw "nao parece um relatorio do classification-audit: $f" }
    $label = if ($Labels) { $Labels[$i] } else { Txt (Get-P $j 'cabecalho.baseDados') }
    $R += , @{ L = $label; J = $j; F = $f }
  }
  # rotulos repetidos -> acrescenta indice
  $vistos = @{}
  for ($i = 0; $i -lt $R.Count; $i++) {
    $l = $R[$i].L
    if ($vistos.ContainsKey($l)) { $R[$i].L = "$l#$($i + 1)" } else { $vistos[$l] = 1 }
  }
  if ($Out) {
    $outFull = [IO.Path]::GetFullPath($Out)
    foreach ($x in $R) { if ([IO.Path]::GetFullPath($x.F) -ieq $outFull) { throw '-Out nao pode ser um dos relatorios' } }
  }

  function Linha-Tabela([string]$nome, [object[]]$valores, [bool]$compara = $true) {
    $iguais = ($valores | ForEach-Object { Txt $_ } | Select-Object -Unique | Measure-Object).Count -le 1
    $marca = ''
    if ($compara -and -not $iguais) { $marca = '   <-- DIFERENTE'; $script:diferencas++ }
    Escreve ('  {0,-34} {1}{2}' -f $nome, (($valores | ForEach-Object { Txt $_ }) -join ' | '), $marca)
  }

  Escreve 'Comparacao de relatorios classification-audit (offline; so leitura dos .json indicados)'
  Escreve ('Relatorios: ' + (($R | ForEach-Object { $_.L }) -join ' | '))

  # ---------------------------------------------------------------- 1. cabecalho
  Titulo '1. Cabecalho e impressao do ambiente'
  Escreve ('  {0,-34} {1}' -f '(ordem das colunas)', (($R | ForEach-Object { $_.L }) -join ' | '))
  Linha-Tabela 'base de dados' ($R | ForEach-Object { Get-P $_.J 'cabecalho.baseDados' }) $false
  Linha-Tabela 'pacote / versao' ($R | ForEach-Object { (Txt (Get-P $_.J 'cabecalho.pacote.id')) + ' ' + (Txt (Get-P $_.J 'cabecalho.pacote.versao')) }) $false
  Linha-Tabela 'SQL Server' ($R | ForEach-Object { Get-P $_.J 'cabecalho.sqlServer' })
  Linha-Tabela 'schemaRelatorio' ($R | ForEach-Object { Get-P $_.J 'cabecalho.schemaRelatorio' }) $false
  Linha-Tabela 'impressao combinada (curta)' ($R | ForEach-Object { Get-P $_.J 'cabecalho.impressao.curta' })
  Linha-Tabela 'impressao do lookup (16)' ($R | ForEach-Object { $h = Get-P $_.J 'cabecalho.impressao.lookup'; if ($h) { $h.Substring(0, [Math]::Min(17, $h.Length)) } else { $null } })
  Linha-Tabela 'impressao colunas Stocks (16)' ($R | ForEach-Object { $h = Get-P $_.J 'cabecalho.impressao.colunasStocks'; if ($h) { $h.Substring(0, [Math]::Min(17, $h.Length)) } else { $null } })
  $imp = @(); $faltaImp = $false
  foreach ($x in $R) { $h = Get-P $x.J 'cabecalho.impressao.combinada'; if ($null -eq $h) { $faltaImp = $true } else { $imp += $h } }
  if ($faltaImp) { Escreve '  (algum relatorio nao tem impressao: e de uma versao anterior ao diagnostico v2)' }
  elseif (($imp | Select-Object -Unique | Measure-Object).Count -eq 1) { Escreve '  => impressoes IGUAIS: mesmo lookup Etico_NETT e mesmas colunas em Stocks.' }
  else { Escreve '  => impressoes DIFERENTES: ver lookup e colunas abaixo.' }

  # ---------------------------------------------------------------- 2. lookup
  Titulo '2. Lookup Etico_NETT (codigo -> descricao normalizada -> categoria proposta)'
  $codigos = @{}
  foreach ($x in $R) { foreach ($l in @(Get-P $x.J 'mapeamentoEticoNett.linhas')) { if ($null -ne $l) { $codigos["$($l.codigo)"] = 1 } } }
  foreach ($x in $R) {
    $enc = Get-P $x.J 'mapeamentoEticoNett.lookupEncontrado'
    Escreve ('  {0}: lookup {1}' -f $x.L, $(if ($null -eq $enc) { 'n/d (relatorio sem a seccao F)' } elseif ($enc) { 'encontrado (' + (Txt (Get-P $x.J 'mapeamentoEticoNett.tabela')) + ')' } else { 'AUSENTE' }))
  }
  if ($codigos.Count -eq 0) { Escreve '  (nenhum relatorio tem linhas de lookup)' }
  foreach ($c in ($codigos.Keys | Sort-Object { [int]($_ -replace '\D', '0') }, { $_ })) {
    $cel = @()
    foreach ($x in $R) {
      $l = @(Get-P $x.J 'mapeamentoEticoNett.linhas') | Where-Object { $null -ne $_ -and "$($_.codigo)" -eq $c } | Select-Object -First 1
      if ($l) { $cel += ('{0} -> {1} [{2}]' -f $l.descricaoCrua, $l.descricaoNormalizada, $l.categoriaProposta) } else { $cel += '(ausente)' }
    }
    Linha-Tabela ("codigo $c") $cel
  }
  foreach ($x in $R) {
    $al = @(Get-P $x.J 'mapeamentoEticoNett.alertas') | Where-Object { $_ }
    Escreve ('  alertas de {0}: {1}' -f $x.L, $(if ($al.Count -eq 0) { '(nenhum)' } else { '' }))
    foreach ($a in $al) { Escreve ('    - ' + $a) }
  }

  # ---------------------------------------------------------------- 3. colunas de Stocks
  Titulo '3. Colunas de dbo.Stocks'
  Linha-Tabela 'numero de colunas' ($R | ForEach-Object { Get-P $_.J 'stocksColunas.total' })
  $nomes = @{}
  foreach ($x in $R) { $set = @{}; foreach ($c in @(Get-P $x.J 'stocksColunas.colunas')) { if ($null -ne $c) { $set[("$($c.coluna)").ToLower()] = "$($c.coluna)" } }; $x.Cols = $set; foreach ($k in $set.Keys) { $nomes[$k] = 1 } }
  $sem = 0
  foreach ($k in ($nomes.Keys | Sort-Object)) {
    $faltam = @($R | Where-Object { -not $_.Cols.ContainsKey($k) } | ForEach-Object { $_.L })
    if ($faltam.Count -gt 0) { $sem++; $script:diferencas++; Escreve ("  coluna '{0}' NAO existe em: {1}" -f $k, ($faltam -join ', ')) }
  }
  if ($sem -eq 0 -and $nomes.Count -gt 0) { Escreve '  mesmas colunas em todos os relatorios.' }
  if ($nomes.Count -eq 0) { Escreve '  (relatorios sem a seccao B)' }
  # tipos diferentes na mesma coluna
  foreach ($k in ($nomes.Keys | Sort-Object)) {
    $tipos = @()
    foreach ($x in $R) { $c = @(Get-P $x.J 'stocksColunas.colunas') | Where-Object { $null -ne $_ -and ("$($_.coluna)").ToLower() -eq $k } | Select-Object -First 1; $tipos += $(if ($c) { "$($c.tipo)/$(if ($c.anulavel) { 'null' } else { 'notnull' })" } else { '-' }) }
    $u = @($tipos | Where-Object { $_ -ne '-' } | Select-Object -Unique)
    if ($u.Count -gt 1) { $script:diferencas++; Escreve ("  coluna '{0}' com tipo/anulabilidade diferente: {1}" -f $k, ($tipos -join ' | ')) }
  }

  # ---------------------------------------------------------------- 4. Generico
  Titulo '4. Generico: metadados SQL'
  foreach ($tab in @('dbo.Stocks', 'dbo.Stocks_Histo', 'dbo.Stocks_HistoF')) {
    $v = @()
    foreach ($x in $R) {
      $m = @(Get-P $x.J 'camposMeta') | Where-Object { $null -ne $_ -and $_.tabela -eq $tab -and $_.campo -eq 'Generico' } | Select-Object -First 1
      if ($m -and $m.tabelaExiste) { $v += ('{0}, anulavel={1}, default={2}, NULL={3}' -f $m.tipo, (Txt $m.anulavel), $(if ($m.padrao) { $m.padrao } else { '-' }), (Txt $m.nulos)) }
      elseif ($m) { $v += '(tabela inexistente)' } else { $v += 'n/d' }
    }
    Linha-Tabela "$tab.Generico" $v
  }
  Linha-Tabela 'perfil Stocks.Generico (0/1/NULL)' ($R | ForEach-Object { $p = Get-P $_.J 'generico.perfil'; if ($p) { '0={0} 1={1} NULL={2}' -f $p.categorias.zero, $p.categorias.um, $p.categorias.nulo } else { $null } }) $false

  # ---------------------------------------------------------------- 5. contagens
  Titulo '5. Contagens por categoria (universos ERP)'
  foreach ($cat in @('ETICO', 'NETT', 'SERVICO', 'SACOS', 'OUTROS', 'UNKNOWN', 'SEM_CLASSIFICACAO')) {
    Linha-Tabela "total ERP: $cat" ($R | ForEach-Object { Get-P $_.J "universos.erpTotal.distribuicao.porCategoria.$cat" }) $false
  }
  Linha-Tabela 'total ERP: artigos' ($R | ForEach-Object { Get-P $_.J 'universos.erpTotal.distribuicao.total' }) $false
  Linha-Tabela 'total ERP: Generico=1' ($R | ForEach-Object { Get-P $_.J 'universos.erpTotal.distribuicao.porGenerico.um' }) $false
  Linha-Tabela 'total ERP: Generico=NULL' ($R | ForEach-Object { Get-P $_.J 'universos.erpTotal.distribuicao.porGenerico.nulo' }) $false
  Linha-Tabela 'sincronizavel daily: artigos' ($R | ForEach-Object { Get-P $_.J 'universos.sincronizavel.daily.total' }) $false
  Linha-Tabela 'sincronizavel bootstrap: artigos' ($R | ForEach-Object { Get-P $_.J 'universos.sincronizavel.bootstrapAtivo.total' }) $false
  Linha-Tabela 'Servicos: ERP / incl. / excl. (daily)' ($R | ForEach-Object { $s = Get-P $_.J 'universos.sincronizavel.servicos'; if ($s) { '{0} / {1} / {2}' -f $s.totalErp, $s.incluidosDaily, $s.excluidosDaily } else { $null } }) $false
  Escreve '  (contagens diferentes entre farmacias sao esperadas; o que importa e a ESTRUTURA igual: ver 1 a 4)'

  # ---------------------------------------------------------------- 6. Processa_Stocks
  Titulo '6. Processa_Stocks'
  Linha-Tabela 'total de artigos' ($R | ForEach-Object { Get-P $_.J 'servicos.total' }) $false
  Linha-Tabela 'Processa_Stocks = 0' ($R | ForEach-Object { Get-P $_.J 'servicos.zero' }) $false
  Linha-Tabela 'Processa_Stocks <> 0' ($R | ForEach-Object { Get-P $_.J 'servicos.diferenteDeZero' }) $false
  Linha-Tabela 'Processa_Stocks NULL' ($R | ForEach-Object { Get-P $_.J 'servicos.nulos' }) $false
  Linha-Tabela 'catalogo ativo bootstrap' ($R | ForEach-Object { Get-P $_.J 'servicos.ativosBootstrap' }) $false

  # ---------------------------------------------------------------- 7. MT
  Titulo '7. Universo MT, cobertura e divergencias MT x ERP'
  Linha-Tabela 'universo MT calculado' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.calculado' }) $false
  Linha-Tabela 'CNPs no MT (unicos)' ($R | ForEach-Object { Get-P $_.J 'universos.existenteNoMt.cnpsNoMt' }) $false
  Linha-Tabela 'encontrados no ERP' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.encontradosNoErp' }) $false
  Linha-Tabela 'NAO encontrados no ERP' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.naoEncontradosNoErp' }) $false
  Linha-Tabela '% com categoria mapeada' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.classificacao.pctMapeada' }) $false
  Linha-Tabela 'fora do filtro daily (MT)' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.foraDoFiltro.daily.total' }) $false
  Linha-Tabela 'Servicos no MT' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.servicos.noMt' }) $false
  Linha-Tabela 'Generico: concordantes' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.generico.concordantes' }) $false
  Linha-Tabela 'Generico: divergentes' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.generico.divergentes' }) $false
  Linha-Tabela '  explicadas por manual' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.generico.divergentesExplicadasPorManual' }) $false
  Linha-Tabela '  NAO explicadas (manual=0)' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.generico.divergentesNaoExplicadas' }) $false
  Linha-Tabela '  sem informacao de manual' ($R | ForEach-Object { Get-P $_.J 'universos.coberturaMt.generico.divergentesSemManual' }) $false
  foreach ($x in $R) {
    $c = Get-P $x.J 'universos.coberturaMt.generico.conclusao'
    if ($c) { Escreve ('  leitura {0}: {1}' -f $x.L, $c) }
  }

  # ---------------------------------------------------------------- resumo
  Titulo 'Resumo'
  if ($script:diferencas -eq 0) { Escreve '  Nenhuma diferenca estrutural relevante entre os relatorios (impressao, lookup, colunas, metadados de Generico).' }
  else { Escreve ("  {0} diferenca(s) estrutural(is) assinalada(s) com '<-- DIFERENTE' ou listadas acima: validar o mapeamento farmacia a farmacia." -f $script:diferencas) }

  $texto = ($script:linhas -join "`r`n") + "`r`n"
  Write-Output $texto
  if ($Out) {
    $dir = Split-Path -Parent $outFull
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($outFull, $texto, (New-Object Text.UTF8Encoding($false)))
  }
  exit 0
}
catch {
  Write-Host "ERRO: $($_.Exception.Message)"
  exit 1
}
