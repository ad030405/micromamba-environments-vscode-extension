import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { PythonEnvironmentApi, PythonEnvironment, EnvironmentManager } from '@vscode/python-environments';
import type { Micromamba } from '../micromamba';
import type { PythonBridge as Bridge } from '../pythonBridge';
import type { Selections as Store } from '../selection';

class Emitter<T> {
    private callbacks = new Set<(value: T) => void>();
    event = (callback: (value: T) => void) => { this.callbacks.add(callback); return { dispose: () => this.callbacks.delete(callback) }; };
    fire(value: T): void { for (const callback of this.callbacks) { callback(value); } }
    dispose(): void { this.callbacks.clear(); }
}
class Uri {
    constructor(readonly fsPath: string) {}
    readonly scheme = 'file';
    readonly authority = '';
    get path(): string { return this.fsPath.replace(/\\/g, '/'); }
    static file(file: string): Uri { return new Uri(file); }
    static parse(value: string): Uri { return new Uri(value.slice('fixture:'.length)); }
    toString(): string { return `fixture:${this.fsPath}`; }
}
const root = Uri.file(path.resolve('bridge-fixture'));
const folder = { uri: root };
let officialApi: PythonEnvironmentApi;
let legacyPath = '';
let invalidDiagnostics = 0;
let legacyUpdates = 0;
let projectManager: string | undefined;
const mock = {
    EventEmitter: Emitter, Uri, ThemeIcon: class { constructor(readonly id: string) {} },
    workspace: { workspaceFolders: [folder], getWorkspaceFolder: () => folder,
        getConfiguration: () => ({ inspect: () => ({ workspaceValue: projectManager }) }) },
    window: { activeTextEditor: undefined },
    extensions: { getExtension: () => ({ isActive: true, exports: { environments: {
        getActiveEnvironmentPath: () => ({ path: legacyPath }),
        updateActiveEnvironmentPath: async (python: string, scope: vscode.Uri) => {
            legacyUpdates++;
            if (!await officialApi.getEnvironment(scope)) { invalidDiagnostics++; }
            legacyPath = python;
        },
    } } }) },
};
const moduleLoader = require('node:module') as { _load: (request: string, ...args: unknown[]) => unknown };
const original = moduleLoader._load;
moduleLoader._load = function (request: string, ...args: unknown[]) {
    if (request === 'vscode') { return mock; }
    if (request === '@vscode/python-environments') { return { PythonEnvironments: { api: async () => officialApi } }; }
    return original.apply(this, [request, ...args]);
};
const PythonBridge = (require('../pythonBridge') as { PythonBridge: typeof Bridge }).PythonBridge;
const Selections = (require('../selection') as { Selections: typeof Store }).Selections;
moduleLoader._load = original;

test('first official selection commits before legacy synchronization and environment identity stays stable', async () => {
    const data: Record<string, unknown> = {};
    const store = new Selections({ keys: () => Object.keys(data), get: (key: string, fallback: unknown) => data[key] ?? fallback,
        update: async (key: string, value: unknown) => { data[key] = value; } } as unknown as vscode.Memento);
    const changed = new Emitter<void>();
    const hostChanges = new Emitter<{ uri?: vscode.Uri; old?: PythonEnvironment; new?: PythonEnvironment }>();
    const env = { name: 'fixture', prefix: path.resolve('mamba-fixture/envs/fixture'), rootPrefix: path.resolve('mamba-fixture'),
        pythonPath: path.resolve('mamba-fixture/envs/fixture/python.exe'), version: '3.12.7', isBase: false };
    const service = { log: { debug() {}, warn() {} }, environments: [env], resolvedExecutable: 'micromamba',
        discover: async () => [env], onDidChange: changed.event } as unknown as Micromamba;
    let registered: EnvironmentManager;
    let routingCommitted = false;
    let ids = 0;
    let notifications = 0;
    officialApi = {
        registerPackageManager: () => ({ dispose() {} }),
        registerEnvironmentManager: (manager: EnvironmentManager) => { registered = manager; return { dispose() {} }; },
        createPythonEnvironmentItem: (info: unknown) => ({ ...info as object, envId: { managerId: 'fixture.extension:micromamba', id: `env-${++ids}` } }),
        onDidChangeEnvironment: hostChanges.event,
        getEnvironment: async (scope?: vscode.Uri) => routingCommitted ? registered.get(scope) : undefined,
        setEnvironment: async (scope?: vscode.Uri, environment?: PythonEnvironment) => {
            await registered.set(scope, environment);
            // Simulate the host persisting project routing only after provider.set returns.
            assert.equal(legacyUpdates, notifications, 'Provider must not re-enter Python while routing is uncommitted');
            routingCommitted = true;
            notifications++;
            hostChanges.fire({ uri: scope, new: environment });
        },
    } as unknown as PythonEnvironmentApi;
    const bridge = new PythonBridge(service, store, 'fixture.extension', { create: async () => undefined, remove: async () => {}, manage: async () => {} });
    try {
        await bridge.connect();
        await bridge.restoreSelections();
        const item = bridge.item(env);
        await officialApi.setEnvironment(root as vscode.Uri, item);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(invalidDiagnostics, 0, 'A valid first choice must not trigger the invalid-interpreter diagnostic');
        assert.equal(legacyPath, env.pythonPath);
        const selected = await officialApi.getEnvironment(root as vscode.Uri);
        assert.strictEqual(selected, item);
        assert.strictEqual(await bridge.manager.get(undefined), item, 'Resource-less Python validation falls back to the selected project');
        for (let i = 0; i < 10; i++) {
            assert.strictEqual(await bridge.manager.get(root as vscode.Uri), item);
            assert.strictEqual(await bridge.manager.resolve(Uri.file(env.pythonPath) as vscode.Uri), item);
            assert.strictEqual((await bridge.manager.getEnvironments('all'))[0], item);
        }
        assert.equal(ids, 1, 'Reads must not manufacture new environment identities');
        assert.equal(bridge.manager.onDidChangeEnvironment, undefined, 'The host owns notifications for its set transaction');
        env.version = '3.12.8';
        assert.notEqual(bridge.item(env).envId.id, item.envId.id, 'A changed interpreter must invalidate its cached metadata');
        hostChanges.fire({ uri: root as vscode.Uri, new: { ...item, envId: { managerId: 'other:venv', id: 'other' } } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(store.get(root as vscode.Uri), undefined);
        assert.equal(legacyUpdates, 1, 'Other providers must manage their own Python synchronization');
    } finally { bridge.dispose(); store.dispose(); changed.dispose(); hostChanges.dispose(); }
});

async function fixture(saved = false) {
    legacyPath = ''; legacyUpdates = 0; invalidDiagnostics = 0; projectManager = undefined;
    const data: Record<string, unknown> = {};
    const store = new Selections({ keys: () => Object.keys(data), get: (key: string, fallback: unknown) => data[key] ?? fallback,
        update: async (key: string, value: unknown) => { data[key] = value; } } as unknown as vscode.Memento);
    const env = { name: 'fixture', prefix: path.resolve('mamba-fixture/envs/fixture'), rootPrefix: path.resolve('mamba-fixture'),
        pythonPath: path.resolve('mamba-fixture/envs/fixture/python.exe'), version: '3.12.7', isBase: false };
    const other = { ...env, name: 'second', prefix: path.resolve('mamba-fixture/envs/second'), pythonPath: path.resolve('mamba-fixture/envs/second/python.exe') };
    if (saved) { await store.set(root as vscode.Uri, env.prefix); }
    const hostChanges = new Emitter<{ uri?: vscode.Uri; old?: PythonEnvironment; new?: PythonEnvironment }>();
    const warnings: string[] = [];
    const service = { log: { debug() {}, warn(message: string) { warnings.push(message); } }, environments: [env, other],
        resolvedExecutable: 'micromamba', discover: async () => service.environments,
        onDidChange: () => ({ dispose() {} }) };
    const state: { current?: PythonEnvironment; sets: number; discovery: () => Promise<unknown> } = { sets: 0, discovery: async () => [] };
    let registered: EnvironmentManager;
    officialApi = {
        registerPackageManager: () => ({ dispose() {} }),
        registerEnvironmentManager: (manager: EnvironmentManager) => { registered = manager; return { dispose() {} }; },
        createPythonEnvironmentItem: (info: unknown) => ({ ...info as object, envId: { managerId: 'fixture.extension:micromamba', id: 'stable' } }),
        onDidChangeEnvironment: hostChanges.event,
        getEnvironments: () => state.discovery(),
        getEnvironment: async () => state.current,
        setEnvironment: async (scope: vscode.Uri, environment?: PythonEnvironment) => {
            state.sets++;
            await registered.set(scope, environment);
            const old = state.current;
            state.current = environment;
            hostChanges.fire({ uri: scope, old, new: environment });
        },
    } as unknown as PythonEnvironmentApi;
    const bridge = new PythonBridge(service as unknown as Micromamba, store, 'fixture.extension', { create: async () => undefined, remove: async () => {}, manage: async () => {} });
    await bridge.connect();
    const item = bridge.item(env);
    const second = bridge.item(other);
    return { bridge, store, env, other, item, second, hostChanges, service, state, warnings,
        dispose() { bridge.dispose(); store.dispose(); hostChanges.dispose(); } };
}

test('discovery and unscoped or foreign callbacks do not bind untouched projects', async () => {
    const f = await fixture();
    try {
        await f.bridge.manager.getEnvironments('all');
        await f.bridge.manager.resolve(Uri.file(f.env.pythonPath) as vscode.Uri);
        assert.equal(await f.bridge.manager.get(root as vscode.Uri), undefined);
        await f.bridge.manager.set(undefined, f.item);
        await f.bridge.manager.set(root as vscode.Uri, { ...f.item, envId: { managerId: 'other:global', id: 'global' } });
        f.hostChanges.fire({ uri: root as vscode.Uri, new: f.item });
        await f.bridge.restoreSelections();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.store.saved(), []);
        assert.equal(f.state.sets, 0, 'No automatic setEnvironment means no automatic project manager settings');
        assert.equal(legacyUpdates, 0, 'Read notifications must not re-enter the legacy setter');
    } finally { f.dispose(); }
});

test('startup unset cannot erase a saved choice, and a restored choice is not assigned twice', async () => {
    const f = await fixture(true);
    try {
        await f.bridge.manager.set(root as vscode.Uri, undefined);
        f.hostChanges.fire({ uri: root as vscode.Uri, old: f.item });
        assert.equal(f.store.get(root as vscode.Uri), f.env.prefix);
        await f.bridge.restoreSelections();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.state.current?.sysPrefix, f.env.prefix);
        assert.equal(f.state.sets, 1);
        await f.bridge.restoreSelections();
        assert.equal(f.state.sets, 1, 'A matching official selection needs no additional assignment');
        f.hostChanges.fire({ uri: root as vscode.Uri, old: f.item });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.store.get(root as vscode.Uri), f.env.prefix, 'Transient unset notifications are not an explicit clear');
        await f.bridge.manager.set(root as vscode.Uri, undefined);
        assert.equal(f.store.get(root as vscode.Uri), undefined, 'An explicit provider clear still works after startup');
    } finally { f.dispose(); }
});

test('a missing environment keeps the record without binding a fallback', async () => {
    const f = await fixture(true);
    try {
        f.service.environments = [];
        await f.bridge.restoreSelections();
        assert.equal(f.store.get(root as vscode.Uri), f.env.prefix);
        assert.equal(f.state.sets, 0);
        assert.ok(f.warnings.some(message => message.includes(f.env.prefix)));
        f.hostChanges.fire({ uri: root as vscode.Uri, new: { ...f.item, envId: { managerId: 'other:global', id: 'fallback' } } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.store.get(root as vscode.Uri), f.env.prefix, 'A late fallback discovery cannot erase a missing environment record');
        projectManager = 'other:global';
        f.hostChanges.fire({ uri: root as vscode.Uri, new: { ...f.item, envId: { managerId: 'other:global', id: 'chosen' } } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.store.get(root as vscode.Uri), undefined, 'Explicitly binding another provider supersedes even an unavailable environment');
    } finally { f.dispose(); }
});

test('a newer Micromamba choice during startup wins over the saved snapshot', async () => {
    const f = await fixture(true);
    let release!: () => void;
    f.state.discovery = () => new Promise(resolve => { release = () => resolve([]); });
    try {
        const restoring = f.bridge.restoreSelections();
        await f.bridge.manager.set(root as vscode.Uri, f.second);
        release();
        await restoring;
        assert.equal(f.store.get(root as vscode.Uri), f.other.prefix);
        assert.equal(f.state.sets, 0, 'Restore must not overwrite the newer choice');
    } finally { f.dispose(); }
});

test('failed restoration keeps the record and releases the startup guard', async () => {
    const f = await fixture(true);
    try {
        f.state.discovery = async () => { throw new Error('Discovery temporarily failed'); };
        await assert.rejects(f.bridge.restoreSelections(), /temporarily failed/);
        assert.equal(f.store.get(root as vscode.Uri), f.env.prefix);
        await f.bridge.manager.set(root as vscode.Uri, undefined);
        assert.equal(f.store.get(root as vscode.Uri), undefined, 'An explicit clear must remain available after startup failure');
    } finally { f.dispose(); }
});

test('a newer choice during slow terminal preparation is not reverted through the Python compatibility API', async () => {
    const f = await fixture(true);
    let release!: () => void;
    f.state.current = f.item;
    legacyPath = f.env.pythonPath;
    f.bridge.prepareSelection = async (_scope, env) => {
        if (env?.prefix === f.env.prefix) { await new Promise<void>(resolve => { release = resolve; }); }
    };
    try {
        const restoring = f.bridge.restoreSelections();
        await new Promise(resolve => setImmediate(resolve));
        await officialApi.setEnvironment(root as vscode.Uri, f.second);
        await new Promise(resolve => setImmediate(resolve));
        release();
        await restoring;
        assert.equal(f.store.get(root as vscode.Uri), f.other.prefix);
        assert.equal(legacyPath, f.other.pythonPath);
        assert.equal(f.state.sets, 1);
        assert.equal(legacyUpdates, 1, 'Only the newer choice is synchronized to Python');
    } finally { f.dispose(); }
});

test('switching away during startup cancels Micromamba restoration', async () => {
    const f = await fixture(true);
    let release!: () => void;
    f.state.discovery = () => new Promise(resolve => { release = () => resolve([]); });
    try {
        const restoring = f.bridge.restoreSelections();
        f.state.current = { ...f.item, sysPrefix: 'other-prefix', envId: { managerId: 'other:venv', id: 'other' } };
        f.hostChanges.fire({ uri: root as vscode.Uri, old: f.item, new: f.state.current });
        await new Promise(resolve => setImmediate(resolve));
        release();
        await restoring;
        assert.equal(f.store.get(root as vscode.Uri), undefined);
        assert.equal(f.state.sets, 0);
        assert.equal(legacyUpdates, 0);
    } finally { f.dispose(); }
});
