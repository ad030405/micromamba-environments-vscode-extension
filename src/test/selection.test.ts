import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { Selections as Store } from '../selection';

class Emitter<T> {
    event = (_callback: (value: T) => void) => ({ dispose() {} });
    fire(_value: T): void {}
    dispose(): void {}
}
class Uri {
    constructor(readonly fsPath: string, readonly scheme = 'file', readonly authority = '') {}
    get path(): string { return this.fsPath.replace(/\\/g, '/'); }
    static file(file: string): Uri { return new Uri(path.resolve(file)); }
    static parse(value: string): Uri {
        const match = /^(.*?):\/\/(.*?)\/(.*)$/.exec(value)!;
        return new Uri(match[1] === 'file' ? match[3] : '/' + match[3], match[1], match[2]);
    }
    toString(): string { return `${this.scheme}://${this.authority}/${this.scheme === 'file' ? this.fsPath : this.fsPath.slice(1)}`; }
}
let folders: { uri: Uri }[] = [];
const mock = { EventEmitter: Emitter, Uri, workspace: { get workspaceFolders() { return folders; } }, window: {} };
const moduleLoader = require('node:module') as { _load: (request: string, ...args: unknown[]) => unknown };
const original = moduleLoader._load;
moduleLoader._load = function (request: string, ...args: unknown[]) { return request === 'vscode' ? mock : original.apply(this, [request, ...args]); };
const Selections = (require('../selection') as { Selections: typeof Store }).Selections;
moduleLoader._load = original;
function memento(data: Record<string, unknown> = {}): vscode.Memento {
    return { keys: () => Object.keys(data), get: (key: string, fallback: unknown) => data[key] ?? fallback,
        update: async (key: string, value: unknown) => { data[key] = value; } } as unknown as vscode.Memento;
}
const uri = (value: Uri) => value as vscode.Uri;

test('project choice survives a new workspace identity, and clearing it does not revive migrated state', async () => {
    const project = Uri.file('selection-fixture/project');
    folders = [{ uri: project }];
    const global = memento();
    const old = memento({ 'micromamba.selections': { [project.toString()]: 'old-env' } });
    const store = new Selections(global, old);
    await store.migrate();
    assert.equal(store.get(uri(project)), 'old-env');
    assert.equal(old.get('micromamba.selections'), undefined, 'Migration must be consumed once');
    await store.set(uri(project), 'new-env');
    const reopened = new Selections(global, memento());
    assert.equal(reopened.get(uri(project)), 'new-env', 'A different workspace uses the same project record');
    await reopened.set(uri(project));
    await store.migrate();
    assert.equal(store.get(uri(project)), undefined, 'A user clear must survive reopening the original workspace');
    const staleWorkspace = new Selections(global, memento({ 'micromamba.selections': { [project.toString()]: 'stale-env' } }));
    await staleWorkspace.migrate();
    assert.equal(staleWorkspace.get(uri(project)), undefined, 'A second old workspace cannot revive the cleared choice');
    staleWorkspace.dispose();
    store.dispose(); reopened.dispose();
});

test('unscoped and other-project choices never become defaults in an untouched workspace', async () => {
    const first = Uri.file('selection-fixture/a');
    const second = Uri.file('selection-fixture/b');
    folders = [];
    const global = memento();
    const store = new Selections(global, memento());
    await store.set(undefined, 'empty-window-env');
    assert.equal(store.get(), 'empty-window-env');
    assert.equal(store.get(uri(Uri.file('standalone.py'))), 'empty-window-env', 'A file in an empty window uses its window choice');
    folders = [{ uri: first }];
    assert.equal(store.get(), undefined);
    assert.equal(store.get(uri(first)), undefined);
    await store.set(uri(first), 'a-env');
    await store.set(undefined, 'accidental-global-env');
    assert.equal(store.get(uri(first)), 'a-env');
    folders = [{ uri: second }];
    assert.equal(store.get(uri(second)), undefined);
    assert.equal(store.get(uri(first)), undefined, 'A file from a closed project must not use its saved record in a different workspace');
    assert.deepEqual(store.saved(), [], 'Restoration must not bind projects outside this workspace');
    folders = [{ uri: first }, { uri: second }];
    await store.set(uri(second), 'b-env');
    assert.equal(store.get(uri(Uri.file('selection-fixture/a/main.py'))), 'a-env');
    assert.equal(store.get(uri(Uri.file('selection-fixture/b/main.py'))), 'b-env');
    assert.equal(store.saved().length, 2);
    store.dispose();
});

test('remote authorities, URI schemes and path boundaries keep project selections separate', async () => {
    const first = new Uri('/home/user/project', 'vscode-remote', 'ssh-remote+first');
    const second = new Uri('/home/user/project', 'vscode-remote', 'ssh-remote+second');
    folders = [{ uri: first }, { uri: second }];
    const store = new Selections(memento());
    await store.set(uri(first), 'first-env');
    await store.set(uri(second), 'second-env');
    assert.equal(store.get(uri(new Uri('/home/user/project/main.py', first.scheme, first.authority))), 'first-env');
    assert.equal(store.get(uri(new Uri('/home/user/project/main.py', second.scheme, second.authority))), 'second-env');
    assert.equal(store.get(uri(new Uri('/home/user/projects/main.py', first.scheme, first.authority))), undefined);
    assert.equal(store.get(uri(new Uri('/home/user/project/main.py', 'file'))), undefined);
    folders = [{ uri: first }];
    assert.equal(store.saved().length, 1);
    store.dispose();
});
