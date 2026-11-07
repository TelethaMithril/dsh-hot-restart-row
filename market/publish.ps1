<#
.SYNOPSIS
  把 dsh-hot-restart-row 推成 GitHub 仓库（可选顺手发 npm）。

.DESCRIPTION
  等价于手工执行 git init / add / commit / remote / push。脚本只做这些事，
  不会碰 profile、不会重装插件、不会改其他文件。

  上架到市场还需要两步人工操作（见 market/PUBLISH.md）：
    1. 仓库 Settings -> Topics 加 `dsh-plugin`
    2. 给 awesome-dsh-plugin 提一个只加 data/plugins/TelethaMithril__dsh-hot-restart-row.yml 的 PR

.EXAMPLE
  pwsh -File market/publish.ps1
  pwsh -File market/publish.ps1 -Npm          # 同时 npm publish --access public
#>
[CmdletBinding()]
param(
  [string]$Owner = 'TelethaMithril',
  [string]$Repo = 'dsh-hot-restart-row',
  [string]$Message = 'dsh-hot-restart-row: Hot restart row under Sign out',
  [switch]$Npm
)

$ErrorActionPreference = 'Stop'

# 包根目录 = 本脚本的上一级（market/ 的兄弟）
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw '找不到 git，请先安装 Git for Windows。'
}

if (-not (Test-Path (Join-Path $root '.git'))) {
  Write-Host '==> git init -b main'
  git init -b main
} else {
  Write-Host '==> 已有 .git，跳过 init'
}

Write-Host '==> git add -A'
git add -A

$staged = @(git diff --cached --name-only)
if ($staged.Count -gt 0) {
  Write-Host "==> git commit（$($staged.Count) 个文件）"
  git commit -m $Message
} else {
  Write-Host '==> 没有待提交的改动，跳过 commit'
}

$url = "https://github.com/$Owner/$Repo.git"
$remotes = @(git remote)
if ($remotes -contains 'origin') {
  Write-Host "==> git remote set-url origin $url"
  git remote set-url origin $url
} else {
  Write-Host "==> git remote add origin $url"
  git remote add origin $url
}

Write-Host '==> git push -u origin main'
git push -u origin main

if ($Npm) {
  Write-Host '==> npm publish --access public'
  npm publish --access public
}

Write-Host ''
Write-Host '完成。还剩两步人工操作：'
Write-Host "  1. 给 $Owner/$Repo 加 topic：dsh-plugin"
Write-Host '  2. 给 awesome-dsh-plugin 提 PR：只加 data/plugins/TelethaMithril__dsh-hot-restart-row.yml'
Write-Host '详情见 market/PUBLISH.md'
