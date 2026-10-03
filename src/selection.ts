import * as vscode from 'vscode';
import { containsPath, samePath } from './core';

const STATE_KEY = 'micromamba.selections';
const WINDOW_KEY = '<window>';

export class Selections implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private writes: Promise<void> = Promise.resolve();
    constructor(private readonly state: vscode.Memento) {}

    private entries(): Record<string, string> { return { ...this.state.get<Record<string, string>>(STATE_KEY, {}) }; }

    scope(): vscode.Uri | undefined {
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
        return folder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    get(scope?: vscode.Uri): string | undefined {
        const entries = this.entries();
        if (scope) {
            const key = Object.keys(entries).filter((key) => key !== WINDOW_KEY && containsPath(vscode.Uri.parse(key).fsPath, scope.fsPath))
                .sort((a, b) => b.length - a.length)[0];
            if (key) { return entries[key]; }
        }
        return entries[WINDOW_KEY];
    }

    async set(scope: vscode.Uri | vscode.Uri[] | undefined, prefix?: string): Promise<void> {
        return this.write((entries) => {
            for (const uri of Array.isArray(scope) ? scope : [scope]) {
                const key = uri?.toString() ?? WINDOW_KEY;
                if (prefix) { entries[key] = prefix; } else { delete entries[key]; }
            }
        });
    }

    async forget(prefix: string): Promise<void> {
        return this.write((entries) => {
            for (const [key, value] of Object.entries(entries)) { if (samePath(value, prefix)) { delete entries[key]; } }
        });
    }

    private async write(change: (entries: Record<string, string>) => void): Promise<void> {
        const operation = this.writes.catch(() => undefined).then(async () => {
            const entries = this.entries();
            change(entries);
            await this.state.update(STATE_KEY, entries);
            this.changed.fire();
        });
        this.writes = operation;
        return operation;
    }

    scopesFor(prefix: string): (vscode.Uri | undefined)[] {
        return Object.entries(this.entries()).filter(([, value]) => samePath(value, prefix))
            .map(([key]) => key === WINDOW_KEY ? undefined : vscode.Uri.parse(key));
    }

    saved(): { scope?: vscode.Uri; prefix: string }[] {
        return Object.entries(this.entries()).map(([key, prefix]) => ({ scope: key === WINDOW_KEY ? undefined : vscode.Uri.parse(key), prefix }));
    }

    dispose(): void { this.changed.dispose(); }
}
