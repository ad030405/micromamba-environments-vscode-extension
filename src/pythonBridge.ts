import { t } from './i18n';
import * as vscode from 'vscode';
import { PythonEnvironments, PythonEnvironmentApi, PythonEnvironment, EnvironmentManager, PackageManager,
    DidChangeEnvironmentsEventArgs, DidChangePackagesEventArgs, GetEnvironmentsScope,
    SetEnvironmentScope, GetEnvironmentScope, CreateEnvironmentScope, CreateEnvironmentOptions, RemoveEnvironmentOptions,
    PackageManagementOptions, GetPackagesOptions, Package } from '@vscode/python-environments';
import { MambaEnvironment, samePath, debugEnvironment } from './core';
import { Micromamba } from './micromamba';
import { containsUri, selectionKey, Selections } from './selection';

export interface EnvironmentActions {
    create(scope?: CreateEnvironmentScope, options?: CreateEnvironmentOptions): Promise<MambaEnvironment | undefined>;
    remove(env: MambaEnvironment, headless?: boolean): Promise<void>;
    manage(env: MambaEnvironment, options: PackageManagementOptions): Promise<void>;
}

interface PythonExtensionApi {
    environments: {
        getActiveEnvironmentPath(resource?: vscode.Uri): { path: string };
        updateActiveEnvironmentPath(path: string, resource?: vscode.Uri): Promise<void>;
    };
}

export class PythonBridge implements vscode.Disposable {
    api?: PythonEnvironmentApi;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly environmentChanges = new vscode.EventEmitter<DidChangeEnvironmentsEventArgs>();
    private readonly packageChanges = new vscode.EventEmitter<DidChangePackagesEventArgs>();
    private previous = new Map<string, PythonEnvironment>();
    private readonly environmentCache = new Map<string, { signature: string; item: PythonEnvironment }>();
    private readonly packageCache = new Map<string, Package[]>();
    private readonly savedSelections: { scope?: vscode.Uri; prefix: string }[];
    private restoring = true;
    private readonly selectionRevisions = new Map<string, number>();
    private disposed = false;
    readonly manager: EnvironmentManager;
    readonly packageManager: PackageManager;
    /** Prepare new-terminal variables before an official selection finishes. */
    prepareSelection?: (scope: SetEnvironmentScope, env?: MambaEnvironment) => Promise<void>;

    constructor(private readonly service: Micromamba, private readonly selections: Selections,
        private readonly extensionId: string, actions: EnvironmentActions) {
        this.savedSelections = selections.saved();
        this.manager = {
            name: 'micromamba', displayName: 'Micromamba', tooltip: t('Micromamba Python environments'),
            preferredPackageManagerId: `${extensionId}:micromamba`, iconPath: new vscode.ThemeIcon('server-environment'), log: service.log,
            getEnvironments: async (_scope: GetEnvironmentsScope) => (await service.discover()).filter((env) => env.pythonPath).map((env) => this.item(env)),
            refresh: async () => { await service.discover(true); },
            get: async (scope: GetEnvironmentScope) => {
                // Python also validates without a resource, even in a folder window.
                // The host can route that query to us when its project-wide default
                // manager changes. Fall back to the active project's saved selection.
                const prefix = selections.get(scope) ?? (!scope ? selections.get(selections.scope()) : undefined);
                const env = (await service.discover()).find((env) => prefix && samePath(env.prefix, prefix) && env.pythonPath);
                service.log.debug(t("Environment manager get: {0} → {1}", scope?.fsPath ?? '<window>', env?.name ?? '<unset>'));
                return env ? this.item(env) : undefined;
            },
            set: async (scope: SetEnvironmentScope, environment?: PythonEnvironment) => {
                this.service.log.debug(t("Environment manager set: {0} → {1}", Array.isArray(scope) ? scope.map((uri) => uri.fsPath).join(', ') : scope?.fsPath ?? '<window>', environment?.name ?? '<unset>'));
                const scopes = this.scopes(scope);
                if (this.disposed || !scopes.length || (!environment && this.restoring)) { return; }
                // The host can rehydrate a fallback from another provider through the
                // configured manager. It is not a Micromamba selection.
                if (environment && environment.envId.managerId !== this.managerId) { return; }
                const revisions = scopes.map((uri) => this.touch(uri));
                await this.prepareSelection?.(scope, environment ? await this.model(environment) : undefined);
                for (let i = 0; i < scopes.length; i++) {
                    if (this.revision(scopes[i]) === revisions[i]) { await selections.set(scopes[i], environment?.sysPrefix); }
                }
                // The host commits routing/settings and emits its selection event after
                // set returns. Emitting or synchronizing Python here re-enters that
                // transaction before the new manager is bound to the project.
            },
            resolve: async (context: vscode.Uri) => {
                const env = (await service.discover()).find((env) => samePath(env.prefix, context.fsPath) || (!!env.pythonPath && samePath(env.pythonPath, context.fsPath)));
                return env?.pythonPath ? this.item(env) : undefined;
            },
            create: async (scope: CreateEnvironmentScope, options?: CreateEnvironmentOptions) => {
                const env = await actions.create(scope, options);
                return env?.pythonPath ? this.item(env) : undefined;
            },
            remove: async (environment: PythonEnvironment, options?: RemoveEnvironmentOptions) => {
                await actions.remove(await this.model(environment), options?.runHeadless);
            },
            onDidChangeEnvironments: this.environmentChanges.event,
        };
        this.packageManager = {
            name: 'micromamba', displayName: 'Micromamba (Conda + pip)', iconPath: new vscode.ThemeIcon('package'), log: service.log,
            manage: async (environment: PythonEnvironment, options: PackageManagementOptions) => {
                await actions.manage(await this.model(environment), options);
                await this.refreshPackages(environment);
            },
            refresh: (environment: PythonEnvironment) => this.refreshPackages(environment),
            getPackages: async (environment: PythonEnvironment, options?: GetPackagesOptions) => {
                if (!options?.skipCache && this.packageCache.has(environment.sysPrefix)) { return this.packageCache.get(environment.sysPrefix); }
                const records = await service.packages(await this.model(environment));
                const packages = records.map((pkg) => this.api!.createPackageItem({ name: pkg.name, displayName: pkg.name, version: pkg.version,
                    description: pkg.isPip ? 'pip / PyPI' : pkg.channel, tooltip: `${pkg.name} ${pkg.version}\n${pkg.channel}\n${pkg.build}` }, environment, this.packageManager));
                this.packageCache.set(environment.sysPrefix, packages);
                return packages;
            },
            getPackageWatchTargets: (environment: PythonEnvironment) => [new vscode.RelativePattern(environment.sysPrefix, 'conda-meta/*.json')],
            formatInstallSpec: (name: string, version: string) => `${name}=${version}`,
            onDidChangePackages: this.packageChanges.event,
        };
        this.disposables.push(service.onDidChange(() => { this.packageCache.clear(); this.publishDiscovery(); }));
    }

    async connect(): Promise<void> {
        this.api = await PythonEnvironments.api();
        this.disposables.push(this.api.registerPackageManager(this.packageManager, { extensionId: this.extensionId }),
            this.api.registerEnvironmentManager(this.manager, { extensionId: this.extensionId }));
        // Selecting another provider in the official picker must stop our terminal auto-activation.
        this.disposables.push(this.api.onDidChangeEnvironment((event) => {
            if (this.disposed) { return; }
            this.service.log.debug(t("Official selection changed: {0} → {1}", event.uri?.fsPath ?? '<window>', event.new?.envId.managerId ?? '<unset>'));
            void (async () => {
                if (!this.scopes(event.uri).length) { return; }
                const prefix = this.selections.get(event.uri);
                // Read/discovery events never create records. Our provider's set has
                // already saved a real selection before the host emits this event.
                if (event.new?.envId.managerId !== this.managerId && event.new && prefix
                    && (!this.restoring || event.old?.envId.managerId === this.managerId)
                    && (event.old?.envId.managerId === this.managerId
                        || this.service.environments.some((env) => env.pythonPath && samePath(env.prefix, prefix))
                        || this.projectUsesManager(event.uri, event.new.envId.managerId))) {
                    this.touch(event.uri);
                    await this.selections.set(event.uri, undefined);
                }
                // Only synchronize the legacy path after the host has committed its
                // selection. Notifications from other providers belong to those providers.
                if (event.new?.envId.managerId === this.managerId && prefix && samePath(prefix, event.new.sysPrefix)) {
                    await this.syncPython(event.new, event.uri);
                }
            })().catch((error) => this.service.log.warn(t("Python interpreter synchronization failed: {0}", String(error))));
        }));
        this.publishDiscovery();
    }

    async restoreSelections(): Promise<void> {
        this.service.log.debug(t("Restoring {0} saved project environment selections", this.savedSelections.length));
        if (!this.api) { this.restoring = false; return; }
        try {
            const revisions = this.savedSelections.map((saved) => this.revision(saved.scope));
            if (this.savedSelections.length) {
                // Initial auto-discovery runs in the background. Let it settle before
                // restoring, otherwise its late result can overwrite the user's choice.
                await this.api.getEnvironments('all');
            }
            for (let i = 0; i < this.savedSelections.length; i++) {
                const saved = this.savedSelections[i];
                const current = await this.api.getEnvironment(saved.scope);
                if (this.disposed || this.revision(saved.scope) !== revisions[i]
                    || !samePath(this.selections.get(saved.scope) ?? '', saved.prefix)) { continue; }
                const env = this.service.environments.find((item) => samePath(item.prefix, saved.prefix) && item.pythonPath);
                if (!env) {
                    // A disconnected drive or temporary discovery failure must not
                    // erase the user's project choice.
                    this.service.log.warn(t('Saved Micromamba environment is unavailable for {0}: {1}. The selection has been kept.', saved.scope?.fsPath ?? '<window>', saved.prefix));
                    continue;
                }
                const item = this.item(env);
                if (current?.envId.managerId === this.managerId && samePath(current.sysPrefix, env.prefix)) {
                    await this.prepareSelection?.(saved.scope, env);
                    if (this.revision(saved.scope) === revisions[i]) { await this.syncPython(item, saved.scope); }
                } else { await this.api.setEnvironment(saved.scope, item); }
            }
        } finally { this.restoring = false; }
    }

    private get managerId(): string { return `${this.extensionId}:${this.manager.name}`; }

    private projectUsesManager(scope: vscode.Uri | undefined, managerId: string): boolean {
        const setting = vscode.workspace.getConfiguration('python-envs', scope).inspect<string>('defaultEnvManager');
        // A persisted project binding proves a switch even if the old environment
        // is unavailable. A global/default fallback does not supersede its record.
        return (setting?.workspaceFolderValue ?? setting?.workspaceValue) === managerId;
    }

    private scopes(scope: SetEnvironmentScope): (vscode.Uri | undefined)[] {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return (Array.isArray(scope) ? scope : [scope]).filter((uri) => uri
            ? folders.some((folder) => containsUri(folder.uri, uri)) : !folders.length);
    }

    private revision(scope?: vscode.Uri): number { return this.selectionRevisions.get(selectionKey(scope)) ?? 0; }

    private touch(scope?: vscode.Uri): number {
        const revision = this.revision(scope) + 1;
        this.selectionRevisions.set(selectionKey(scope), revision);
        return revision;
    }

    private async syncPython(environment: PythonEnvironment, scope?: vscode.Uri): Promise<void> {
        // The legacy public API caches one path per workspace folder. Modern consumers
        // (including Pylance) use the environments API, but older tools still read this cache.
        // Don't apply global or per-file selections to an unrelated workspace folder.
        const folder = scope ? vscode.workspace.getWorkspaceFolder(scope) : undefined;
        if (!scope || !folder || selectionKey(folder.uri) !== selectionKey(scope)) { return; }
        const revision = this.revision(scope);
        const extension = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
        if (!extension) { return; }
        if (!extension.isActive) { await extension.activate(); }
        if (this.disposed || this.revision(scope) !== revision || !samePath(this.selections.get(scope) ?? '', environment.sysPrefix)) { return; }
        const api = extension.exports?.environments;
        const python = environment.execInfo.run.executable;
        if (api?.updateActiveEnvironmentPath && !samePath(api.getActiveEnvironmentPath(scope).path, python)) {
            await api.updateActiveEnvironmentPath(python, scope);
        }
    }

    item(env: MambaEnvironment): PythonEnvironment {
        if (!this.api || !env.pythonPath) { throw new Error(t("The Python Environments API is not connected, or this environment has no Python interpreter.")); }
        const executable = this.service.resolvedExecutable;
        if (!executable) { throw new Error(t("The micromamba executable has not been resolved.")); }
        // The API factory generates a new random ID. Reuse items across get/resolve/
        // discovery calls so reading the current environment cannot change its identity.
        const key = process.platform === 'win32' ? env.prefix.toLowerCase() : env.prefix;
        const signature = JSON.stringify([env.name, env.prefix, env.pythonPath, env.version, env.rootPrefix, executable]);
        const cached = this.environmentCache.get(key);
        if (cached?.signature === signature) { return cached.item; }
        const item = this.api.createPythonEnvironmentItem({
            name: env.name, displayName: `${env.name} (micromamba)`, shortDisplayName: env.name,
            displayPath: env.prefix, environmentPath: vscode.Uri.file(env.pythonPath), version: env.version || 'unknown',
            sysPrefix: env.prefix, description: env.version ? `Python ${env.version}` : 'micromamba',
            iconPath: new vscode.ThemeIcon('snake'),
            execInfo: {
                run: { executable: env.pythonPath },
                activatedRun: { executable, args: ['run', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, env.pythonPath] },
            },
        }, this.manager);
        this.environmentCache.set(key, { signature, item });
        return item;
    }

    private async model(environment: PythonEnvironment): Promise<MambaEnvironment> {
        const env = (await this.service.discover()).find((env) => samePath(env.prefix, environment.sysPrefix));
        if (!env) { throw new Error(t("This micromamba environment no longer exists.")); }
        return env;
    }

    private publishDiscovery(): void {
        if (!this.api) { return; }
        const current = new Map(this.service.environments.filter((env) => env.pythonPath).map((env) => [env.prefix, this.item(env)]));
        const changes: DidChangeEnvironmentsEventArgs = [];
        const different = (a: PythonEnvironment, b: PythonEnvironment) => a.envId.id !== b.envId.id;
        for (const [key, environment] of this.previous) {
            const replacement = current.get(key);
            if (!replacement || different(environment, replacement)) { changes.push({ kind: 'remove' as DidChangeEnvironmentsEventArgs[number]['kind'], environment }); }
        }
        for (const [key, environment] of current) {
            const old = this.previous.get(key);
            if (!old || different(old, environment)) { changes.push({ kind: 'add' as DidChangeEnvironmentsEventArgs[number]['kind'], environment }); }
        }
        this.previous = current;
        for (const key of this.environmentCache.keys()) {
            if (!this.service.environments.some((env) => env.pythonPath && samePath(env.prefix, key))) { this.environmentCache.delete(key); }
        }
        if (changes.length) { this.environmentChanges.fire(changes); }
    }

    private async refreshPackages(environment: PythonEnvironment): Promise<void> {
        const old = this.packageCache.get(environment.sysPrefix) ?? [];
        const current = await this.packageManager.getPackages(environment, { skipCache: true }) ?? [];
        this.packageChanges.fire({ environment, manager: this.packageManager, changes: [
            ...old.map((pkg) => ({ kind: 'remove' as DidChangePackagesEventArgs['changes'][number]['kind'], pkg })),
            ...current.map((pkg) => ({ kind: 'add' as DidChangePackagesEventArgs['changes'][number]['kind'], pkg })),
        ] });
    }

    async select(env: MambaEnvironment, scope?: vscode.Uri): Promise<void> {
        if (!env.pythonPath) { throw new Error(t("This environment has no Python interpreter. Install python first.")); }
        if (!this.api) { throw new Error(t("The Python Environments API is unavailable. Enable python.useEnvironmentsExtension and reload the window.")); }
        await this.api.setEnvironment(scope, this.item(env));
    }

    async clearSelections(env: MambaEnvironment): Promise<void> {
        for (const scope of this.selections.scopesFor(env.prefix)) { await this.api?.setEnvironment(scope, undefined); }
        await this.selections.forget(env.prefix);
    }

    activeFor(resource?: vscode.Uri): MambaEnvironment | undefined {
        const prefix = this.selections.get(resource ?? this.selections.scope());
        return this.service.environments.find((env) => prefix && samePath(env.prefix, prefix));
    }

    async debugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration> {
        // Respect an explicit interpreter in launch.json.
        if (config.request !== 'launch' || config.python || config.pythonPath) { return config; }
        const env = this.activeFor(folder?.uri);
        if (!env?.pythonPath) { return config; }
        config.python = env.pythonPath;
        const activated = await this.service.activatedEnv(env);
        config.env = debugEnvironment(activated, process.env, config.env);
        config._micromambaDebugEnvironment = { ...config.env };
        return config;
    }

    finalizeDebugConfiguration(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
        if (config._micromambaDebugEnvironment) {
            // The Python debugger merges inherited variables after the first resolver.
            // Normalize once more at the final stage and retain the activated path.
            config.env = debugEnvironment({}, {}, { ...config.env, ...config._micromambaDebugEnvironment });
            delete config._micromambaDebugEnvironment;
        }
        return config;
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        // Unsubscribe before unregistering managers, which emits selection changes.
        this.disposables.reverse().forEach((item) => item.dispose());
        this.environmentChanges.dispose(); this.packageChanges.dispose();
    }
}
