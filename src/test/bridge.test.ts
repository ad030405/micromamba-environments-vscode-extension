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
const mock = {
    EventEmitter: Emitter, Uri, ThemeIcon: class { constructor(readonly id: string) {} },
    workspace: { workspaceFolders: [folder], getWorkspaceFolder: () => folder },
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
