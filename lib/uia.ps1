param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [int]$Depth = 3,
  [int]$Max = 80,
  [string]$Action = '',
  [string]$Match = ''
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
$found = $null

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

function Walk($el, $level) {
  if ($null -eq $el) { return }
  if ($out.Count -ge $Max) { return }
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
    [void]$out.Add((New-Object psobject -Property $item))
    if ($Match -ne '' -and $null -eq $script:found -and $name -ne '' -and $name.ToLower().Contains($Match.ToLower())) {
      $script:found = @{ el = $el; name = $name; pats = @($pats) }
    }
  } catch { }

  if ($level -ge $Depth -and -not ($Match -ne '' -and $null -eq $script:found)) { return }
  if ($level -ge 12) { return }
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { }
  while ($null -ne $child) {
    Walk $child ($level + 1)
    if ($out.Count -ge $Max -or ($Match -ne '' -and $null -ne $script:found)) { return }
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
}

Walk $root 0

$result = [ordered]@{
  ok       = $true
  count    = $out.Count
  title    = [string]$root.Current.Name
  cls      = [string]$root.Current.ClassName
  elements = @($out)
}

if ($Action -ne '') {
  if ($null -eq $script:found) {
    $result.action = $Action
    $result.ok = $false
    $result.error = "no element matching '$Match'"
  } else {
    $el = $script:found.el
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
    $result.matched = $script:found.name
    $result.patterns = @($script:found.pats)
    $result.done = $done
    if (-not $done -and -not $result.Contains('error')) { $result.error = "element has no $Action pattern" }
  }
}

($result | ConvertTo-Json -Depth 5 -Compress)
