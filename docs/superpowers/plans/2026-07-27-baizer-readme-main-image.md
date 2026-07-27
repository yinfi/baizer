# Baizer README 主图实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 `gpt-image-2` 生成一张符合已批准设计的 Baizer 手绘知识闭环主图，并让中英文 README 共用该仓库内资源。

**Architecture:** 候选图、提示词、调用标记和任务标记只存在于系统临时目录；每次实际生成前都用 `apply_patch` 创建不可复用的调用标记，所有失败调用均计入最多三次的总上限，CLI 内部重试不单独计数。只有通过原图和约 900 像素 README 显示宽度检查的最终 PNG 才进入 `assets/`，随后以最小差异替换两份 README 的图片引用。

**Tech Stack:** `@codex-image2` Windows x64 CLI、`gpt-image-2`、PowerShell、Markdown、npm/esbuild、`@superpowers:verification-before-completion`

---

## Chunk 1: 生成、集成与验证

### Task 1: 建立安全的仓库外候选区

**Files:**
- Create outside repository: `%TEMP%\baizer-readme-image-20260727-task\`
- Reference: `docs/superpowers/specs/2026-07-27-baizer-readme-main-image-design.md`

- [ ] **Step 1: 创建一个拒绝复用的固定候选目录**

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$expectedDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
if ($candidateDir -ne $expectedDir) { throw "Unexpected candidate path: $candidateDir" }
if (Test-Path -LiteralPath $candidateDir) { throw "Candidate directory already exists; refusing to reuse it: $candidateDir" }
New-Item -ItemType Directory -Path $candidateDir | Out-Null
$status = git status --porcelain
if ($status) { throw "Unexpected pre-existing worktree changes: $($status -join ', ')" }
```

Expected: 创建全新的候选目录；工作区保持干净。

- [ ] **Step 2: 用 `apply_patch` 创建任务标记和第一版 UTF-8 提示词**

Create `%TEMP%\baizer-readme-image-20260727-task\.task-marker` with exact content `baizer-readme-image-20260727`, then create `prompt-v1.txt` with this exact content:

```text
Asset type: Landscape hero illustration for the Baizer GitHub README.
Primary request: Show Baizer as an AI-native knowledge loop inside Obsidian: CAPTURE, PROCESS, REMEMBER, and CONSUME, with knowledge flowing back to improve the next piece of work.
Scene/backdrop: Warm off-white textured paper with generous whitespace.
Subject: A user and three simple input icons labeled Web, Video, and Notes enter a Workbench on the left. A restrained abstract Baizer AI Agent orchestration hub sits near the center, using a subtle faceted obsidian-crystal motif rather than a robot or brain. A clear left-to-right hand-drawn flow connects four stages and ends in a polished structured notebook page. A broad curved return arrow below completes the loop. Small supporting icons suggest Guardian, Skills & Tools, Hindsight, and Knowledge Wiki.
Style/medium: Sophisticated editorial technical illustration, hand-drawn pencil and black ink, slightly imperfect natural strokes, light blue-gray washes, restrained amber-yellow highlights, professional rather than childish.
Composition/framing: Landscape 3:2 composition, balanced horizontal reading order, large readable stage labels, clean visual hierarchy, no nested panels, enough negative space around every label.
Color palette: Warm white paper, charcoal ink, muted blue-gray, small amber-yellow accents for memory and feedback.
Text (verbatim): "Web", "Video", "Notes", "Workbench", "Baizer AI Agent", "CAPTURE", "PROCESS", "REMEMBER", "CONSUME", "Guardian", "Skills & Tools", "Hindsight", "Knowledge Wiki", "Knowledge compounds".
Constraints: Render every quoted label exactly once with exact spelling. Make the six primary labels especially large and readable: Baizer AI Agent, CAPTURE, PROCESS, REMEMBER, CONSUME, Knowledge compounds. Make the flow direction and return loop unmistakable. Keep the structured notebook page visibly organized but do not put tiny writing inside it.
Avoid: Cartoon brain, robot mascot, mechanical arms, plugin gears, photorealism, 3D rendering, gradients, clutter, long explanatory sentences, illegible microtext, misspelled labels, duplicated labels, random letters, extra logos, dark background.
```

Expected: 提示词只位于候选目录；未记录或输出 API 密钥。

- [ ] **Step 3: dry-run 验证请求**

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
if ((Get-Content -Raw (Join-Path $candidateDir '.task-marker')).Trim() -ne 'baizer-readme-image-20260727') { throw 'Task marker mismatch' }
& 'C:\Users\Administrator\.codex\skills\codex-image2\bin\codex-image2-windows-amd64.exe' generate `
  --prompt-file (Join-Path $candidateDir 'prompt-v1.txt') --model 'gpt-image-2' `
  --size '1536x1024' --quality 'high' --out (Join-Path $candidateDir 'candidate-v1.png') --dry-run
if ($LASTEXITCODE -ne 0) { throw "dry-run failed: $LASTEXITCODE" }
```

Expected: 成功验证 `gpt-image-2`、`1536x1024`、`high`；不发起网络请求，也不改变计数器。

### Task 2: 有限生成并验收候选图

**Files:**
- Create outside repository: `%TEMP%\baizer-readme-image-20260727-task\candidate-v1.png`
- Optional outside repository: `prompt-v2.txt`, `candidate-v2.png`, `prompt-v3.txt`, `candidate-v3.png`

- [ ] **Step 1: 用不可复用的调用标记和计数守卫生成候选 1**

First use `apply_patch` to create `%TEMP%\baizer-readme-image-20260727-task\attempt-1.marker` with exact content `candidate-v1|high|prompt-v1.txt`. Then run:

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
if ((Get-Content -Raw (Join-Path $candidateDir '.task-marker')).Trim() -ne 'baizer-readme-image-20260727') { throw 'Task marker mismatch' }
$attempts = @(Get-ChildItem -LiteralPath $candidateDir -Filter 'attempt-*.marker')
if ($attempts.Count -ne 1 -or (Get-Content -Raw (Join-Path $candidateDir 'attempt-1.marker')).Trim() -ne 'candidate-v1|high|prompt-v1.txt') { throw 'Attempt 1 marker mismatch' }
& 'C:\Users\Administrator\.codex\skills\codex-image2\bin\codex-image2-windows-amd64.exe' generate `
  --prompt-file (Join-Path $candidateDir 'prompt-v1.txt') --model 'gpt-image-2' `
  --size '1536x1024' --quality 'high' --out (Join-Path $candidateDir 'candidate-v1.png')
if ($LASTEXITCODE -ne 0) { throw "candidate-v1 generation failed: $LASTEXITCODE" }
```

Expected: 只有一个调用标记，`candidate-v1.png` 存在。CLI 内部网络退避重试仍只算这一次调用。

- [ ] **Step 2: 用失败即抛错的方式验证 PNG 元数据**

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$version = 1
if ($version -notin 1,2,3) { throw 'Invalid candidate version' }
$candidatePath = Join-Path $candidateDir "candidate-v$version.png"
if (!(Test-Path -LiteralPath $candidatePath) -or (Get-Item -LiteralPath $candidatePath).Length -le 0) { throw 'Candidate PNG missing or empty' }
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($candidatePath)
try {
  if ($image.Width -ne 1536 -or $image.Height -ne 1024) { throw "Unexpected dimensions: $($image.Width)x$($image.Height)" }
  if ($image.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid) { throw "Unexpected image format: $($image.RawFormat.Guid)" }
} finally { $image.Dispose() }
```

Expected: 无异常，文件非空、可解码、格式为 PNG、尺寸精确为 `1536x1024`。

- [ ] **Step 3: 检查原图与 900 像素 README 预览**

Use `view_image` on `candidate-v1.png`. Then create and view a `900x600` preview:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
Add-Type -AssemblyName System.Drawing
$version = 1
$source = [System.Drawing.Image]::FromFile((Join-Path $candidateDir "candidate-v$version.png"))
try {
  $preview = New-Object System.Drawing.Bitmap 900,600
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($preview)
    try { $graphics.DrawImage($source, 0, 0, 900, 600) } finally { $graphics.Dispose() }
    $preview.Save((Join-Path $candidateDir "candidate-v$version-900.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $preview.Dispose() }
} finally { $source.Dispose() }
```

Pass criteria: warm paper and hand drawing; muted blue-gray plus restrained amber; clear `Web`/`Video`/`Notes` → `Workbench` → `Baizer AI Agent` → four stages → structured note flow; return arrow labeled `Knowledge compounds`; all six primary labels are correctly spelled and readable at 900 pixels; no forbidden elements, stray text, duplicates, or obvious artifacts.

- [ ] **Step 4: 仅在需要时执行候选 2 或 3 的完整生成命令**

For a visual-quality failure, use `apply_patch` to create `prompt-v2.txt` by reproducing every line of `prompt-v1.txt` and adding exactly one sentence to its `Constraints` line: `Typography correction: render every quoted label in clear, exact English lettering.`; `Flow correction: make the single left-to-right pipeline and the curved return arrow dominant.`; or `Style correction: use only pencil, ink, muted blue-gray wash, and sparse amber highlights.` Use `high`. For a retryable network failure after the CLI exhausts its own retries, reuse `prompt-v1.txt` unchanged and use `medium`. Before generating, use `apply_patch` to create `attempt-2.marker` containing the exact value `candidate-v2|<quality>|<promptName>`. Run this guarded command with the matching values:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$version = 2; $quality = 'high'; $promptName = 'prompt-v2.txt'
if ((Get-Content -Raw (Join-Path $candidateDir '.task-marker')).Trim() -ne 'baizer-readme-image-20260727') { throw 'Task marker mismatch' }
$attempts = @(Get-ChildItem -LiteralPath $candidateDir -Filter 'attempt-*.marker')
$mediumAttempts = @($attempts | Where-Object { (Get-Content -Raw $_.FullName).Trim() -match '\|medium\|' })
if ($mediumAttempts.Count -gt 1) { throw 'Only one medium-quality network fallback is allowed globally' }
if ($quality -eq 'medium' -and $mediumAttempts.Count -ne 1) { throw 'Medium fallback marker mismatch' }
if ($attempts.Count -ne $version -or (Get-Content -Raw (Join-Path $candidateDir "attempt-$version.marker")).Trim() -ne "candidate-v$version|$quality|$promptName") { throw 'Attempt marker mismatch' }
& 'C:\Users\Administrator\.codex\skills\codex-image2\bin\codex-image2-windows-amd64.exe' generate `
  --prompt-file (Join-Path $candidateDir $promptName) --model 'gpt-image-2' `
  --size '1536x1024' --quality $quality --out (Join-Path $candidateDir "candidate-v$version.png")
if ($LASTEXITCODE -ne 0) { throw "candidate-v$version generation failed: $LASTEXITCODE" }
```

For candidate 3, create `prompt-v3.txt` only for a visual correction, or reuse the prior prompt for a network retry. Create `attempt-3.marker` with the exact matching `candidate-v3|<quality>|<promptName>` value. For a visual correction set `$version = 3; $quality = 'high'; $promptName = 'prompt-v3.txt'`; for a network retry set `$version = 3; $quality = 'medium'` and set `$promptName` to the unchanged prior prompt name, but only if no earlier attempt marker contains `|medium|`. Then run the preceding parameterized guarded command. For candidate 2 and 3, set `$version` to the candidate number in both metadata and preview blocks above before running them; each must pass the same original-size and 900-pixel visual checks. Every actual CLI `generate` call, including failed calls and the single permitted medium-quality fallback, consumes one marker. If three markers exist without an accepted image, stop without creating `assets/` or modifying README files.

- [ ] **Step 5: 记录被选候选与实际质量并验证选择边界**

Use `apply_patch` to create exactly one selection marker named `selected-v1.marker`, `selected-v2.marker`, or `selected-v3.marker`; its exact content is the accepted call's `high` or `medium` quality. Then run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$selectionMarkers = @(Get-ChildItem -LiteralPath $candidateDir -Filter 'selected-v*.marker')
if ($selectionMarkers.Count -ne 1 -or $selectionMarkers[0].Name -notmatch '^selected-v([123])\.marker$') { throw 'Expected exactly one valid selection marker' }
$selectedVersion = [int]$Matches[1]; $selectedQuality = (Get-Content -Raw $selectionMarkers[0].FullName).Trim()
if ($selectedQuality -notin 'high','medium') { throw 'Invalid selected quality' }
$selectedCandidate = Join-Path $candidateDir "candidate-v$selectedVersion.png"
$attempt = (Get-Content -Raw (Join-Path $candidateDir "attempt-$selectedVersion.marker")).Trim()
if (!(Test-Path -LiteralPath $selectedCandidate) -or $attempt -notmatch "^candidate-v$selectedVersion\|$selectedQuality\|prompt-v[123]\.txt$") { throw 'Selection does not match an actual generation' }
```

Expected: 唯一选择标记只指向已通过验收的三个候选名之一，并记录实际质量。

### Task 3: 发布唯一资源并更新 README

**Files:**
- Create: `assets/baizer-knowledge-loop.png`
- Modify: `README.md:7`
- Modify: `README.zh-CN.md:7`

- [ ] **Step 1: 从受限选择复制最终 PNG**

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$selectionMarkers = @(Get-ChildItem -LiteralPath $candidateDir -Filter 'selected-v*.marker')
if ($selectionMarkers.Count -ne 1 -or $selectionMarkers[0].Name -notmatch '^selected-v([123])\.marker$') { throw 'Invalid selection marker' }
$selectedVersion = [int]$Matches[1]; $selectedQuality = (Get-Content -Raw $selectionMarkers[0].FullName).Trim()
if ($selectedQuality -notin 'high','medium') { throw 'Invalid selected quality' }
$selectedCandidate = Join-Path $candidateDir "candidate-v$selectedVersion.png"
if (!(Test-Path -LiteralPath $selectedCandidate)) { throw 'Selected candidate missing' }
if ((Get-Content -Raw (Join-Path $candidateDir "attempt-$selectedVersion.marker")).Trim() -notmatch "^candidate-v$selectedVersion\|$selectedQuality\|prompt-v[123]\.txt$") { throw 'Selected candidate has no matching generation marker' }
New-Item -ItemType Directory -Force -Path 'assets' | Out-Null
if (Test-Path -LiteralPath 'assets\baizer-knowledge-loop.png') { throw 'Refusing to overwrite existing final asset' }
Copy-Item -LiteralPath $selectedCandidate -Destination 'assets\baizer-knowledge-loop.png'
```

Expected: 最终资源存在；本任务未向 `assets/` 添加其他文件。

- [ ] **Step 2: 用 `apply_patch` 替换两个 README 的主图引用**

Apply in both files:

```diff
-![main](https://github.com/user-attachments/assets/d0ab9014-ea13-4300-8d76-d8839fd0c046)
+![Baizer knowledge loop](assets/baizer-knowledge-loop.png)
```

- [ ] **Step 3: 对 README 引用执行精确断言**

Run:

```powershell
$files = 'README.md','README.zh-CN.md'
$new = '![Baizer knowledge loop](assets/baizer-knowledge-loop.png)'
$old = 'd0ab9014-ea13-4300-8d76-d8839fd0c046'
$newCount = @($files | ForEach-Object { Select-String -LiteralPath $_ -SimpleMatch $new }).Count
$oldCount = @($files | ForEach-Object { Select-String -LiteralPath $_ -SimpleMatch $old }).Count
if ($newCount -ne 2) { throw "Expected 2 new image references, found $newCount" }
if ($oldCount -ne 0) { throw "Old image reference still present $oldCount time(s)" }
```

Expected: 新引用正好 2 处，旧附件 ID 为 0 处。

### Task 4: 最终验证、清理与提交

**Files:**
- Verify: `assets/baizer-knowledge-loop.png`, `README.md`, `README.zh-CN.md`

- [ ] **Step 1: 对最终资源执行完整元数据与视觉检查**

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$candidatePath = [System.IO.Path]::GetFullPath('assets\baizer-knowledge-loop.png')
if (!(Test-Path -LiteralPath $candidatePath) -or (Get-Item -LiteralPath $candidatePath).Length -le 0) { throw 'Final PNG missing or empty' }
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($candidatePath)
try {
  if ($image.Width -ne 1536 -or $image.Height -ne 1024) { throw "Unexpected dimensions: $($image.Width)x$($image.Height)" }
  if ($image.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid) { throw "Unexpected image format: $($image.RawFormat.Guid)" }
  $preview = New-Object System.Drawing.Bitmap 900,600
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($preview)
    try { $graphics.DrawImage($image, 0, 0, 900, 600) } finally { $graphics.Dispose() }
    $preview.Save((Join-Path $candidateDir 'final-900.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $preview.Dispose() }
} finally { $image.Dispose() }
```

Use `view_image` on `assets\baizer-knowledge-loop.png` and the temporary `final-900.png`.

Expected: 精确 `1536x1024` PNG；`Web`、`Video`、`Notes` 和六个主标签均符合验收标准。

- [ ] **Step 2: 运行差异与构建检查**

Run:

```powershell
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
$actual = @((git status --porcelain --untracked-files=all | ForEach-Object { $_.Substring(3) }) | Sort-Object)
$expected = @('README.md','README.zh-CN.md','assets/baizer-knowledge-loop.png' | Sort-Object)
if (Compare-Object $actual $expected) { throw "Unexpected pre-commit files: $($actual -join ', ')" }
```

Expected: 差异检查与构建成功；状态只包含目标 PNG 和两份 README。

- [ ] **Step 3: 安全清理候选目录**

Run:

```powershell
$candidateDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
$expectedDir = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'baizer-readme-image-20260727-task'))
if ($candidateDir -ne $expectedDir) { throw "Unexpected cleanup path: $candidateDir" }
$item = Get-Item -LiteralPath $candidateDir
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing to delete a reparse point' }
if ((Get-Content -Raw (Join-Path $candidateDir '.task-marker')).Trim() -ne 'baizer-readme-image-20260727') { throw 'Task marker mismatch' }
Remove-Item -LiteralPath $candidateDir -Recurse -Force
```

Expected: 只删除有正确标记、路径完全相等且不是重解析点的候选目录。

- [ ] **Step 4: 提交交付物并验证提交文件列表**

Run:

```powershell
git add -- 'assets/baizer-knowledge-loop.png' 'README.md' 'README.zh-CN.md'
git commit -m 'docs: refresh Baizer knowledge loop illustration'
$actual = @(git diff-tree --no-commit-id --name-only -r HEAD | Sort-Object)
$expected = @('README.md','README.zh-CN.md','assets/baizer-knowledge-loop.png' | Sort-Object)
if (Compare-Object $actual $expected) { throw "Unexpected files in final commit: $($actual -join ', ')" }
git diff --check HEAD^ HEAD
if ($LASTEXITCODE -ne 0) { throw 'Committed diff check failed' }
```

Expected: 提交只包含目标 PNG 和两份 README，提交区间差异检查成功。

- [ ] **Step 5: 按验证技能复核并报告**

按 `@superpowers:verification-before-completion` 运行以下最终检查：

```powershell
$path = [System.IO.Path]::GetFullPath('assets\baizer-knowledge-loop.png')
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($path)
try {
  if ($image.Width -ne 1536 -or $image.Height -ne 1024 -or $image.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid) { throw 'Final PNG verification failed' }
} finally { $image.Dispose() }
$files = 'README.md','README.zh-CN.md'; $new = '![Baizer knowledge loop](assets/baizer-knowledge-loop.png)'; $old = 'd0ab9014-ea13-4300-8d76-d8839fd0c046'
if (@($files | ForEach-Object { Select-String -LiteralPath $_ -SimpleMatch $new }).Count -ne 2) { throw 'README new reference count failed' }
if (@($files | ForEach-Object { Select-String -LiteralPath $_ -SimpleMatch $old }).Count -ne 0) { throw 'README old reference remains' }
git diff --check HEAD^ HEAD; if ($LASTEXITCODE -ne 0) { throw 'Committed diff check failed' }
npm run build; if ($LASTEXITCODE -ne 0) { throw 'Final build failed' }
git status --short
```

Expected: 所有断言和构建成功，工作区干净。报告最终绝对路径、完整提示词、`1536x1024`、选择标记中的实际质量和模型 `gpt-image-2`。
