# 把本仓库的 lib 同步到已安装的 profile 副本（pnpm file: 安装的是副本，不是软链）
$dst = "C:\Users\xjy\.dsh\profiles\desktop\node_modules\dsh-desktop-sidecar"
if (-not (Test-Path $dst)) { Write-Error "not installed: $dst"; exit 1 }
Copy-Item "$PSScriptRoot\..\lib\*.mjs" "$dst\lib" -Force
Copy-Item "$PSScriptRoot\..\lib\ocr.ps1" "$dst\lib" -Force
Write-Output "synced lib -> $dst"
