param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path

$catalog = Get-Content -Raw -LiteralPath (Join-Path $resolvedProject 'spec/mcp-tools.json') |
    ConvertFrom-Json -AsHashtable
$fixtures = Get-Content -Raw -LiteralPath (Join-Path $resolvedProject 'spec/input-cases.json') |
    ConvertFrom-Json -AsHashtable
$toolsByName = @{}
foreach ($entry in $catalog.tools) {
    if ($toolsByName.ContainsKey($entry.name)) {
        throw "Duplicate tool name: $($entry.name)"
    }
    $toolsByName[$entry.name] = $entry
}

$scope = Get-Content -Raw -LiteralPath (Join-Path $resolvedProject 'spec/scope.json') |
    ConvertFrom-Json -AsHashtable
$expectedTools = @($scope.mcp_tools)
if ($toolsByName.Count -ne $expectedTools.Count) {
    throw 'The public tools must match the current MVP scope.'
}
if ($catalog.contract_version -ne $scope.contract_version) {
    throw 'Tool catalog and scope contract versions differ.'
}
foreach ($expected in $expectedTools) {
    if (-not $toolsByName.ContainsKey($expected)) {
        throw "Missing tool: $expected"
    }
}

$passedCases = 0
foreach ($case in $fixtures.cases) {
    if (-not $toolsByName.ContainsKey($case.tool)) {
        throw "Fixture references an unknown tool: $($case.tool)"
    }
    $schemaJson = $toolsByName[$case.tool].inputSchema | ConvertTo-Json -Depth 30 -Compress
    $argumentsJson = $case.arguments | ConvertTo-Json -Depth 30 -Compress
    $actual = Test-Json -Json $argumentsJson -Schema $schemaJson -ErrorAction SilentlyContinue
    if ($actual -ne $case.valid) {
        throw "Schema case failed: $($case.name); expected=$($case.valid), actual=$actual"
    }
    $passedCases++
}
Write-Output "MCP input schemas: $passedCases cases passed."

& tsc --project (Join-Path $resolvedProject 'spec/tsconfig.json')
if ($LASTEXITCODE -ne 0) {
    throw 'TypeScript contract typecheck failed.'
}
Write-Output 'TypeScript contracts: passed.'

foreach ($configName in @('agent-to-im.example.toml', 'codex-mcp.example.toml')) {
    $configText = Get-Content -Raw -LiteralPath (Join-Path $resolvedProject ('examples/' + $configName))
    $configText | python -c 'import sys,tomllib; tomllib.loads(sys.stdin.read()); print("TOML parsed.")'
    if ($LASTEXITCODE -ne 0) {
        throw "TOML parse failed: $configName"
    }
}

$markdownFiles = @(& rg --files -g '*.md' $resolvedProject)
if ($LASTEXITCODE -ne 0) {
    throw 'Markdown inventory failed.'
}
$checkedLinks = 0
foreach ($markdownFile in $markdownFiles) {
    $content = Get-Content -Raw -LiteralPath $markdownFile
    $matches = [regex]::Matches($content, '\[[^\]]+\]\((?<target>[^)]+)\)')
    foreach ($match in $matches) {
        $target = $match.Groups['target'].Value
        if ($target -match '^(https?://|#)') {
            continue
        }
        $relativeTarget = ($target -split '#', 2)[0]
        $targetPath = Join-Path (Split-Path -Parent $markdownFile) $relativeTarget
        if (-not (Test-Path -LiteralPath $targetPath)) {
            throw "Broken documentation link: $markdownFile -> $target"
        }
        $checkedLinks++
    }
}
Write-Output "Local documentation links: $checkedLinks passed."
Write-Output 'Contract checks complete. Run pnpm check for runtime tests; see docs/acceptance.md for platform acceptance.'
