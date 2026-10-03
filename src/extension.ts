import { t, configureLocalization } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { CreateEnvironmentOptions, CreateEnvironmentScope, PackageManagementOptions } from '@vscode/python-environments';
import { MambaEnvironment, MambaPackage, environmentName, packageSpecs, samePath } from './core';
import { Micromamba } from './micromamba';
import { Selections } from './selection';
import { PythonBridge } from './pythonBridge';
import { EnvironmentTree, TreeNode } from './tree';
import { Terminals } from './terminals';

function inputError(validate: (value: string) => unknown): (value: string) => string | undefined {
    return (value) => { try { validate(value); return undefined; } catch (error) { return (error as Error).message; } };
}

function packageName(spec: string): string { return (spec.split('::').pop() ?? spec).split(/[=<>!\[]/)[0].toLowerCase(); }

let activeBridge: PythonBridge | undefined;

export function deactivate(): void { activeBridge?.dispose(); activeBridge = undefined; }

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    configureLocalization((message, ...args) => vscode.l10n.t(message, ...args));
    const log = vscode.window.createOutputChannel('Micromamba', { log: true });
    const service = new Micromamba(log);
    const selections = new Selections(context.workspaceState);
    let bridge: PythonBridge;
    const tree = new EnvironmentTree(service, selections);
    const view = vscode.window.createTreeView('micromamba.environments', { treeDataProvider: tree, showCollapseAll: true });
    const subscriptions = context.subscriptions;
    subscriptions.push(log, service, selections, tree, view);

    const report = async (error: unknown): Promise<void> => {
        log.error(String(error));
        const choice = await vscode.window.showErrorMessage(t('Micromamba: {0}', (error as Error).message ?? String(error)), t("Show Log"), t("Configure"));
        if (choice === t("Show Log")) { log.show(); }
        if (choice === t("Configure")) { await vscode.commands.executeCommand('micromamba.configure'); }
    };
    const refresh = async () => { await service.discover(true); };
    const chooseScope = async (): Promise<vscode.Uri | undefined | null> => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length <= 1) { return folders[0]?.uri; }
        const picked = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri })),
            { title: t("Select the workspace folder for this environment") });
        return picked?.uri ?? null;
    };
    const chooseEnvironment = async (node?: TreeNode, needsPython = false): Promise<MambaEnvironment | undefined> => {
        if (node && node.kind !== 'message') { return node.env; }
        const environments = (await service.discover()).filter((env) => !needsPython || env.pythonPath);
        if (!environments.length) { throw new Error(needsPython ? t("No environments contain Python. Create an environment or install python first.") : t("No environments found. Check the configuration or create an environment.")); }
        const selected = bridge?.activeFor();
        const picked = await vscode.window.showQuickPick(environments.map((env) => ({ label: `${selected && samePath(selected.prefix, env.prefix) ? '$(check) ' : ''}${env.name}`,
            description: env.pythonPath ? `Python ${env.version || '?'}` : t("No Python"), detail: env.prefix, env })),
            { title: t("Select a micromamba environment"), matchOnDetail: true });
        return picked?.env;
    };

    const create = async (scope?: CreateEnvironmentScope, options?: CreateEnvironmentOptions): Promise<MambaEnvironment | undefined> => {
        let name: string;
        let specs: string[];
        if (options?.quickCreate) {
            const uri = Array.isArray(scope) ? scope[0] : scope === 'global' ? undefined : scope;
            const base = `workspace-${path.basename(uri?.fsPath ?? 'python').replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
            const existing = await service.discover();
            name = base;
            let suffix = 1;
            while (existing.some((env) => env.name === name)) { name = `${base}-${suffix++}`; }
            specs = ['python', 'pip'];
        } else {
            const value = await vscode.window.showInputBox({ title: t("Create a micromamba environment"), prompt: t("Environment name (for example, data-science)"), validateInput: inputError(environmentName) });
            if (value === undefined) { return undefined; }
            name = environmentName(value);
            const version = await vscode.window.showInputBox({ title: t("Python version"), prompt: t("For example, 3.12. Leave empty to let micromamba choose the latest compatible version."), value: '3.12',
                validateInput: (value) => !value.trim() || /^\d+(\.\d+){0,2}$/.test(value.trim()) ? undefined : t("Enter a version number, for example, 3.12.") });
            if (version === undefined) { return undefined; }
            const packages = await vscode.window.showInputBox({ title: t("Initial packages"), prompt: t("Separate packages with spaces, or leave empty. For example, numpy pandas>=2."), value: '',
                validateInput: (value) => value.trim() ? inputError(packageSpecs)(value) : undefined });
            if (packages === undefined) { return undefined; }
            specs = [version.trim() ? `python=${version.trim()}` : 'python', 'pip', ...(packages.trim() ? packageSpecs(packages) : [])];
        }
        if (options?.additionalPackages?.length) { specs.push(...packageSpecs(options.additionalPackages.join(' '))); }
        return service.create(name, specs);
    };

    const remove = async (env: MambaEnvironment, headless = false): Promise<void> => {
        if (env.isBase) { throw new Error(t("The base environment cannot be deleted.")); }
        if (!headless) {
            const choice = await vscode.window.showWarningMessage(t("Delete environment {0} and all its packages?", env.name), { modal: true, detail: env.prefix }, t("Delete Environment"));
            if (choice !== t("Delete Environment")) { return; }
        }
        await service.remove(env);
        await bridge.clearSelections(env);
    };

    const install = async (env: MambaEnvironment, specs: string[], pip: boolean, upgrade = false): Promise<void> => {
        packageSpecs(specs.join(' '));
        if (pip) {
            if (!env.pythonPath) { throw new Error(t("Install python and pip in this environment before using pip.")); }
            await service.mutate(t("{1} pip packages in {0}", env.name, upgrade ? t("Update") : t("Install")), env.prefix,
                ['run', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, env.pythonPath, '-m', 'pip', 'install', ...(upgrade ? ['--upgrade'] : []),
                    ...specs.map((spec) => spec.replace(/^([^<>=!]+)=(?!=)([^=]+)$/, '$1==$2'))]);
        } else {
            await service.mutate(t("Install Conda packages in {0}", env.name), env.prefix,
                [upgrade ? 'update' : 'install', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, '--yes', ...service.channels(), ...specs]);
        }
    };

    const uninstall = async (env: MambaEnvironment, packages: MambaPackage[], headless = false): Promise<void> => {
        if (!packages.length) { return; }
        if (!headless) {
            const choice = await vscode.window.showWarningMessage(t("Uninstall {1} from {0}?", env.name, packages.map((pkg) => pkg.name).join(', ')),
                { modal: true, detail: t("Conda may also remove other packages that depend on these packages.") }, t("Uninstall"));
            if (choice !== t("Uninstall")) { return; }
        }
        const conda = packages.filter((pkg) => !pkg.isPip);
        const pip = packages.filter((pkg) => pkg.isPip);
        if (pip.length) {
            if (!env.pythonPath) { throw new Error(t("This environment has no Python interpreter, so pip cannot be used.")); }
            await service.mutate(t("Uninstall pip packages from {0}", env.name), env.prefix,
                ['run', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, env.pythonPath, '-m', 'pip', 'uninstall', '--yes', ...pip.map((pkg) => pkg.name)]);
        }
        if (conda.length) {
            await service.mutate(t("Uninstall Conda packages from {0}", env.name), env.prefix,
                ['remove', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, '--yes', ...conda.map((pkg) => pkg.name)]);
        }
        await refresh();
        const current = service.environments.find((item) => samePath(item.prefix, env.prefix));
        if (!current?.pythonPath) { await bridge.clearSelections(env); }
    };

    bridge = new PythonBridge(service, selections, context.extension.id, {
        create, remove,
        manage: async (env: MambaEnvironment, options: PackageManagementOptions) => {
            let installed = await service.packages(env);
            if (options.uninstall?.length) {
                const wanted = new Set(options.uninstall.map(packageName));
                await uninstall(env, installed.filter((pkg) => wanted.has(pkg.name.toLowerCase())), options.runHeadless);
                installed = await service.packages(env);
            }
            if (options.install?.length) {
                const pipNames = new Set(installed.filter((pkg) => pkg.isPip).map((pkg) => pkg.name.toLowerCase()));
                const pip = options.install.filter((spec) => pipNames.has(packageName(spec)));
                const conda = options.install.filter((spec) => !pipNames.has(packageName(spec)));
                if (pip.length) { await install(env, pip, true, options.upgrade); }
                const installedConda = new Set(installed.filter((pkg) => !pkg.isPip).map((pkg) => pkg.name.toLowerCase()));
                const upgrades = options.upgrade ? conda.filter((spec) => installedConda.has(packageName(spec))) : [];
                const additions = conda.filter((spec) => !upgrades.includes(spec));
                if (upgrades.length) { await install(env, upgrades, false, true); }
                if (additions.length) { await install(env, additions, false); }
                await refresh();
            }
        },
    });
    subscriptions.push(bridge);
    activeBridge = bridge;
    const terminals = new Terminals(service, bridge, selections, context.environmentVariableCollection);
    subscriptions.push(terminals);

    const updateContext = () => {
        const env = bridge.activeFor();
        void vscode.commands.executeCommand('setContext', 'micromamba.hasEnvironments', service.environments.length > 0);
        void vscode.commands.executeCommand('setContext', 'micromamba.hasSelection', !!env?.pythonPath);
    };
    subscriptions.push(service.onDidChange(updateContext), selections.onDidChange(updateContext), vscode.window.onDidChangeActiveTextEditor(updateContext));

    const register = (name: string, handler: (...args: unknown[]) => Promise<unknown> | unknown) => {
        subscriptions.push(vscode.commands.registerCommand(`micromamba.${name}`, async (...args: unknown[]) => {
            try { return await handler(...args); } catch (error) { await report(error); return undefined; }
        }));
    };
    register('refresh', refresh);
    register('configure', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id));
    register('showOutput', () => log.show());
    register('select', async (node) => {
        const env = await chooseEnvironment(node as TreeNode | undefined, true);
        if (!env) { return; }
        const scope = await chooseScope();
        if (scope === null) { return; }
        await bridge.select(env, scope);
        void vscode.window.showInformationMessage(t("Selected {1} for {0}. New terminals will automatically activate this environment.", scope ? path.basename(scope.fsPath) : t("the current window"), env.name));
    });
    register('create', async () => {
        const env = await create();
        if (!env) { return; }
        const use = await vscode.window.showInformationMessage(t("Environment {0} was created.", env.name), t("Use for Current Project"));
        if (use) { const scope = await chooseScope(); if (scope !== null) { await bridge.select(env, scope); } }
    });
    register('import', async () => {
        const file = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [t('Environment YAML')]: ['yml', 'yaml'] } }))?.[0];
        if (!file) { return; }
        const name = await vscode.window.showInputBox({ title: t("Import Environment"), prompt: t("New environment name. This overrides name and prefix in the YAML file."), validateInput: inputError(environmentName) });
        if (name === undefined) { return; }
        await service.create(name, [], file.fsPath);
        void vscode.window.showInformationMessage(t("Environment {0} was imported.", name));
    });
    register('remove', async (node) => { const env = await chooseEnvironment(node as TreeNode | undefined); if (env) { await remove(env); } });
    register('install', async (node) => {
        const env = await chooseEnvironment(node as TreeNode | undefined);
        if (!env) { return; }
        const manager = await vscode.window.showQuickPick([{ label: 'Conda / micromamba', pip: false }, { label: 'pip / PyPI', pip: true }], { title: t("Select a package source") });
        if (!manager) { return; }
        const value = await vscode.window.showInputBox({ title: t("Install packages in {0}", env.name), prompt: t("Separate packages with spaces. For example, numpy pandas>=2."), validateInput: inputError(packageSpecs) });
        if (value === undefined) { return; }
        await install(env, packageSpecs(value), manager.pip);
        await refresh();
    });
    register('removePackage', async (node) => {
        const element = node as TreeNode | undefined;
        if (element?.kind === 'package') { await uninstall(element.env, [element.pkg]); return; }
        const env = await chooseEnvironment(element);
        if (!env) { return; }
        const packages = await service.packages(env);
        const picked = await vscode.window.showQuickPick(packages.map((pkg) => ({ label: pkg.name, description: `${pkg.version} · ${pkg.isPip ? 'pip' : 'Conda'}`, pkg })),
            { title: t("Uninstall packages from {0}", env.name), canPickMany: true });
        if (picked?.length) { await uninstall(env, picked.map((item) => item.pkg)); }
    });
    register('update', async (node) => {
        const element = node as TreeNode | undefined;
        const env = await chooseEnvironment(element);
        if (!env) { return; }
        const choice = await vscode.window.showWarningMessage(t("Update all Conda packages in {0}?", env.name), { modal: true, detail: t("This may change Python and dependency versions. Pip packages will not be updated.") }, t("Update"));
        if (!choice) { return; }
        await service.mutate(t("Update {0}", env.name), env.prefix, ['update', '--prefix', env.prefix, '--root-prefix', env.rootPrefix, '--all', '--yes', ...service.channels()]);
        await refresh();
    });
    register('export', async (node) => {
        const env = await chooseEnvironment(node as TreeNode | undefined);
        if (!env) { return; }
        const format = await vscode.window.showQuickPick([{ label: t("Full environment (including pip)"), history: false }, { label: t("Conda installation history only (more portable)"), history: true }], { title: t("Export format") });
        if (!format) { return; }
        const folder = selections.scope()?.fsPath;
        const file = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.file(path.join(folder, `${env.name}.yml`)) : undefined, filters: { YAML: ['yml', 'yaml'] } });
        if (!file) { return; }
        const yaml = await service.read(['env', 'export', '--prefix', env.prefix, '--root-prefix', env.rootPrefix, ...(format.history ? ['--from-history'] : [])]);
        // A machine-specific prefix prevents straightforward sharing/import elsewhere.
        await vscode.workspace.fs.writeFile(file, Buffer.from(yaml.replace(/^prefix:.*(?:\r?\n|$)/gm, ''), 'utf8'));
        await vscode.window.showTextDocument(file);
    });
    register('terminal', async (node) => { const env = await chooseEnvironment(node as TreeNode | undefined); if (env) { await terminals.open(env, selections.scope()); } });
    register('activateTerminal', async () => {
        const terminal = vscode.window.activeTerminal;
        if (!terminal) { throw new Error(t("Open a terminal first.")); }
        const env = bridge.activeFor() ?? await chooseEnvironment();
        if (env) { await terminals.activate(terminal, env); }
    });
    register('runFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'python' || editor.document.isUntitled) { throw new Error(t("Open a saved Python file.")); }
        if (editor.document.isDirty && !await editor.document.save()) { return; }
        const env = bridge.activeFor(editor.document.uri);
        if (!env?.pythonPath) { throw new Error(t("Select a Python environment for this file's workspace first.")); }
        await fs.access(env.pythonPath);
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const task = new vscode.Task({ type: 'micromamba', file: editor.document.uri.fsPath }, folder ?? vscode.TaskScope.Workspace,
            `Micromamba: ${path.basename(editor.document.uri.fsPath)}`, 'micromamba',
            new vscode.ProcessExecution(await service.executablePath(), ['run', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, env.pythonPath, '-u', editor.document.uri.fsPath],
                { cwd: folder?.uri.fsPath ?? path.dirname(editor.document.uri.fsPath) }));
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
        await vscode.tasks.executeTask(task);
    });

    subscriptions.push(vscode.debug.registerDebugConfigurationProvider('debugpy', { resolveDebugConfiguration: (folder, config) => bridge.debugConfiguration(folder, config) }),
        vscode.debug.registerDebugConfigurationProvider('python', { resolveDebugConfiguration: (folder, config) => bridge.debugConfiguration(folder, config) }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('micromamba.executablePath') || event.affectsConfiguration('micromamba.rootPrefix')) {
                service.invalidate(); void refresh().catch(report);
            }
        }));

    // Register the final resolver after the debugger's resolver, which adds inherited
    // variables and may introduce Path/PATH duplicates on Windows.
    const debuggerExtension = vscode.extensions.getExtension('ms-python.debugpy');
    if (debuggerExtension && !debuggerExtension.isActive) {
        try { await debuggerExtension.activate(); } catch (error) { log.warn(t("Python Debugger activation failed: {0}", String(error))); }
    }
    for (const type of ['debugpy', 'python']) {
        subscriptions.push(vscode.debug.registerDebugConfigurationProvider(type, {
            resolveDebugConfigurationWithSubstitutedVariables: (_folder, config) => bridge.finalizeDebugConfiguration(config),
        }));
    }

    // Failures here leave the view and configuration commands available for recovery.
    try { await bridge.connect(); }
    catch (error) {
        if (!vscode.workspace.getConfiguration('python').get<boolean>('useEnvironmentsExtension', false)) {
            log.warn(String(error));
            void Promise.resolve(vscode.window.showWarningMessage(t("Enable Microsoft Python Environments to integrate micromamba interpreters."), t("Enable and Reload"), t("Show Log"))).then(async (choice) => {
                if (choice === t("Enable and Reload")) {
                    await vscode.workspace.getConfiguration('python').update('useEnvironmentsExtension', true,
                        vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                } else if (choice === t("Show Log")) { log.show(); }
            }).catch(report);
        } else { void report(error); }
    }
    try { await service.discover(true); await bridge.restoreSelections(); await terminals.refresh(); }
    catch (error) { log.warn(String(error)); view.message = (error as Error).message; }
    subscriptions.push(service.onDidChange(() => { view.message = undefined; }));
    updateContext();
    log.info(t("Micromamba Environments started."));
}
