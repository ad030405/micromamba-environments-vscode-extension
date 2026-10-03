import * as vscode from 'vscode';
import { containsPath, samePath } from './core';

const STATE_KEY = 'micromamba.selections';
const PROJECT_KEY = 'micromamba.projectSelections';
const WINDOW_KEY = '<window>';

export function containsUri(parent: vscode.Uri, child: vscode.Uri): boolean {
    if (parent.scheme !== child.scheme || parent.authority !== child.authority) { return false; }
    if (parent.scheme === 'file') { return containsPath(parent.fsPath, child.fsPath); }
    const base = parent.path.replace(/\/+$/, '');
    return child.path === base || child.path.startsWith(`${base}/`);
}

export function selectionKey(scope?: vscode.Uri): string {
    const key = scope?.toString() ?? WINDOW_KEY;
    return scope?.scheme === 'file' && process.platform === 'win32' ? key.toLowerCase() : key;
}

export class Selections implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private writes: Promise<void> = Promise.resolve();
    constructor(private readonly state: vscode.Memento, private readonly workspaceState?: vscode.Memento) {}

    private entries(): Record<string, string | null> { return { ...this.state.get<Record<string, string | null>>(PROJECT_KEY, {}) }; }

    /** Move old workspace records once, without reviving them after a later clear. */
    async migrate(): Promise<void> {
        if (!this.workspaceState) { return; }
        const old = this.workspaceState.get<Record<string, string>>(STATE_KEY, {});
        if (!Object.keys(old).some((key) => key !== WINDOW_KEY)) { return; }
        await this.write((entries) => {
            for (const [key, prefix] of Object.entries(old)) {
                if (key !== WINDOW_KEY) {
                    const target = selectionKey(vscode.Uri.parse(key));
                    if (!(target in entries)) { entries[target] = prefix; }
                }
            }
        });
        await this.workspaceState.update(STATE_KEY, old[WINDOW_KEY] ? { [WINDOW_KEY]: old[WINDOW_KEY] } : undefined);
    }

    scope(): vscode.Uri | undefined {
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
        return folder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    get(scope?: vscode.Uri): string | undefined {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (!folders.length) { return this.workspaceState?.get<Record<string, string>>(STATE_KEY, {})[WINDOW_KEY]; }
        const entries = this.entries();
        if (scope) {
            const key = Object.keys(entries).filter((key) => {
                const project = vscode.Uri.parse(key);
                return folders.some((folder) => containsUri(folder.uri, project)) && containsUri(project, scope);
            })
                .sort((a, b) => b.length - a.length)[0];
            if (key) { return entries[key] ?? undefined; }
        }
        // A resource-less choice is local to an empty window, never a folder default.
        return undefined;
    }

    async set(scope: vscode.Uri | vscode.Uri[] | undefined, prefix?: string): Promise<void> {
        const scopes = Array.isArray(scope) ? scope : [scope];
        if (scopes.every((uri) => !uri)) {
            if (vscode.workspace.workspaceFolders?.length || !this.workspaceState) { return; }
            await this.enqueue(async () => {
                await this.workspaceState!.update(STATE_KEY, prefix ? { [WINDOW_KEY]: prefix } : undefined);
                this.changed.fire();
            });
        } else {
            await this.write((entries) => {
                for (const uri of scopes) {
                    if (!uri) { continue; }
                    const key = selectionKey(uri);
                    // Keep a tombstone so an old workspace cannot migrate a cleared
                    // choice back into this project's private storage.
                    entries[key] = prefix ?? null;
                }
            });
        }
    }

    async forget(prefix: string): Promise<void> {
        if (!vscode.workspace.workspaceFolders?.length && samePath(this.get() ?? '', prefix)) { await this.set(undefined); }
        return this.write((entries) => {
            for (const [key, value] of Object.entries(entries)) { if (value && samePath(value, prefix)) { entries[key] = null; } }
        });
    }

    private async write(change: (entries: Record<string, string | null>) => void): Promise<void> {
        return this.enqueue(async () => {
            const entries = this.entries();
            change(entries);
            if (JSON.stringify(entries) !== JSON.stringify(this.entries())) {
                await this.state.update(PROJECT_KEY, entries);
                this.changed.fire();
            }
        });
    }

    private enqueue(write: () => Promise<void>): Promise<void> {
        const operation = this.writes.catch(() => undefined).then(write);
        this.writes = operation;
        return operation;
    }

    scopesFor(prefix: string): (vscode.Uri | undefined)[] {
        return this.saved().filter((saved) => samePath(saved.prefix, prefix)).map((saved) => saved.scope);
    }

    saved(): { scope?: vscode.Uri; prefix: string }[] {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (!folders.length) {
            const prefix = this.get();
            return prefix ? [{ prefix }] : [];
        }
        return Object.entries(this.entries()).filter((entry): entry is [string, string] => !!entry[1])
            .map(([key, prefix]) => ({ scope: vscode.Uri.parse(key), prefix }))
            .filter((saved) => folders.some((folder) => containsUri(folder.uri, saved.scope)));
    }

    dispose(): void { this.changed.dispose(); }
}
