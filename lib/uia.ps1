param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [int]$Depth = 3,
  [int]$Max = 80,
  [string]$Action = '',
  [string]$Match = '',
  [string]$MatchMode = 'auto',
  [string]$Role = '',
  [string]$Value = '',
  [switch]$Focused,
  [switch]$Find,
  [switch]$Text
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

# ---- 直接写值（ValuePattern.SetValue）：最快、不动剪贴板、不抢焦点 ----
if ($Action -eq 'setvalue') {
  $r = @{ ok = $false; via = 'value'; wrote = $false; readback = ''; role = ''; name = '' }
  $el = $null
  try {
    if ($Match -ne '') {
      $q = $Match.ToLower()
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($c in $all) {
        $n = ''
        try { $n = [string]$c.Current.Name } catch { }
        $vp0 = $null
        $hasVal = $false
        try { $hasVal = $c.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp0) } catch { }
        if ($hasVal -and $n -and $n.ToLower().Contains($q)) { $el = $c; break }
      }
    } else {
      $el = [System.Windows.Automation.AutomationElement]::FocusedElement
      # 焦点元素必须真的属于这个窗口，否则宁可不写（防止写进别的程序）
      $inside = $false
      $cur = $el
      for ($i = 0; $i -lt 40 -and $cur; $i++) {
        try { if ($cur.Equals($root)) { $inside = $true; break } } catch { }
        try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
      }
      if (-not $inside) {
        # 焦点不在这个窗口：退而求其次，找窗口里唯一一个可写控件（全在窗口范围内，安全）
        $edits = New-Object System.Collections.ArrayList
        $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($c in $all) {
          $vp0 = $null
          $hasVal = $false
          try { $hasVal = $c.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp0) } catch { }
          if (-not $hasVal) { continue }
          $ro = $true
          try { $ro = [bool]$vp0.Current.IsReadOnly } catch { }
          if ($ro) { continue }
          $nm = ''
          try { $nm = [string]$c.Current.Name } catch { }
          [void]$edits.Add(@{ el = $c; name = $nm })
        }
        if ($edits.Count -eq 1) {
          $el = $edits[0].el
          $r.via = 'value-alone'
        } elseif ($edits.Count -gt 1) {
          $names = (@($edits | ForEach-Object { "'" + $_.name + "'" }) -join ', ')
          $r.error = "this window has $($edits.Count) writable fields: $names — pass match to choose one"
          ($r | ConvertTo-Json -Depth 4 -Compress); exit 0
        } else {
          $r.error = 'focused element is not in this window, and the window exposes no writable field'
          ($r | ConvertTo-Json -Depth 4 -Compress); exit 0
        }
      }
    }
  } catch { }
  if (-not $el) { '{"ok":false,"via":"value","error":"no value-pattern element (pass match, or focus the field first)"}'; exit 0 }
  try { $r.role = [string]$el.Current.ControlType.ProgrammaticName } catch { }
  try { $r.name = [string]$el.Current.Name } catch { }
  $vp = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $readonly = $false
      try { $readonly = [bool]$vp.Current.IsReadOnly } catch { }
      if (-not $readonly) {
        $vp.SetValue($Value)
        $r.wrote = $true
        try { $r.readback = [string]$vp.Current.Value } catch { }
        $r.ok = ($r.readback -eq $Value)
        if (-not $r.ok) { $r.error = 'readback mismatch' }
      } else { $r.error = 'control is read-only' }
    } else { $r.error = 'element has no ValuePattern' }
  } catch { $r.error = $_.Exception.Message }
  ($r | ConvertTo-Json -Depth 4 -Compress)
  exit 0
}


# ---- 精确读文本（不靠 OCR）：TextPattern.DocumentRange / ValuePattern / Name ----
if ($Text) {
  $el = $null
  try {
    if ($Match -ne '') {
      $q = $Match.ToLower()
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($c in $all) {
        $n = ''
        try { $n = [string]$c.Current.Name } catch { }
        if ($n -and $n.ToLower().Contains($q)) { $el = $c; break }
      }
    } else {
      $order = @(
        [System.Windows.Automation.ControlType]::Document,
        [System.Windows.Automation.ControlType]::Edit
      )
      foreach ($ct in $order) {
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
        $hit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($hit) { $el = $hit; break }
      }
      if (-not $el) { $el = $root }
    }
  } catch { }

  if (-not $el) {
    '{"ok":false,"error":"no element found"}'
    exit 0
  }

  $r = @{ ok = $false; via = ''; text = ''; role = ''; name = '' }
  try { $r.role = [string]$el.Current.ControlType.ProgrammaticName } catch { }
  try { $r.name = [string]$el.Current.Name } catch { }
  $tp = $null
  $vp = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $r.text = [string]$tp.DocumentRange.GetText(-1)
      $r.via = 'text'
      $r.ok = $true
    } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $r.text = [string]$vp.Current.Value
      $r.via = 'value'
      $r.ok = $true
    }
  } catch { $r.error = $_.Exception.Message }
  if (-not $r.ok -and -not $r.ContainsKey('error')) {
    # 控件本身没有文本模式：退回读它的子节点文字
    try {
      $parts = New-Object System.Collections.ArrayList
      $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $i = 0
      foreach ($c in $all) {
        if ($i -ge 300) { break }
        $i++
        try {
          $n = [string]$c.Current.Name
          if ($n) { [void]$parts.Add($n) }
        } catch { }
      }
      if ($parts.Count -gt 0) { $r.text = ($parts -join "`n"); $r.via = 'names'; $r.ok = $true }
    } catch { }
  }
  if ($r.ok) { $r.text = ($r.text -replace "`r`n", "`n") -replace "`r", "`n" }
  ($r | ConvertTo-Json -Depth 4 -Compress)
  exit 0
}


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
