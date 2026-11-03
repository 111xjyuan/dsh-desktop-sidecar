#!/usr/bin/env bash
set -e
cd /d/dsh-plugins/dsh-desktop-sidecar
P="/c/Users/xjy/.dsh/profiles/desktop/node_modules/dsh-desktop-sidecar"
cp lib/*.mjs lib/*.js lib/*.ps1 "$P/lib/"
cp package.json CHANGELOG.md README.md "$P/"
mkdir -p "$P/skills/desktop-sidecar"
cp skills/desktop-sidecar/SKILL.md "$P/skills/desktop-sidecar/"
node -e "import('file:///C:/Users/xjy/.dsh/profiles/desktop/node_modules/dsh-desktop-sidecar/lib/index.js').then(m=>console.log('profile LOADED '+Object.keys(m).join(',')))"
git add -A
git -c user.name=xjyuan -c user.email=xjyuan@users.noreply.github.com commit -q -m "0.9.0: 不打断看得见、判断可核查、指挥台不再闪、输入核对不再谎报"
git log --oneline -1
