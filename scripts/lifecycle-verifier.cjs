const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.activate = async function () {
    const result = { phase: process.env.MICROMAMBA_LIFECYCLE_PHASE };
    const trace = [];
    let reloading = false;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const settings = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
    const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
    try {
        const official = vscode.extensions.getExtension('ms-python.vscode-python-envs');
        await official.activate();
        const api = official.exports;
        const register = api.registerEnvironmentManager.bind(api);
        api.registerEnvironmentManager = (manager, ...args) => {
            for (const method of ['get', 'set']) {
                const original = manager[method];
                manager[method] = async (...values) => {
                    trace.push({ manager: manager.name, method, scope: Array.isArray(values[0]) ? values[0].map(uri => uri.toString()) : values[0]?.toString(), prefix: values[1]?.sysPrefix });
                    return original.apply(manager, values);
                };
            }
            return register(manager, ...args);
        };
        await vscode.extensions.getExtension('ad070809.micromamba-environments').activate();
        await pause(3000);
        const environments = await api.getEnvironments('all');
        const env = environments.find(env => env.name === 'pytorch' && env.envId.managerId === 'ad070809.micromamba-environments:micromamba');
        if (!env) throw new Error('Micromamba pytorch was not discovered');
        if (result.phase === 'reload' && !await exists(process.env.MICROMAMBA_LIFECYCLE_RESULT)) {
            await fs.writeFile(process.env.MICROMAMBA_LIFECYCLE_RESULT, '{"reloading":true}');
            reloading = true;
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
            return;
        }
        result.beforeSelectionSettings = await exists(settings);
        if (result.phase === 'choose') {
            if (result.beforeSelectionSettings) throw new Error('Untouched project acquired settings before explicit selection');
            const doc = await vscode.workspace.openTextDocument(path.join(folder.uri.fsPath, 'main.py'));
            await vscode.window.showTextDocument(doc);
            await pause(2000);
            if (await exists(settings)) throw new Error('Opening Python alone created workspace settings');
            await api.setEnvironment(folder.uri, env);
            await pause(1000);
        }
        const other = environments.find(item => item.envId.managerId !== env.envId.managerId && /msys64/i.test(item.sysPrefix));
        if (result.phase === 'switch-away') {
            if (!other) throw new Error('System Python was not discovered');
            await api.setEnvironment(folder.uri, other);
            await pause(1000);
        }
        const selected = await api.getEnvironment(folder.uri);
        result.selected = selected?.sysPrefix;
        result.settingsExist = await exists(settings);
        if (['choose', 'restore', 'reload', 'multi'].includes(result.phase)) {
            if (selected?.sysPrefix !== env.sysPrefix) throw new Error(`Project selection was lost: ${selected?.sysPrefix}`);
            if (!result.settingsExist) throw new Error('Explicit selection did not bind the project manager');
            const config = JSON.parse(await fs.readFile(settings, 'utf8'));
            if (config['python-envs.defaultEnvManager'] !== env.envId.managerId) throw new Error('Unexpected project manager');
        } else if (['switch-away', 'other-restored'].includes(result.phase)) {
            if (!other || selected?.sysPrefix.toLowerCase() !== other.sysPrefix.toLowerCase()) throw new Error('Non-Micromamba choice was overwritten');
        } else {
            if (selected?.envId.managerId === env.envId.managerId) throw new Error('Micromamba leaked into an untouched project');
            if (result.settingsExist) throw new Error('Untouched project acquired settings');
        }
        if (result.phase === 'multi') {
            const second = vscode.workspace.workspaceFolders[1];
            if (!second) throw new Error('Multi-folder workspace missing second folder');
            const secondEnv = await api.getEnvironment(second.uri);
            if (secondEnv?.envId.managerId === env.envId.managerId || await exists(path.join(second.uri.fsPath, '.vscode', 'settings.json'))) throw new Error('Untouched folder inherited Micromamba');
            result.secondFolderUntouched = true;
        }
        result.passed = true;
    } catch (error) { result.passed = false; result.error = String(error); }
    finally {
        if (reloading) return;
        result.trace = trace;
        await fs.writeFile(process.env.MICROMAMBA_LIFECYCLE_RESULT, JSON.stringify(result, null, 2));
        await pause(1500);
        await vscode.commands.executeCommand('workbench.action.quit');
    }
};
