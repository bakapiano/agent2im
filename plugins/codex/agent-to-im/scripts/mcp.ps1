$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $pluginRoot 'runtime/node.exe') (Join-Path $pluginRoot 'runtime/dist/cli.js') mcp
exit $LASTEXITCODE
