param([string]$CodePath = 'D:\Program Files\Microsoft VS Code\Code.exe')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTools = Join-Path $taskRoot '.tools'
$taskExtensions = Join-Path $taskTools 'restore-extensions'
New-Item -ItemType Directory -Path $taskExtensions -Force | Out-Null
foreach ($taskSource in Get-ChildItem -LiteralPath (Join-Path $taskTools 'test-extensions') -Directory) {
    if ($taskSource.Name -match '^ms-python\.') {
        $taskDestination = Join-Path $taskExtensions $taskSource.Name
        if (-not (Test-Path -LiteralPath $taskDestination)) { Copy-Item -LiteralPath $taskSource.FullName -Destination $taskDestination -Recurse }
    }
}
$taskVerifier = Join-Path $taskExtensions 'test-tools.micromamba-restore-verifier-0.1.0'
New-Item -ItemType Directory -Path $taskVerifier -Force | Out-Null
$taskManifest = @{ name = 'micromamba-restore-verifier'; publisher = 'test-tools'; version = '0.1.0'; engines = @{ vscode = '^1.110.0' }; main = './index.cjs'; activationEvents = @('onStartupFinished'); extensionDependencies = @('ad070809.micromamba-environments') }
[IO.File]::WriteAllText((Join-Path $taskVerifier 'package.json'), ($taskManifest | ConvertTo-Json -Depth 4))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'restore-verifier.cjs') -Destination (Join-Path $taskVerifier 'index.cjs') -Force
$taskUserData = Join-Path $taskTools 'vscode-restore-user'
New-Item -ItemType Directory -Path (Join-Path $taskUserData 'User') -Force | Out-Null
$taskSettings = @{ 'extensions.autoUpdate' = $false; 'extensions.autoCheckUpdates' = $false; 'telemetry.telemetryLevel' = 'off'; 'update.mode' = 'none'; 'workbench.startupEditor' = 'none'; 'chat.disableAIFeatures' = $true; 'security.workspace.trust.enabled' = $false }
[IO.File]::WriteAllText((Join-Path $taskUserData 'User\settings.json'), ($taskSettings | ConvertTo-Json))
$env:ELECTRON_RUN_AS_NODE = ''
foreach ($taskPhase in @('seed', 'verify')) {
    $env:MICROMAMBA_VERIFY_RESTORE = if ($taskPhase -eq 'verify') { '1' } else { '0' }
    [IO.File]::WriteAllText((Join-Path $taskRoot 'test-workspace\restore-results.json'), '{"passed":false,"error":"Verifier did not complete"}')
    $taskArguments = @('--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--log', 'debug',
        ('"--user-data-dir=' + $taskUserData + '"'), ('"--extensions-dir=' + $taskExtensions + '"'),
        ('"--extensionDevelopmentPath=' + $taskRoot + '"'), ('"' + (Join-Path $taskRoot 'test-workspace') + '"'))
    $taskProcess = Start-Process -FilePath $CodePath -ArgumentList $taskArguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $taskTools "restore-$taskPhase.stdout.log") -RedirectStandardError (Join-Path $taskTools "restore-$taskPhase.stderr.log")
    $taskProcess.WaitForExit()
    $taskResult = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'test-workspace\restore-results.json') | ConvertFrom-Json
    $taskResult | ConvertTo-Json
    if (-not $taskResult.passed) { throw "Restore integration test failed in phase $taskPhase" }
}
