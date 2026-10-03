const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.activate = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const result = {};
    try {
        if (!folder) throw new Error('Fixture workspace is missing');
        const id = 'ad070809.micromamba-environments';
        await vscode.extensions.getExtension(id).activate();
        await vscode.commands.executeCommand('micromamba.refresh');
        const api = vscode.extensions.getExtension('ms-python.vscode-python-envs').exports;
        const env = (await api.getEnvironments('all')).find(env => env.name === 'pytorch' && env.envId.managerId === `${id}:micromamba`);
        if (!env) throw new Error('Real pytorch environment was not registered');
        if (process.env.MICROMAMBA_VERIFY_RESTORE === '1') {
            let selected;
            for (let i = 0; i < 30; i++) {
                selected = await api.getEnvironment(folder.uri);
                if (selected?.sysPrefix === env.sysPrefix) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (selected?.sysPrefix !== env.sysPrefix) throw new Error(`Restore failed: ${selected?.sysPrefix}`);
            result.restored = true;
        } else {
            await api.setEnvironment(folder.uri, env);
            result.saved = true;
        }
        result.python = env.execInfo.run.executable;
        result.passed = true;
    } catch (error) { result.passed = false; result.error = String(error); }
    finally {
        if (folder) await fs.writeFile(path.join(folder.uri.fsPath, 'restore-results.json'), JSON.stringify(result, null, 2));
        // Normal windows persist their mementos; --extensionTestsPath uses in-memory storage.
        await new Promise(resolve => setTimeout(resolve, 1000));
        await vscode.commands.executeCommand('workbench.action.quit');
    }
};
