import { t } from './i18n';
import * as path from 'node:path';
import * as os from 'node:os';

export interface MambaEnvironment {
    name: string;
    prefix: string;
    rootPrefix: string;
    isBase: boolean;
    pythonPath?: string;
    version: string;
}

export interface MambaPackage {
    name: string;
    version: string;
    build: string;
    channel: string;
    isPip: boolean;
}

export function samePath(a: string, b: string): boolean {
    const normal = (value: string) => {
        const result = path.resolve(value);
        return process.platform === 'win32' ? result.toLowerCase() : result;
    };
    return normal(a) === normal(b);
}

export function containsPath(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function expandPath(value: string): string {
    return value.trim().replace(/^~(?=$|[\\/])/, os.homedir())
        .replace(/\$\{env:([^}]+)\}|%([^%]+)%/g, (_, first: string, second: string) => process.env[first || second] ?? '');
}

export function parseJson(text: string): unknown {
    // Some micromamba versions add informational lines before their JSON.
    const cleaned = text.replace(/^\uFEFF/, '').trim();
    try { return JSON.parse(cleaned); } catch {
        const offset = cleaned.search(/^[{\[]/m);
        if (offset >= 0) { return JSON.parse(cleaned.slice(offset)); }
        throw new Error(t("Micromamba did not return valid JSON. Check the output log."));
    }
}

export function environmentPrefixes(data: unknown): string[] {
    if (!data || typeof data !== 'object' || !Array.isArray((data as { envs?: unknown }).envs)) {
        throw new Error(t("Unable to read the envs field from micromamba env list."));
    }
    return [...new Set(((data as { envs: unknown[] }).envs).filter((item): item is string => typeof item === 'string'))];
}

export function packageRecords(data: unknown): MambaPackage[] {
    const rows = Array.isArray(data) ? data : (data as { packages?: unknown[] } | null)?.packages;
    if (!Array.isArray(rows)) { throw new Error(t("Unable to read the package list from micromamba list.")); }
    return rows.filter((row) => row && typeof row.name === 'string').map((row) => ({
        name: row.name,
        version: String(row.version ?? ''),
        build: String(row.build_string ?? row.build ?? ''),
        channel: String(row.channel ?? ''),
        isPip: row.channel === 'pypi' || row.build_string === 'pypi_0' || row.build === 'pypi_0',
    })).sort((a, b) => a.name.localeCompare(b.name));
}

export function packageSpecs(value: string): string[] {
    const specs = value.trim().split(/\s+/).filter(Boolean);
    if (!specs.length) { throw new Error(t("Enter at least one package.")); }
    for (const spec of specs) {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:/+><=!*,|\[\]-]*$/.test(spec)) {
            throw new Error(t("Invalid package specification: {0}. For example, numpy pandas>=2 or conda-forge::scipy.", spec));
        }
    }
    return specs;
}

export function environmentName(value: string): string {
    const name = value.trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name) || ['base', '.', '..'].includes(name.toLowerCase())) {
        throw new Error(t("Environment names may contain only letters, digits, dots, underscores, and hyphens, and cannot be base."));
    }
    return name;
}

export function debugEnvironment(activated: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv,
    overrides: Record<string, string | null | undefined> = {}, windows = process.platform === 'win32'): Record<string, string | null | undefined> {
    const key = (name: string) => windows ? name.toUpperCase() : name;
    const base = new Map(Object.entries(inherited).map(([name, value]) => [key(name), value]));
    const result: Record<string, string | null | undefined> = {};
    for (const [name, value] of Object.entries(activated)) {
        if (name && !name.includes('=') && value !== base.get(key(name))) { result[key(name)] = value; }
    }
    // Windows environment keys are case insensitive; debugpy rejects duplicate Path/PATH.
    for (const [name, value] of Object.entries(overrides)) { result[key(name)] = value; }
    return result;
}

export type Shell = 'powershell' | 'bash' | 'zsh' | 'fish' | 'cmd.exe';

export function detectShell(executable: string): Shell | undefined {
    const name = path.basename(executable).toLowerCase().replace(/\.exe$/, '');
    if (name === 'pwsh' || name === 'powershell' || name.includes('powershell')) { return 'powershell'; }
    if (name === 'cmd') { return 'cmd.exe'; }
    if (name === 'bash' || name === 'gitbash' || name.includes('git bash')) { return 'bash'; }
    if (name === 'zsh') { return 'zsh'; }
    if (name === 'fish') { return 'fish'; }
    return undefined;
}

export function quotePosix(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
export function quotePowerShell(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export function activationCommand(shell: Shell, executable: string, root: string, prefix: string, batch?: string): string {
    for (const value of [executable, root, prefix, batch ?? '']) {
        if (/[\r\n\0]/.test(value)) { throw new Error(t("The path contains control characters that are not supported by the terminal.")); }
    }
    if (shell === 'powershell') {
        const q = quotePowerShell;
        return `$env:MAMBA_EXE = ${q(executable)}; $env:MAMBA_ROOT_PREFIX = ${q(root)}; (& ${q(executable)} shell hook --shell powershell --root-prefix ${q(root)} | Out-String) | Invoke-Expression; micromamba activate ${q(prefix)}`;
    }
    if (shell === 'cmd.exe') {
        if (!batch || /[%"\r\n]/.test(executable + root + batch)) { throw new Error(t("CMD activation requires a valid batch file path. Use PowerShell for paths containing % or double quotes.")); }
        return `set "MAMBA_EXE=${executable}" && set "MAMBA_ROOT_PREFIX=${root}" && call "${batch}"`;
    }
    const q = quotePosix;
    if (shell === 'fish') {
        return `set -gx MAMBA_EXE ${q(executable)}; set -gx MAMBA_ROOT_PREFIX ${q(root)}; ${q(executable)} shell hook --shell fish --root-prefix ${q(root)} | source; micromamba activate ${q(prefix)}`;
    }
    return `export MAMBA_EXE=${q(executable)} MAMBA_ROOT_PREFIX=${q(root)}; eval "$(${q(executable)} shell hook --shell ${shell} --root-prefix ${q(root)})" && micromamba activate ${q(prefix)}`;
}
