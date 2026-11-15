# 把本仓库同步到已安装的 profile 副本（pnpm file: 安装的是副本，不是软链）
# 以前只同步 lib\*.mjs，客户端半（composer.js）改了不会生效，页面上看起来"改了没用"。
$dst = "C:\Users\xjy\.dsh\profiles\desktop\node_modules\dsh-desktop-sidecar"
if (-not (Test-Path $dst)) { Write-Error "not installed: $dst"; exit 1 }

Copy-Item "$PSScriptRoot\..\lib\*" "$dst\lib" -Recurse -Force
Copy-Item "$PSScriptRoot\..\package.json" "$dst\package.json" -Force
Copy-Item "$PSScriptRoot\..\cordis.patch.yml" "$dst\cordis.patch.yml" -Force
Copy-Item "$PSScriptRoot\..\icon.svg" "$dst\icon.svg" -Force
foreach ($extra in @('README.md', 'CHANGELOG.md')) {
  $src = Join-Path "$PSScriptRoot\.." $extra
  if (Test-Path $src) { Copy-Item $src (Join-Path $dst $extra) -Force }
}
if (Test-Path "$PSScriptRoot\..\locale") { Copy-Item "$PSScriptRoot\..\locale\*" "$dst\locale" -Recurse -Force }
if (Test-Path "$PSScriptRoot\..\skills") { Copy-Item "$PSScriptRoot\..\skills\*" "$dst\skills" -Recurse -Force }

Write-Output "synced -> $dst"
