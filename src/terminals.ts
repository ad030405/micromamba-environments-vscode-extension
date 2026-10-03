import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { MambaEnvironment, Shell, activationCommand, detectShell, debugEnvironment, samePath } from './core';
import { Micromamba } from './micromamba';
import { PythonBridge } from './pythonBridge';
import { Selections } from './selection';

export class Terminals implements vscode.Disposable {
    private readonly pending = new WeakSet<vscode.Terminal>();
    private readonly activated = new WeakMap<vscode.Terminal, string>();
    private readonly managed = new WeakSet<vscode.Terminal>();
    private readonly executed = new WeakSet<vscode.Terminal>();
    private readonly subscriptions: vscode.Disposable[];
    private readonly revisions = new Map<string, number>();
    private readonly scoped = new Map<string, vscode.EnvironmentVariableCollection>();
    private disposed = false;
    constructor(private readonly service: Micromamba, private readonly bridge: PythonBridge, selections: Selections,
        private readonly collection: vscode.GlobalEnvironmentVariableCollection) {
        collection.persistent = false;
        collection.clear();
        for (const folder of vscode.workspace.workspaceFolders ?? []) { collection.getScoped({ workspaceFolder: folder }).clear(); }
        bridge.prepareSelection = (scope, env) => this.prepareSelection(scope, env);
        const refresh = () => { void this.refresh().catch((error) => service.log.warn(t("Terminal environment preparation failed: {0}", String(error)))); };
        this.subscriptions = [vscode.window.onDidOpenTerminal((terminal) => {
            // onDidOpenTerminal can fire during createTerminal; defer ownership checks.
            void Promise.resolve().then(() => this.autoActivate(terminal));
        }), vscode.window.onDidStartTerminalShellExecution((event) => this.executed.add(event.terminal)),
        selections.onDidChange(refresh), service.onDidChange(refresh), vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('micromamba')) { refresh(); } })];
    }

    private silent(resource?: vscode.Uri): boolean {
        return vscode.workspace.getConfiguration('micromamba', resource).get<string>('terminalActivationMode', 'silent') === 'silent';
    }

    private async variables(env: MambaEnvironment, complete = false): Promise<Record<string, string>> {
        const activated = await this.service.activatedEnv(env);
        const delta = debugEnvironment(activated, complete ? {} : process.env);
        const executable = await this.service.executablePath();
        const key = 'PATH';
        const paths = (delta[key] ?? activated[key] ?? process.env[key] ?? '').split(path.delimiter);
        const directory = path.dirname(executable);
        if (!paths.some((entry) => entry && samePath(entry, directory))) { paths.unshift(directory); }
        delta[key] = paths.join(path.delimiter);
        delta.MAMBA_EXE = executable;
        delta.MAMBA_ROOT_PREFIX = env.rootPrefix;
        return Object.fromEntries(Object.entries(delta).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    }

    private async apply(folder: vscode.WorkspaceFolder | undefined, env?: MambaEnvironment): Promise<void> {
        const key = folder?.uri.toString() ?? '<window>';
        const revision = (this.revisions.get(key) ?? 0) + 1;
        this.revisions.set(key, revision);
        const collection = folder ? this.collection.getScoped({ workspaceFolder: folder }) : this.collection;
        this.scoped.set(key, collection);
        const config = vscode.workspace.getConfiguration('micromamba', folder?.uri);
        if (!env?.pythonPath || !config.get<boolean>('autoActivateTerminal', true) || !this.silent(folder?.uri)) {
            collection.clear(); collection.description = undefined; return;
        }
        let variables: Record<string, string>;
        try { variables = await this.variables(env); }
        catch (error) {
            if (this.revisions.get(key) === revision) { collection.clear(); collection.description = undefined; }
            throw error;
        }
        if (this.disposed || this.revisions.get(key) !== revision) { return; }
        collection.clear();
        for (const [name, value] of Object.entries(variables)) {
            collection.replace(name, value, { applyAtProcessCreation: true });
        }
        collection.description = `Micromamba: ${env.name}`;
    }

    private async prepareSelection(scope: vscode.Uri | vscode.Uri[] | undefined, env?: MambaEnvironment): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const targets = new Set<vscode.WorkspaceFolder | undefined>();
        for (const uri of Array.isArray(scope) ? scope : [scope]) {
            if (!uri) {
                if (!folders.length) { targets.add(undefined); }
            } else {
                const folder = vscode.workspace.getWorkspaceFolder(uri);
                // Terminal collections support workspace-folder scopes, not per-file scopes.
                if (folder && samePath(folder.uri.fsPath, uri.fsPath)) { targets.add(folder); }
            }
        }
        // A CLI failure must not prevent selecting an otherwise valid interpreter.
        await Promise.all([...targets].map((folder) => this.apply(folder, env).catch((error) => {
            this.service.log.warn(t("Terminal environment preparation failed: {0}", String(error)));
        })));
    }

    async refresh(): Promise<void> {
        if (this.disposed) { return; }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const keys = new Set(folders.length ? folders.map((folder) => folder.uri.toString()) : ['<window>']);
        for (const [key, collection] of this.scoped) {
            if (!keys.has(key)) { collection.clear(); this.scoped.delete(key); this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1); }
        }
        if (folders.length) { this.collection.clear(); }
        await Promise.all(folders.length ? folders.map((folder) => this.apply(folder, this.bridge.activeFor(folder.uri)))
            : [this.apply(undefined, this.bridge.activeFor())]);
    }

    private shell(terminal: vscode.Terminal): Shell | undefined {
        const options = terminal.creationOptions;
        if (terminal.state.shell) { return detectShell(terminal.state.shell); }
        if ('shellPath' in options && options.shellPath) { return detectShell(options.shellPath); }
        const named = detectShell(terminal.name);
        if (named) { return named; }
        const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        const config = vscode.workspace.getConfiguration('terminal.integrated');
        const defaultProfile = config.get<string>(`defaultProfile.${platform}`);
        if (defaultProfile) {
            const profiles = config.get<Record<string, { path?: string | string[]; source?: string }>>(`profiles.${platform}`, {});
            const profile = profiles[defaultProfile];
            const executable = typeof profile?.path === 'string' ? profile.path : profile?.path?.[0];
            return detectShell(executable ?? profile?.source ?? defaultProfile);
        }
        // Windows' default profile is PowerShell; Unix follows SHELL.
        return process.platform === 'win32' ? 'powershell' : detectShell(process.env.SHELL ?? 'bash');
    }

    private async ready(terminal: vscode.Terminal): Promise<void> {
        if (terminal.shellIntegration || terminal.exitStatus) { return; }
        await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); listener.dispose(); closed.dispose(); resolve(); };
            const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => { if (event.terminal === terminal) { finish(); } });
            const closed = vscode.window.onDidCloseTerminal((item) => { if (item === terminal) { finish(); } });
            const timer = setTimeout(finish, vscode.workspace.getConfiguration('micromamba').get<number>('terminalActivationDelay', 1500));
        });
    }

    private resource(terminal: vscode.Terminal): vscode.Uri | undefined {
        if (terminal.shellIntegration?.cwd) { return terminal.shellIntegration.cwd; }
        const options = terminal.creationOptions;
        if ('cwd' in options && options.cwd) { return typeof options.cwd === 'string' ? vscode.Uri.file(options.cwd) : options.cwd; }
        return undefined;
    }

    private async autoActivate(terminal: vscode.Terminal): Promise<void> {
        // Silent mode applies variables before process creation, without sendText or
        // erasing terminal output/history. Existing terminals keep their environment.
        if (this.silent(this.resource(terminal))) { return; }
        if (this.pending.has(terminal) || this.managed.has(terminal) || this.activated.has(terminal)) { return; }
        if (!vscode.workspace.getConfiguration('micromamba').get<boolean>('autoActivateTerminal', true)) { this.service.log.debug(t("Skipping {0}: automatic activation is disabled", terminal.name)); return; }
        const options = terminal.creationOptions;
        if ('pty' in options || ('hideFromUser' in options && options.hideFromUser) || ('isTransient' in options && options.isTransient)
            || /^(Task|任务)(\s|:|-)|Python Debug Console/i.test(terminal.name)) { this.service.log.debug(t("Skipping {0}: dedicated terminal", terminal.name)); return; }
        this.pending.add(terminal);
        try {
            await this.ready(terminal);
            // isInteractedWith also becomes true for ConPTY focus notifications.
            // A shell execution is the useful signal that the user started work.
            if (terminal.exitStatus || this.executed.has(terminal)) { this.service.log.debug(t("Skipping {0}: terminal exited or a command was already executed", terminal.name)); return; }
            if (!this.shell(terminal)) { this.service.log.debug(t("Skipping {0}: unsupported interactive shell", terminal.name)); return; }
            const env = this.bridge.activeFor(this.resource(terminal));
            if (env) { await this.activate(terminal, env, false, true); }
            else { this.service.log.debug(t("Skipping {0}: no environment selected", terminal.name)); }
        } catch (error) { this.service.log.warn(t("Automatic terminal activation failed: {0}", String(error))); }
        finally { this.pending.delete(terminal); }
    }

    async activate(terminal: vscode.Terminal, env: MambaEnvironment, wait = true, automatic = false): Promise<void> {
        if (wait) { await this.ready(terminal); }
        if (terminal.exitStatus) { return; }
        const shell = this.shell(terminal);
        if (!shell) { throw new Error(t("Unable to identify the terminal shell. Use PowerShell, CMD, bash, zsh, or fish.")); }
        const executable = await this.service.executablePath();
        let batch: string | undefined;
        if (shell === 'cmd.exe') {
            batch = (await this.service.read(['shell', 'activate', '--shell', shell, '--root-prefix', env.rootPrefix, '--prefix', env.prefix])).trim();
        }
        // Don't insert a command after the user has begun typing during async setup.
        if (automatic && this.executed.has(terminal)) { return; }
        const command = activationCommand(shell, executable, env.rootPrefix, env.prefix, batch);
        terminal.sendText(command, true);
        this.activated.set(terminal, env.prefix);
        this.service.log.info(t("Sent activation command to {0}: {1}", terminal.name, env.name));
    }

    async open(env: MambaEnvironment, cwd?: vscode.Uri): Promise<void> {
        const silent = this.silent(cwd);
        // A specifically requested environment must not be overwritten by the
        // current project's variable collection, which VS Code applies after env.
        const terminal = vscode.window.createTerminal({ name: `Micromamba: ${env.name}`, cwd,
            ...(silent ? { env: await this.variables(env, true), strictEnv: true } : {}) });
        this.managed.add(terminal);
        terminal.show();
        if (silent) { this.activated.set(terminal, env.prefix); }
        else { await this.activate(terminal, env); }
    }

    dispose(): void {
        this.disposed = true;
        this.bridge.prepareSelection = undefined;
        this.subscriptions.forEach((item) => item.dispose());
        this.collection.clear();
        for (const collection of this.scoped.values()) { collection.clear(); }
    }
}
