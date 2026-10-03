import { t } from './i18n';
import * as vscode from 'vscode';
import { MambaEnvironment, MambaPackage, samePath } from './core';
import { Micromamba } from './micromamba';
import { Selections } from './selection';

export type TreeNode = { kind: 'environment'; env: MambaEnvironment }
    | { kind: 'package'; env: MambaEnvironment; pkg: MambaPackage }
    | { kind: 'message'; text: string };

export class EnvironmentTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly cache = new Map<string, Promise<MambaPackage[]>>();
    private readonly subscriptions: vscode.Disposable[];
    constructor(private readonly service: Micromamba, private readonly selections: Selections) {
        this.subscriptions = [service.onDidChange(() => this.refresh()), selections.onDidChange(() => this.changed.fire(undefined)),
            vscode.window.onDidChangeActiveTextEditor(() => this.changed.fire(undefined))];
    }
    refresh(): void { this.cache.clear(); this.changed.fire(undefined); }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (!node) { return this.service.environments.map((env) => ({ kind: 'environment', env })); }
        if (node.kind !== 'environment') { return []; }
        try {
            let packages = this.cache.get(node.env.prefix);
            if (!packages) { packages = this.service.packages(node.env); this.cache.set(node.env.prefix, packages); }
            const records = await packages;
            return records.length ? records.map((pkg) => ({ kind: 'package', env: node.env, pkg })) : [{ kind: 'message', text: t("No packages installed") }];
        } catch (error) {
            this.cache.delete(node.env.prefix);
            this.service.log.error(String(error));
            return [{ kind: 'message', text: t("Unable to read packages. Check the log, then refresh to try again.") }];
        }
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'message') { return new vscode.TreeItem(node.text); }
        if (node.kind === 'package') {
            const item = new vscode.TreeItem(node.pkg.name);
            item.id = `package:${node.env.prefix}:${node.pkg.name}`;
            item.description = `${node.pkg.version}${node.pkg.isPip ? ' · pip' : ''}`;
            item.tooltip = `${node.pkg.name} ${node.pkg.version}\n${node.pkg.channel}\n${node.pkg.build}`;
            item.iconPath = new vscode.ThemeIcon('package'); item.contextValue = 'micromambaPackage';
            return item;
        }
        const prefix = this.selections.get(this.selections.scope());
        const active = !!prefix && samePath(prefix, node.env.prefix);
        const item = new vscode.TreeItem(node.env.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `env:${node.env.prefix}`;
        item.description = [active ? t("✓ Selected") : '', node.env.pythonPath ? `Python ${node.env.version || '?'}` : t("No Python")].filter(Boolean).join(' · ');
        item.tooltip = `${node.env.prefix}\n${node.env.pythonPath ?? t("No Python installed. Right-click to install the python package.")}`;
        item.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : 'server-environment');
        item.contextValue = ['micromambaEnvironment', node.env.pythonPath ? 'micromambaPython' : '', !node.env.isBase ? 'micromambaRemovable' : ''].join('.');
        if (node.env.pythonPath) { item.command = { command: 'micromamba.select', title: t("Select Environment"), arguments: [node] }; }
        return item;
    }
    dispose(): void { this.subscriptions.forEach((item) => item.dispose()); this.changed.dispose(); }
}
