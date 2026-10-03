import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { Micromamba } from '../micromamba';
import type { PythonBridge } from '../pythonBridge';
import type { Selections } from '../selection';
import type { Terminals as Manager } from '../terminals';
import { MambaEnvironment } from '../core';

class Emitter<T> {
    private callbacks = new Set<(value: T) => void>();
    event = (callback: (value: T) => void) => { this.callbacks.add(callback); return { dispose: () => this.callbacks.delete(callback) }; };
    fire(value: T): void { for (const callback of this.callbacks) { callback(value); } }
}
class Collection {
    readonly values = new Map<string, string>();
    persistent = true;
    description?: string;
    clear(): void { this.values.clear(); }
    replace(name: string, value: string): void { this.values.set(name, value); }
    readonly scopes = new Map<string, Collection>();
    getScoped(scope: { workspaceFolder: vscode.WorkspaceFolder }): Collection {
        const key = scope.workspaceFolder.uri.toString();
        if (!this.scopes.has(key)) { this.scopes.set(key, new Collection()); }
        return this.scopes.get(key)!;
    }
}
const uri = (name: string) => ({ fsPath: path.resolve(name), toString: () => `fixture:${name}` });
const folders = [{ uri: uri('folder-a') }, { uri: uri('folder-b') }];
const opened = new Emitter<unknown>();
const noop = () => ({ dispose() {} });
let enabled = true;
let createdOptions: vscode.TerminalOptions | undefined;
let sends = 0;
const mock = {
    workspace: { workspaceFolders: folders, getWorkspaceFolder: (resource: { fsPath: string }) => folders.find((folder) => folder.uri.fsPath === resource.fsPath),
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'autoActivateTerminal' ? enabled : fallback }),
        onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop },
    window: { onDidOpenTerminal: opened.event, onDidStartTerminalShellExecution: noop,
        createTerminal: (options: vscode.TerminalOptions) => {
            createdOptions = options;
            const terminal = { creationOptions: options, name: options.name, show() {}, sendText() { sends++; } };
            opened.fire(terminal); return terminal;
        } },
};
const moduleLoader = require('node:module') as { _load: (request: string, ...args: unknown[]) => unknown };
const original = moduleLoader._load;
moduleLoader._load = function (request: string, ...args: unknown[]) { return request === 'vscode' ? mock : original.apply(this, [request, ...args]); };
const Terminals = (require('../terminals') as { Terminals: typeof Manager }).Terminals;
moduleLoader._load = original;

test('silent terminal variables are scoped, reject stale preparations, clear on disable, and never type activation', async () => {
    const first = { name: 'a', prefix: path.resolve('env-a'), rootPrefix: path.resolve('mamba'), pythonPath: path.resolve('env-a/python'), version: '3.12', isBase: false };
    const second = { ...first, name: 'b', prefix: path.resolve('env-b'), pythonPath: path.resolve('env-b/python') };
    let release: (() => void) | undefined;
    let slow = false;
    const service = { onDidChange: noop, log: { warn() {} }, executablePath: async () => path.resolve('mamba/micromamba'),
        activatedEnv: async (env: MambaEnvironment) => {
            if (slow && env === first) { await new Promise<void>((resolve) => { release = resolve; }); }
            return { ...process.env, PATH: `${env.prefix}${path.delimiter}${process.env.PATH ?? ''}`, CONDA_PREFIX: env.prefix, CONDA_SHLVL: '1' };
        } } as unknown as Micromamba;
    const bridge = { activeFor: (resource: { fsPath: string }) => resource.fsPath === folders[0].uri.fsPath ? first : second } as unknown as PythonBridge;
    const selections = { onDidChange: noop, saved: () => [] } as unknown as Selections;
    const collection = new Collection();
    const terminals = new Terminals(service, bridge, selections, collection as unknown as vscode.GlobalEnvironmentVariableCollection);
    try {
        await terminals.refresh();
        const a = collection.getScoped({ workspaceFolder: folders[0] as vscode.WorkspaceFolder });
        const b = collection.getScoped({ workspaceFolder: folders[1] as vscode.WorkspaceFolder });
        assert.equal(a.values.get('CONDA_PREFIX'), first.prefix);
        assert.equal(b.values.get('CONDA_PREFIX'), second.prefix);
        assert.equal(collection.values.size, 0, 'Workspace choices must not leak into global terminals');
        assert.ok(a.values.get('PATH')?.includes(first.prefix));
        slow = true;
        const old = bridge.prepareSelection!(folders[0].uri as vscode.Uri, first);
        await new Promise((resolve) => setImmediate(resolve));
        await bridge.prepareSelection!(folders[0].uri as vscode.Uri, second);
        release!(); await old;
        assert.equal(a.values.get('CONDA_PREFIX'), second.prefix, 'A slow old activation cannot overwrite a newer selection');
        slow = false;
        await terminals.refresh();
        assert.equal(a.values.get('CONDA_PREFIX'), first.prefix);
        await terminals.open(second, folders[0].uri as vscode.Uri);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(createdOptions?.env?.CONDA_PREFIX, second.prefix);
        assert.equal(createdOptions?.strictEnv, true, 'The explicit environment must bypass the different project collection');
        assert.equal(sends, 0, 'Silent terminals must not send activation or clearing commands');
        enabled = false;
        await terminals.refresh();
        assert.equal(a.values.size, 0);
        assert.equal(b.values.size, 0);
    } finally { terminals.dispose(); enabled = true; }
});
