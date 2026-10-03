// Executed by VS Code with --extensionTestsPath, not by node --test.
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PythonEnvironmentApi } from '@vscode/python-environments';
import { quotePowerShell } from '../core';

export async function run(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Integration fixture workspace is required');
    const results: Record<string, unknown> = {};
    const readResult = async (name: string): Promise<Record<string, string>> => {
        for (let attempt = 0; attempt < 160; attempt++) {
            try { return JSON.parse(await fs.readFile(path.join(folder.uri.fsPath, name), 'utf8')); }
            catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
        }
        throw new Error(`Timed out waiting for ${name}`);
    };
    const id = 'ad070809.micromamba-environments';
    try {
        const extension = vscode.extensions.getExtension(id);
        assert.ok(extension, 'Development extension is installed');
        await extension.activate();
        const pythonEnvs = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
        assert.ok(pythonEnvs);
        await pythonEnvs.activate();
        const api = pythonEnvs.exports;
        assert.ok(api, 'Official Python Environments API is enabled');
        await vscode.commands.executeCommand('micromamba.refresh');
        const all = await api.getEnvironments('all');
        const env = all.find((env) => env.envId.managerId === `${id}:micromamba` && env.name === 'pytorch');
        assert.ok(env, 'Real pytorch environment is registered in the official picker');
        assert.equal(env.execInfo.run.executable, 'D:\\develop\\micromamba\\envs\\pytorch\\python.exe');
        assert.equal(env.execInfo.activatedRun?.executable, 'D:\\develop\\micromamba\\micromamba.exe');
        const packages = await api.getPackages(env, { skipCache: true });
        assert.ok(packages?.some((pkg) => pkg.name.toLowerCase() === 'torch'), 'PyPI torch is exposed in the official package API');
        await api.setEnvironment(folder.uri, env);
        // A new project must accept one selection, without polling or selecting twice.
        const selected = await api.getEnvironment(folder.uri);
        assert.equal(selected?.sysPrefix, env.sysPrefix, 'Official selection uses the real micromamba interpreter');
        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal((await api.getEnvironment(folder.uri))?.envId.id, env.envId.id, 'Repeated reads retain the selected environment identity');
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal((await api.getEnvironment(folder.uri))?.envId.id, env.envId.id, 'Background discovery does not overwrite the first selection');
        assert.equal((await api.getEnvironment(undefined))?.envId.id, env.envId.id, 'Resource-less Python validation also resolves the selected project');
        results.firstSelection = { passed: true, environmentId: env.envId.id };
        const python = vscode.extensions.getExtension<{ environments: { getActiveEnvironmentPath(resource?: vscode.Uri): { path: string } } }>('ms-python.python');
        assert.ok(python);
        await python.activate();
        let active = python.exports.environments.getActiveEnvironmentPath(folder.uri);
        for (let attempt = 0; attempt < 40 && !active.path.toLowerCase().startsWith(env.sysPrefix.toLowerCase()); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            active = python.exports.environments.getActiveEnvironmentPath(folder.uri);
        }
        assert.ok(active.path.toLowerCase().startsWith(env.sysPrefix.toLowerCase()), `Python extension active path: ${active.path}`);
        results.environment = { name: env.name, prefix: env.sysPrefix, python: env.execInfo.run.executable };
        results.packageCount = packages?.length;
        results.pythonExtensionActivePath = active.path;
        const script = path.join(folder.uri.fsPath, 'runtime_probe.py');
        // Artifact names are unique for this invocation, so old results can't mask failures.
        const key = Date.now();
        const officialName = `official-${key}.json`;
        const official = await api.runInTerminal(env, { cwd: folder.uri, args: [script, officialName], show: false });
        const officialResult = await readResult(officialName);
        assert.equal(officialResult.prefix.toLowerCase(), env.sysPrefix.toLowerCase());
        assert.ok(officialResult.torch, 'Official run can import the installed torch package');
        results.officialRun = officialResult;
        official.dispose();

        const document = await vscode.workspace.openTextDocument(script);
        await vscode.window.showTextDocument(document);
        const customName = 'custom-runtime-results.json';
        try { await fs.unlink(path.join(folder.uri.fsPath, customName)); } catch { /* No previous probe. */ }
        await vscode.commands.executeCommand('micromamba.runFile');
        const customResult = await readResult(customName);
        assert.equal(customResult.prefix.toLowerCase(), env.sysPrefix.toLowerCase());
        assert.ok(customResult.torch, 'Custom run can import torch');
        results.customRun = customResult;

        await vscode.workspace.getConfiguration('micromamba').update('autoActivateTerminal', true, vscode.ConfigurationTarget.Workspace);
        for (let attempt = 0; attempt < 40 && !vscode.workspace.getConfiguration('micromamba').get('autoActivateTerminal'); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await api.setEnvironment(folder.uri, env); // Preparing terminal variables completes before selection returns.
        const terminalCommands: string[] = [];
        const shellExecutions = vscode.window.onDidStartTerminalShellExecution((event) => {
            if (event.terminal.name === 'Activation integration test') { terminalCommands.push(event.execution.commandLine.value); }
        });
        const terminal = vscode.window.createTerminal({ name: 'Activation integration test', cwd: folder.uri,
            shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] });
        await terminal.processId;
        await new Promise((resolve) => setTimeout(resolve, 4000));
        results.terminalBeforeProbe = { state: terminal.state, options: terminal.creationOptions };
        const autoName = `terminal-${key}.json`;
        terminal.sendText(`python ${quotePowerShell(script)} ${quotePowerShell(autoName)} stdlib`);
        const terminalResult = await readResult(autoName);
        assert.equal(terminalResult.prefix.toLowerCase(), env.sysPrefix.toLowerCase());
        assert.equal(terminalResult.condaPrefix.toLowerCase(), env.sysPrefix.toLowerCase());
        results.terminalAutoActivation = terminalResult;
        assert.equal(terminalCommands.some((command) => /micromamba activate|shell hook/i.test(command)), false, 'Silent activation must not type activation commands');
        results.terminalActivationCommands = terminalCommands;
        shellExecutions.dispose();
        terminal.dispose();
        const other = all.find((item) => item.envId.managerId === env.envId.managerId && item.sysPrefix !== env.sysPrefix && item.name !== 'base');
        if (other) {
            const otherName = `explicit-terminal-${key}.json`;
            await vscode.commands.executeCommand('micromamba.terminal', { kind: 'environment', env: { name: other.name, prefix: other.sysPrefix,
                rootPrefix: 'D:\\develop\\micromamba', isBase: false, pythonPath: other.execInfo.run.executable, version: other.version } });
            const explicit = vscode.window.terminals.find((item) => item.name === `Micromamba: ${other.name}`);
            assert.ok(explicit);
            await explicit.processId;
            await new Promise((resolve) => setTimeout(resolve, 2000));
            explicit.sendText(`python ${quotePowerShell(script)} ${quotePowerShell(otherName)} stdlib`);
            const explicitResult = await readResult(otherName);
            assert.equal(explicitResult.prefix.toLowerCase(), other.sysPrefix.toLowerCase(), 'Explicitly opened environment is not overwritten by the project collection');
            assert.equal((await api.getEnvironment(folder.uri))?.envId.id, env.envId.id, 'Opening another environment terminal leaves the project interpreter selected');
            results.explicitOtherEnvironmentTerminal = explicitResult;
            explicit.dispose();
        }
        await vscode.workspace.getConfiguration('micromamba').update('autoActivateTerminal', false, vscode.ConfigurationTarget.Workspace);

        const debugName = `debug-${key}.json`;
        const started = await vscode.debug.startDebugging(folder, { type: 'debugpy', request: 'launch', name: 'Micromamba integration debug',
            program: script, args: [debugName], console: 'internalConsole', justMyCode: true });
        assert.ok(started, 'Python debugger started');
        const debugResult = await readResult(debugName);
        assert.equal(debugResult.prefix.toLowerCase(), env.sysPrefix.toLowerCase());
        assert.ok(debugResult.torch, 'Debug launch can import torch with activated DLL paths');
        results.debugRun = debugResult;
        results.passed = true;
        console.log('Micromamba extension-host integration checks passed.');
    } catch (error) {
        results.passed = false; results.error = String(error);
        throw error;
    } finally {
        await fs.writeFile(path.join(folder.uri.fsPath, 'integration-results.json'), JSON.stringify(results, null, 2));
    }
}
