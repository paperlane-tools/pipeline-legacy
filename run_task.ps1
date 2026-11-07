<#
run_task.ps1 —— 一套题跑到底：识图 → 程序请求 AI 判题 → 程序提交 → 交卷 → 归档

用法：
  .\scripts\run_task.ps1 -TaskIndex 0                 # 从任务列表第 0 项开始（自动取 tmid）
  .\scripts\run_task.ps1 -Tmid 547942                 # 已经 fetch 过的卷子直接跑
  .\scripts\run_task.ps1 -Tmid 547942 -NoFinal        # 不交卷（只写答案）
  .\scripts\run_task.ps1 -TaskIndex 0 -PlanOnly       # 只打印将执行的命令
#>
param(
    [string]$Tmid = "",
    [int]$TaskIndex = -1,
    [switch]$NoFinal,
    [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
$scripts = $PSScriptRoot
$root = Split-Path -Parent $scripts
$py = if ($env:YZJ_PYTHON) { $env:YZJ_PYTHON } else { (Get-Command python).Source }
$node = if ($env:YZJ_NODE) { $env:YZJ_NODE } else {
    "C:\Users\work\AppData\Local\OpenAI\Codex\runtimes\cua_node\b63ee7ee40c23b77\bin\node.exe"
}

function Invoke-Step([string]$Label, [string]$Exe, [string[]]$StepArgs) {
    $line = "$Exe $($StepArgs -join ' ')"
    if ($PlanOnly) { Write-Host "[plan] $Label : $line" -ForegroundColor Yellow; return }
    Write-Host "== $Label ==" -ForegroundColor Cyan
    & $Exe @StepArgs
    if ($LASTEXITCODE -ne 0) { throw "$Label 失败（exit=$LASTEXITCODE）" }
}

# 1) 需要的话先把卷子取回来并识图
if ($TaskIndex -ge 0) {
    if ($PlanOnly) {
        Write-Host "[plan] fetch/ocr/parse：取任务列表第 $TaskIndex 项并识图" -ForegroundColor Yellow
    } else {
        $out = & $py "$scripts\paper_pipeline.py" fetch --task $TaskIndex
        $out | Write-Host
        $Tmid = ([regex]::Match(($out -join "`n"), "tmid=(\d+)")).Groups[1].Value
        if (-not $Tmid) { throw "没能从 fetch 输出里解析出 tmid" }
        Invoke-Step "OCR 识图"   $py @("$scripts\paper_pipeline.py", "ocr",   "--tmid", $Tmid)
        Invoke-Step "结构还原"   $py @("$scripts\paper_pipeline.py", "parse", "--tmid", $Tmid)
    }
} elseif (-not $Tmid) {
    throw "需要 -Tmid 或 -TaskIndex"
} elseif (-not $PlanOnly -and -not (Test-Path "$root\outputs\record\$Tmid\parsed.json")) {
    throw "没有 $Tmid 的识图结果，请先跑 fetch/ocr/parse，或用 -TaskIndex N"
}

if (-not $Tmid) { $Tmid = "<第 1 步确定>" }   # PlanOnly 时仅用于展示
$rec = "$root\outputs\record\$Tmid"

# 2) 程序自己请求 AI 判题（需要 config.json 里的 api_key）
Invoke-Step "AI 判题"      $py   @("$scripts\paper_pipeline.py", "ai-solve", "--tmid", $Tmid, "--allow-upload")
# 3) 程序提交答案
Invoke-Step "提交答案"     $py   @("$scripts\paper_pipeline.py", "submit", "--tmid", $Tmid, "--yes")
# 4) 交卷（可选）
if (-not $NoFinal) { Invoke-Step "交卷" $node @("$scripts\finalize.mjs", "--tmid", $Tmid) }
# 5) 归档
Invoke-Step "回读批改"     $py   @("$scripts\paper_pipeline.py", "verify", "--tmid", $Tmid)
Invoke-Step "生成报告"     $py   @("$scripts\paper_pipeline.py", "report", "--tmid", $Tmid)

Write-Host "完成：$rec\report.md" -ForegroundColor Green
