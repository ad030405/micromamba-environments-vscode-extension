param(
    [string]$CodePath = 'D:\Program Files\Microsoft VS Code\Code.exe',
    [string]$ExtensionsPath = "$env:USERPROFILE\.vscode\extensions"
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTools = Join-Path $taskRoot '.tools'
$taskRun = Join-Path $taskTools ('lifecycle-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$taskExtensions = Join-Path $taskRun 'extensions'
New-Item -ItemType Directory -Path $taskExtensions -Force | Out-Null
foreach ($taskExtensionName in @('ms-python.python', 'ms-python.vscode-python-envs', 'ms-python.debugpy', 'ms-python.vscode-pylance')) {
    $taskSource = Get-ChildItem -LiteralPath $ExtensionsPath -Directory | Where-Object {
        $_.Name -match ('^' + [regex]::Escape($taskExtensionName) + '-\d+\.\d+\.\d+(-win32-x64)?$')
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $taskSource) { throw "Required extension is missing: $taskExtensionName" }
    Copy-Item -LiteralPath $taskSource.FullName -Destination (Join-Path $taskExtensions $taskSource.Name) -Recurse
}
$taskVerifier = Join-Path $taskExtensions 'test-tools.micromamba-lifecycle-verifier-0.1.0'
New-Item -ItemType Directory -Path $taskVerifier -Force | Out-Null
$taskManifest = @{ name = 'micromamba-lifecycle-verifier'; publisher = 'test-tools'; version = '0.1.0'; engines = @{ vscode = '^1.110.0' }; main = './index.cjs'; activationEvents = @('*'); extensionDependencies = @('ms-python.vscode-python-envs') }
[IO.File]::WriteAllText((Join-Path $taskVerifier 'package.json'), ($taskManifest | ConvertTo-Json -Depth 4))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lifecycle-verifier.cjs') -Destination (Join-Path $taskVerifier 'index.cjs')
$taskUserData = Join-Path $taskRun 'user-data'
New-Item -ItemType Directory -Path (Join-Path $taskUserData 'User') -Force | Out-Null
$taskSettings = @{ 'extensions.autoUpdate' = $false; 'extensions.autoCheckUpdates' = $false; 'telemetry.telemetryLevel' = 'off'; 'update.mode' = 'none'; 'workbench.startupEditor' = 'none'; 'chat.disableAIFeatures' = $true; 'security.workspace.trust.enabled' = $false; 'micromamba.executablePath' = 'D:\develop\micromamba\micromamba.exe'; 'micromamba.rootPrefix' = 'D:\develop\micromamba'; 'python.useEnvironmentsExtension' = $true; 'python-envs.terminal.autoActivationType' = 'off' }
[IO.File]::WriteAllText((Join-Path $taskUserData 'User\settings.json'), ($taskSettings | ConvertTo-Json))
$taskProject = Join-Path $taskRun 'python-project'
$taskUntouched = Join-Path $taskRun 'untouched-project'
New-Item -ItemType Directory -Path $taskProject, $taskUntouched -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $taskProject 'main.py'), 'print("lifecycle")')
[IO.File]::WriteAllText((Join-Path $taskUntouched 'readme.txt'), 'No Python project or interpreter selection')
$taskWorkspace = Join-Path $taskRun 'same-project.code-workspace'
[IO.File]::WriteAllText($taskWorkspace, (@{ folders = @(@{ path = $taskProject }) } | ConvertTo-Json -Depth 4))
$taskMultiWorkspace = Join-Path $taskRun 'multi-project.code-workspace'
[IO.File]::WriteAllText($taskMultiWorkspace, (@{ folders = @(@{ path = $taskProject }, @{ path = $taskUntouched }) } | ConvertTo-Json -Depth 4))
$env:ELECTRON_RUN_AS_NODE = ''
$taskCases = @(
    @{ name = 'untouched'; phase = 'untouched'; target = $taskUntouched }
    @{ name = 'choose'; phase = 'choose'; target = $taskProject }
    @{ name = 'reopen'; phase = 'restore'; target = $taskProject }
    @{ name = 'reload'; phase = 'reload'; target = $taskProject }
    @{ name = 'workspace'; phase = 'restore'; target = $taskWorkspace }
    @{ name = 'multi'; phase = 'multi'; target = $taskMultiWorkspace }
    @{ name = 'switch-away'; phase = 'switch-away'; target = $taskProject }
    @{ name = 'other-restored'; phase = 'other-restored'; target = $taskWorkspace }
    @{ name = 'untouched-again'; phase = 'untouched'; target = $taskUntouched }
)
foreach ($taskCase in $taskCases) {
    $env:MICROMAMBA_LIFECYCLE_PHASE = $taskCase.phase
    $env:MICROMAMBA_LIFECYCLE_RESULT = Join-Path $taskRun ($taskCase.name + '-results.json')
    $taskArguments = @('--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--log', 'debug', ('"--user-data-dir=' + $taskUserData + '"'), ('"--extensions-dir=' + $taskExtensions + '"'), ('"--extensionDevelopmentPath=' + $taskRoot + '"'), ('"' + $taskCase.target + '"'))
    $taskProcess = Start-Process -FilePath $CodePath -ArgumentList $taskArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRun ($taskCase.name + '.stdout.log')) -RedirectStandardError (Join-Path $taskRun ($taskCase.name + '.stderr.log'))
    if (-not $taskProcess.WaitForExit(60000)) { throw "Lifecycle verifier timed out: $($taskCase.name)" }
    $taskResult = Get-Content -Raw -LiteralPath $env:MICROMAMBA_LIFECYCLE_RESULT | ConvertFrom-Json
    $taskResult | Select-Object -Property * -ExcludeProperty trace | ConvertTo-Json -Depth 5
    if (-not $taskResult.passed) { throw "Lifecycle test failed: $($taskCase.name). Results: $taskRun" }
}
Write-Output "Lifecycle checks passed: $taskRun"
