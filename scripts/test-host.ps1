param(
    [string]$CodePath = 'D:\Program Files\Microsoft VS Code\Code.exe',
    [string]$ExtensionsPath = "$env:USERPROFILE\.vscode\extensions",
    [switch]$Fresh
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTools = Join-Path $taskRoot '.tools'
$taskWorkspace = Join-Path $taskRoot 'test-workspace'
if ($Fresh) {
    # A new project has neither manager settings nor an interpreter selection.
    $taskWorkspace = Join-Path $taskTools ('first-selection-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    New-Item -ItemType Directory -Path (Join-Path $taskWorkspace '.vscode') -Force | Out-Null
    $taskFixtureSettings = @{ 'micromamba.executablePath' = 'D:\develop\micromamba\micromamba.exe'; 'micromamba.rootPrefix' = 'D:\develop\micromamba'; 'micromamba.autoActivateTerminal' = $false; 'micromamba.terminalActivationMode' = 'silent'; 'python.useEnvironmentsExtension' = $true; 'python-envs.terminal.autoActivationType' = 'off' }
    [IO.File]::WriteAllText((Join-Path $taskWorkspace '.vscode\settings.json'), ($taskFixtureSettings | ConvertTo-Json))
    Copy-Item -LiteralPath (Join-Path $taskRoot 'test-workspace\runtime_probe.py') -Destination $taskWorkspace
}
$taskExtensionTarget = Join-Path $taskTools 'test-extensions'
New-Item -ItemType Directory -Path $taskExtensionTarget -Force | Out-Null
# Copy only required extensions so unrelated installed plugins cannot run or update.
foreach ($taskExtensionName in @('ms-python.python', 'ms-python.vscode-python-envs', 'ms-python.debugpy', 'ms-python.vscode-pylance')) {
    $taskSource = Get-ChildItem -LiteralPath $ExtensionsPath -Directory | Where-Object {
        $_.Name -match ('^' + [regex]::Escape($taskExtensionName) + '-\d+\.\d+\.\d+(-win32-x64)?$')
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $taskSource) { throw "Required extension is missing: $taskExtensionName" }
    $taskDestination = Join-Path $taskExtensionTarget $taskSource.Name
    if (-not (Test-Path -LiteralPath $taskDestination)) { Copy-Item -LiteralPath $taskSource.FullName -Destination $taskDestination -Recurse }
}
$taskUserData = if ($Fresh) { $taskWorkspace + '-user-data' } else { Join-Path $taskTools 'vscode-test-isolated' }
New-Item -ItemType Directory -Path (Join-Path $taskUserData 'User') -Force | Out-Null
$taskSettings = @{ 'extensions.autoUpdate' = $false; 'extensions.autoCheckUpdates' = $false; 'telemetry.telemetryLevel' = 'off'; 'update.mode' = 'none'; 'workbench.startupEditor' = 'none'; 'chat.disableAIFeatures' = $true }
[IO.File]::WriteAllText((Join-Path $taskUserData 'User\settings.json'), ($taskSettings | ConvertTo-Json))
$env:ELECTRON_RUN_AS_NODE = ''
[IO.File]::WriteAllText((Join-Path $taskWorkspace 'integration-results.json'), '{"passed":false,"error":"Integration host did not complete"}')
$taskArguments = @('--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--log', 'debug',
    ('"--user-data-dir=' + $taskUserData + '"'), ('"--extensions-dir=' + $taskExtensionTarget + '"'),
    ('"--extensionDevelopmentPath=' + $taskRoot + '"'),
    ('"--extensionTestsPath=' + (Join-Path $taskRoot 'out\test\extension-host.js') + '"'),
    ('"' + $taskWorkspace + '"'))
$taskProcess = Start-Process -FilePath $CodePath -ArgumentList $taskArguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskTools 'host-test.stdout.log') -RedirectStandardError (Join-Path $taskTools 'host-test.stderr.log')
Write-Output ('Integration host PID: ' + $taskProcess.Id)
$taskProcess.WaitForExit()
$taskResults = Get-Content -LiteralPath (Join-Path $taskWorkspace 'integration-results.json') -Raw | ConvertFrom-Json
Write-Output ('Test workspace: ' + $taskWorkspace)
$taskResults | ConvertTo-Json -Depth 8
if (-not $taskResults.passed) { throw 'Extension-host integration checks failed' }
if ($Fresh) {
    $taskPythonLog = Get-ChildItem -LiteralPath (Join-Path $taskUserData 'logs') -Recurse -File | Where-Object {
        $_.Name -eq 'Python.log' -and $_.DirectoryName -match 'ms-python\.python$'
    } | Select-Object -First 1
    if (-not $taskPythonLog) { throw 'Python diagnostic log was not found' }
    $taskPythonLines = @(Get-Content -LiteralPath $taskPythonLog.FullName -Encoding UTF8)
    $taskSelectionLine = -1
    for ($taskLine = 0; $taskLine -lt $taskPythonLines.Count; $taskLine++) {
        if ($taskPythonLines[$taskLine] -match '\[info\] Active interpreter .*micromamba\\envs\\pytorch\\python\.exe$') { $taskSelectionLine = $taskLine; break }
    }
    if ($taskSelectionLine -lt 0) { throw 'Python did not report the selected interpreter' }
    $taskDiagnostics = @($taskPythonLines | Select-Object -Skip $taskSelectionLine | Where-Object {
        $_ -match 'No Python environment is set|Invalid Python interpreter|Send text to terminal:.*(shell hook|micromamba activate)'
    })
    if ($taskDiagnostics.Count) { $taskDiagnostics | Write-Output; throw 'Python reported an invalid environment or echoed activation after selection' }
    Write-Output 'Python log verified: no missing/invalid interpreter diagnostics or echoed activation commands after first selection.'
}
