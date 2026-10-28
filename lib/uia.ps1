param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [int]$Depth = 3,
  [int]$Max = 80,
  [string]$Action = '',
  [string]$Match = '',
  [string]$MatchMode = 'auto',
  [string]$Role = '',
  [switch]$Find
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$h = [IntPtr][int64]$Hwnd
$root = $AE::FromHandle($h)
if ($null -eq $root) { '{"ok":false,"error":"FromHandle returned null"}'; exit 0 }

$out = New-Object System.Collections.ArrayList
$cands = New-Object System.Collections.ArrayList
$script:nodes = 0
$needResolve = $Find -or ($Action -ne '')
$q = $Match.ToLower()
$roleFilter = $Role.ToLower()

function Get-Patterns($el) {
  $names = New-Object System.Collections.ArrayList
  $defs = @(
    @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
    @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
    @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
    @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
    @('ScrollItem', [System.Windows.Automation.ScrollItemPattern]::Pattern),
    @('Text', [System.Windows.Automation.TextPattern]::Pattern)
  )
  foreach ($p in $defs) {
    $obj = $null
    try { if ($el.TryGetCurrentPattern($p[1], [ref]$obj)) { [void]$names.Add($p[0]) } } catch { }
  }
  return , $names.ToArray()
}

function ActionPatternName($action) {
  switch ($action) {
    'invoke' { return 'Invoke' }
    'toggle' { return 'Toggle' }
    'select' { return 'SelectionItem' }
    'expand' { return 'ExpandCollapse' }
    'focus'  { return '' }
  }
  return ''
}

$wantPat = ActionPatternName $Action

function Walk($el, $level) {
  if ($null -eq $el) { return }
  if ($out.Count -ge $Max) { return }
  $script:nodes = $script:nodes + 1
  if ($script:nodes -gt ($Max * 4)) { return }
  $name = ''
  try {
    $c = $el.Current
    $name = [string]$c.Name
    $type = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    $r = $c.BoundingRectangle
    $pats = Get-Patterns $el
    $item = [ordered]@{
      name  = $name
      role  = $type
      x     = [int]$r.X
      y     = [int]$r.Y
      w     = [int]$r.Width
      h     = [int]$r.Height
      depth = $level
      pats  = @($pats)
    }
    if (-not $needResolve) { [void]$out.Add((New-Object psobject -Property $item)) }

    if ($Match -ne '' -and $name -ne '') {
      $ln = $name.ToLower()
      $isExact = ($ln -eq $q)
      $isPart = $isExact -or $ln.Contains($q)
      if ($isPart -and $roleFilter -ne '' -and $type.ToLower() -ne $roleFilter) { $isPart = $false }
      if ($isPart) {
        $hasAction = $true
        if ($wantPat -ne '') { $hasAction = (@($pats) -contains $wantPat) }
        $rect = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
        [void]$cands.Add([pscustomobject]@{
          el = $el; name = $name; role = $type; exact = $isExact; hasAction = $hasAction
          pats = @($pats); rect = $rect
        })
      }
    }
  } catch { }

  if ($out.Count -ge $Max) { return }
  if ($level -ge 12) { return }
  if ($level -ge $Depth -and -not $needResolve) { return }
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { }
  while ($null -ne $child) {
    Walk $child ($level + 1)
    if ($out.Count -ge $Max) { return }
    if ($script:nodes -gt ($Max * 4)) { return }
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
}

Walk $root 0

$result = [ordered]@{
  ok    = $true
  title = [string]$root.Current.Name
  cls   = [string]$root.Current.ClassName
}

if (-not $needResolve) {
  $result.count = $out.Count
  $result.elements = @($out)
  ($result | ConvertTo-Json -Depth 5 -Compress)
  exit 0
}

# 选择命中：exact 优先，其次具备目标动作能力；substring 仅在唯一时自动使用
$picked = $null
$exactPool = @($cands | Where-Object { $_.exact })
$subPool = @($cands)

if ($MatchMode -eq 'exact') { $pool = $exactPool }
elseif ($MatchMode -eq 'substring') { $pool = $subPool }
else { if ($exactPool.Count -gt 0) { $pool = $exactPool } else { $pool = $subPool } }

$matchKind = $null
if ($pool.Count -gt 0) { $matchKind = $(if ($pool[0].exact) { 'exact' } else { 'substring' }) }

if ($pool.Count -gt 0) {
  $withAction = @($pool | Where-Object { $_.hasAction })
  $pickFrom = $(if ($withAction.Count -gt 0) { $withAction } else { $pool })
  $picked = $pickFrom[0]
  $result.matchKind = $matchKind
  $result.matched = $picked.name
  $result.matchedRole = $picked.role
  $result.rect = $picked.rect
  $result.patterns = @($picked.pats)
  if ($pickFrom.Count -gt 1) {
    $result.ambiguous = $true
    $result.candidates = @($pickFrom | Select-Object -First 8 | ForEach-Object {
        [ordered]@{ name = $_.name; role = $_.role; rect = $_.rect; patterns = @($_.pats) }
      })
  }
} else {
  $result.ok = $false
  $result.matchKind = 'none'
  $result.error = "no control named '$Match'" + $(if ($roleFilter -ne '') { " with role '$Role'" } else { '' })
  $sug = @($cands | Select-Object -First 6 | ForEach-Object { $_.name })
  if ($sug.Count -eq 0 -and $Match -ne '') {
    $sug = @($out | Where-Object { $_.name -ne '' -and ($_.name.ToLower().Contains($q) -or $q.Contains($_.name.ToLower())) } |
      Select-Object -First 6 -ExpandProperty name)
  }
  if ($sug.Count -gt 0) { $result.suggestions = $sug }
}

$isAmbiguous = ($result.Contains('ambiguous') -and $result.ambiguous)

if ($picked -and $Action -ne '' -and -not $isAmbiguous) {
  $el = $picked.el
  $done = $false
  try {
    switch ($Action) {
      'invoke' {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
          $p.Invoke(); $done = $true
        }
      }
      'toggle' {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
          $p.Toggle(); $done = $true
        }
      }
      'select' {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
          $p.Select(); $done = $true
        }
      }
      'expand' {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
          $p.Expand(); $done = $true
        }
      }
      'focus' {
        $el.SetFocus(); $done = $true
      }
    }
  } catch { $result.error = $_.Exception.Message }
  $result.action = $Action
  $result.done = $done
  if (-not $done -and -not $result.Contains('error')) { $result.error = "element has no $Action pattern" }
}

if ($isAmbiguous -and $Action -ne '') {
  $result.ok = $false
  $result.done = $false
  $result.action = $Action
  $names = (@($result.candidates | ForEach-Object { "'" + $_.name + "'" }) -join ', ')
  $result.error = "'$Match' matched " + $pickFrom.Count + " controls " + $names + ". Nothing was invoked: pass an exact name, add role, or set match=substring to allow the first one."
}

($result | ConvertTo-Json -Depth 6 -Compress)
