import { t } from './i18n';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MambaEnvironment, MambaPackage, environmentPrefixes, packageRecords, parseJson, expandPath, samePath, environmentName } from './core';
import { runProcess } from './process';

async function exists(file: string): Promise<boolean> {
    try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

export class Micromamba implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    environments: MambaEnvironment[] = [];
    private executable?: string;
    private root?: string;
    private discovery?: Promise<MambaEnvironment[]>;
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly controllers = new Set<AbortController>();
    private readonly activationCache = new Map<string, NodeJS.ProcessEnv>();

    constructor(readonly log: vscode.LogOutputChannel, private readonly runner: typeof runProcess = runProcess) {}

    get resolvedExecutable(): string | undefined { return this.executable; }

    async executablePath(): Promise<string> {
        if (this.executable) { return this.executable; }
        const config = vscode.workspace.getConfiguration('micromamba');
        const configured = expandPath(config.get<string>('executablePath', ''));
        const root = expandPath(config.get<string>('rootPrefix', '') || process.env.MAMBA_ROOT_PREFIX || '');
        const binary = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba';
        const roots = [root, path.join(os.homedir(), 'micromamba'), path.join(os.homedir(), '.local', 'bin')].filter(Boolean);
        const candidates = configured ? [configured] : [process.env.MAMBA_EXE ?? '',
            ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, binary)),
            ...roots.flatMap((dir) => [path.join(dir, binary), path.join(dir, 'bin', binary), path.join(dir, 'Library', 'bin', binary)])];
        for (const file of candidates) {
            if (file && await exists(file)) { this.executable = path.resolve(file); return this.executable; }
        }
        throw new Error(t("Micromamba was not found. Set micromamba.executablePath in Settings (Windows example: D:\\develop\\micromamba\\micromamba.exe)."));
    }

    async rootPrefix(): Promise<string> {
        if (this.root) { return this.root; }
        const configured = expandPath(vscode.workspace.getConfiguration('micromamba').get<string>('rootPrefix', '') || process.env.MAMBA_ROOT_PREFIX || '');
        if (configured) { this.root = path.resolve(configured); return this.root; }
        const data = parseJson(await this.read(['info', '--json'])) as Record<string, unknown>;
        const root = data['root prefix'] ?? data.root_prefix ?? data['base environment'];
        if (typeof root !== 'string' || !root) { throw new Error(t("Unable to determine the root directory. Set micromamba.rootPrefix.")); }
        this.root = path.resolve(root);
        return this.root;
    }

    private processEnv(): NodeJS.ProcessEnv {
        const root = expandPath(vscode.workspace.getConfiguration('micromamba').get<string>('rootPrefix', '') || process.env.MAMBA_ROOT_PREFIX || '');
        return { ...process.env, ...(root ? { MAMBA_ROOT_PREFIX: root } : {}) };
    }

    async read(args: string[]): Promise<string> {
        const executable = await this.executablePath();
        this.log.debug(`micromamba ${args.join(' ')}`);
        return this.runner(executable, args, {
            env: this.processEnv(), timeout: vscode.workspace.getConfiguration('micromamba').get<number>('commandTimeout', 60) * 1000,
        });
    }

    async discover(force = false): Promise<MambaEnvironment[]> {
        if (this.discovery) { return this.discovery; }
        if (!force && this.environments.length) { return this.environments; }
        this.discovery = (async () => {
            const root = await this.rootPrefix();
            const prefixes = environmentPrefixes(parseJson(await this.read(['env', 'list', '--json', '--root-prefix', root])));
            const environments = await Promise.all(prefixes.map(async (prefix) => {
                const binaries = process.platform === 'win32' ? [path.join(prefix, 'python.exe')] : [path.join(prefix, 'bin', 'python'), path.join(prefix, 'bin', 'python3')];
                let pythonPath: string | undefined;
                for (const candidate of binaries) { if (await exists(candidate)) { pythonPath = candidate; break; } }
                let version = '';
                try {
                    const metadata = (await fs.readdir(path.join(prefix, 'conda-meta'))).find((file) => /^python-\d.*\.json$/.test(file));
                    if (metadata) { version = String(JSON.parse(await fs.readFile(path.join(prefix, 'conda-meta', metadata), 'utf8')).version ?? ''); }
                } catch { /* A base environment need not contain Python or conda-meta. */ }
                return { name: samePath(prefix, root) ? 'base' : path.basename(prefix), prefix, rootPrefix: root, isBase: samePath(prefix, root), pythonPath, version };
            }));
            this.environments = environments.sort((a, b) => Number(b.isBase) - Number(a.isBase) || a.name.localeCompare(b.name));
            this.changed.fire();
            return this.environments;
        })();
        try { return await this.discovery; } finally { this.discovery = undefined; }
    }

    async packages(env: MambaEnvironment): Promise<MambaPackage[]> {
        return packageRecords(parseJson(await this.read(['list', '--prefix', env.prefix, '--root-prefix', env.rootPrefix, '--json'])));
    }

    channels(): string[] {
        return vscode.workspace.getConfiguration('micromamba').get<string[]>('channels', ['conda-forge']).flatMap((channel) => ['--channel', channel]);
    }

    async mutate(title: string, prefix: string, args: string[], before?: () => Promise<void>): Promise<void> {
        const previous = this.queues.get(prefix) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(async () => {
            await before?.();
            const executable = await this.executablePath();
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
                const controller = new AbortController();
                this.controllers.add(controller);
                const disposable = token.onCancellationRequested(() => controller.abort());
                this.log.info(`${title}: micromamba ${args.join(' ')}`);
                this.log.show(true);
                try { await this.runner(executable, args, { env: this.processEnv(), signal: controller.signal, onOutput: (text) => this.log.append(text) }); }
                finally { disposable.dispose(); this.controllers.delete(controller); this.activationCache.delete(prefix); this.changed.fire(); }
            });
        });
        this.queues.set(prefix, operation);
        try { await operation; } finally { if (this.queues.get(prefix) === operation) { this.queues.delete(prefix); } }
    }

    async create(name: string, specs: string[], yaml?: string): Promise<MambaEnvironment> {
        const root = await this.rootPrefix();
        const prefix = path.join(root, 'envs', environmentName(name));
        await this.mutate(t("Create environment {0}", name), prefix, ['create', '--prefix', prefix, '--root-prefix', root, '--yes', ...this.channels(), ...(yaml ? ['--file', yaml] : specs)], async () => {
            try { await fs.stat(prefix); throw new Error(t("The directory already exists. Cannot create an environment with the same name: {0}", prefix)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        });
        const env = (await this.discover(true)).find((item) => samePath(item.prefix, prefix));
        if (!env) { throw new Error(t("The environment was created but was not discovered. Refresh the list.")); }
        return env;
    }

    async remove(env: MambaEnvironment): Promise<void> {
        if (env.isBase || samePath(env.prefix, await this.rootPrefix())) { throw new Error(t("The micromamba root directory and base environment cannot be deleted.")); }
        if (!(await this.discover(true)).some((item) => samePath(item.prefix, env.prefix))) { throw new Error(t("The environment no longer exists. Refresh the list.")); }
        await this.mutate(t("Delete environment {0}", env.name), env.prefix, ['env', 'remove', '--prefix', env.prefix, '--root-prefix', env.rootPrefix, '--yes']);
        await this.discover(true);
    }

    async activatedEnv(env: MambaEnvironment): Promise<NodeJS.ProcessEnv> {
        if (!env.pythonPath) { throw new Error(t("This environment has no Python interpreter.")); }
        const cached = this.activationCache.get(env.prefix);
        if (cached) { return cached; }
        const output = await this.read(['run', '--root-prefix', env.rootPrefix, '--prefix', env.prefix, env.pythonPath, '-c', 'import json, os; print(json.dumps(dict(os.environ)))']);
        const data = parseJson(output);
        if (!data || typeof data !== 'object' || Array.isArray(data)) { throw new Error(t("Unable to read the activated environment variables.")); }
        const variables: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(data)) { if (typeof value === 'string') { variables[key] = value; } }
        this.activationCache.set(env.prefix, variables);
        return variables;
    }

    invalidate(): void { this.executable = undefined; this.root = undefined; this.environments = []; this.activationCache.clear(); this.changed.fire(); }
    dispose(): void { for (const controller of this.controllers) { controller.abort(); } this.changed.dispose(); }
}
