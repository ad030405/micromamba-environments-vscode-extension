import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as vscode from 'vscode';
import type { Micromamba as Service } from '../micromamba';
import type { Selections as Store } from '../selection';
import type { runProcess } from '../process';
import { containsPath } from '../core';

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
const config: Record<string, unknown> = {};
const mock = {
    EventEmitter: Emitter, Uri, ProgressLocation: { Notification: 15 },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => config[key] ?? fallback }), workspaceFolders: [] as { uri: Uri }[], getWorkspaceFolder: () => undefined },
    window: { activeTextEditor: undefined, withProgress: async (_options: unknown, callback: (progress: unknown, token: unknown) => Promise<unknown>) =>
        callback({}, { onCancellationRequested: () => ({ dispose() {} }) }) },
};
const moduleLoader = require('node:module') as { _load: (request: string, ...args: unknown[]) => unknown };
const original = moduleLoader._load;
moduleLoader._load = function (request: string, ...args: unknown[]) { return request === 'vscode' ? mock : original.apply(this, [request, ...args]); };
const Micromamba = (require('../micromamba') as { Micromamba: typeof Service }).Micromamba;
const Selections = (require('../selection') as { Selections: typeof Store }).Selections;
moduleLoader._load = original;
const log = { debug() {}, info() {}, warn() {}, error() {}, show() {}, append() {} } as unknown as vscode.LogOutputChannel;

test('discovers real prefix layout, classifies packages, serializes mutations, and protects base', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'micromamba-vscode-test-'));
    config.executablePath = process.execPath; config.rootPrefix = root; config.channels = ['conda-forge'];
    const created = path.join(root, 'envs', 'fixture');
    const binary = path.join(created, process.platform === 'win32' ? 'python.exe' : 'bin/python');
    const calls: string[][] = [];
    let running = 0;
    let maximum = 0;
    let prefixes = [root];
    const runner: typeof runProcess = async (_executable, args) => {
        calls.push(args);
        if (args[0] === 'env' && args[1] === 'list') { return JSON.stringify({ envs: prefixes }); }
        if (args[0] === 'list') { return JSON.stringify({ packages: [{ name: 'torch', version: '2.8', channel: 'pypi', build_string: 'pypi_0' }] }); }
        running++; maximum = Math.max(maximum, running);
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (args[0] === 'create') {
            await fs.mkdir(path.dirname(binary), { recursive: true });
            await fs.writeFile(binary, 'fixture');
            await fs.mkdir(path.join(created, 'conda-meta'), { recursive: true });
            await fs.writeFile(path.join(created, 'conda-meta', 'python-3.12.7-fixture.json'), JSON.stringify({ version: '3.12.7' }));
            prefixes.push(created);
        }
        if (args[0] === 'env' && args[1] === 'remove') { prefixes = prefixes.filter((item) => item !== created); }
        running--;
        return '';
    };
    const service = new Micromamba(log, runner);
    try {
        const base = (await service.discover())[0];
        assert.equal(base.isBase, true);
        assert.equal(base.pythonPath, undefined);
        await assert.rejects(service.remove(base), /base/);
        assert.equal(calls.some((args) => args[1] === 'remove'), false);
        const env = await service.create('fixture', ['python=3.12', 'pip']);
        assert.equal(env.version, '3.12.7');
        assert.equal(env.pythonPath, binary);
        assert.equal((await service.packages(env))[0].isPip, true);
        const call = calls.find((args) => args[0] === 'create')!;
        assert.equal(call[call.indexOf('--prefix') + 1], created);
        assert.ok(call.includes('python=3.12'));
        await assert.rejects(service.create('fixture', ['python']), /already exists/);
        assert.equal(calls.filter((args) => args[0] === 'create').length, 1);
        await Promise.all([service.mutate('first', created, ['install', 'numpy']), service.mutate('second', created, ['install', 'scipy'])]);
        assert.equal(maximum, 1, 'Modifications of one environment must not run concurrently');
        await service.remove(env);
        assert.equal(service.environments.length, 1);
    } finally {
        service.dispose();
        // This is the exact temporary directory created above, with no user environments.
        assert.ok(containsPath(os.tmpdir(), root) && path.basename(root).startsWith('micromamba-vscode-test-'));
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('persists concurrent selections and chooses the deepest matching project without sibling leakage', async () => {
    let data: Record<string, string> = {};
    const memento = { get: () => ({ ...data }), update: async (_key: string, value: Record<string, string>) => {
        await new Promise((resolve) => setTimeout(resolve, 10)); data = value;
    } } as unknown as vscode.Memento;
    const store = new Selections(memento);
    const first = path.resolve('workspace', 'project');
    const second = path.resolve('workspace', 'other');
    const nested = path.join(first, 'nested');
    mock.workspace.workspaceFolders = [{ uri: Uri.file(first) }, { uri: Uri.file(second) }];
    const uri = (file: string) => Uri.file(file) as unknown as vscode.Uri;
    try {
        await Promise.all([store.set(uri(first), '/envs/one'), store.set(uri(second), '/envs/two')]);
        assert.equal(store.get(uri(path.join(first, 'app.py'))), '/envs/one');
        assert.equal(store.get(uri(path.join(second, 'app.py'))), '/envs/two');
        assert.equal(store.get(uri(first + '-sibling')), undefined);
        await store.set(uri(nested), '/envs/three');
        assert.equal(store.get(uri(path.join(nested, 'app.py'))), '/envs/three');
        await store.forget('/envs/three');
        assert.equal(store.get(uri(path.join(nested, 'app.py'))), undefined, 'Deleting an environment must not silently inherit a different project choice');
        await store.set(undefined, '/envs/window');
        assert.equal(store.get(uri(path.resolve('outside.py'))), undefined, 'An unrelated resource must not inherit a window choice');
    } finally { store.dispose(); }
});
