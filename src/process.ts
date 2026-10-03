import { t } from './i18n';
import { spawn } from 'node:child_process';

export interface RunOptions {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
}

export class ProcessError extends Error {
    constructor(message: string, readonly code?: number | null) { super(message); }
}

export function runProcess(executable: string, args: string[], options: RunOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) { reject(new ProcessError(t("Operation cancelled."))); return; }
        const child = spawn(executable, args, { shell: false, windowsHide: true, env: options.env ?? process.env });
        let stdout = '';
        let stderr = '';
        let failure: Error | undefined;
        let timer: NodeJS.Timeout | undefined;
        const stop = (reason: string) => {
            failure = new ProcessError(reason);
            if (process.platform === 'win32' && child.pid) {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
                killer.on('error', () => child.kill());
                killer.on('exit', (code) => { if (code !== 0) { child.kill(); } });
            } else { child.kill('SIGTERM'); }
        };
        const cancel = () => stop(t("Operation cancelled. Changes already made by micromamba may remain; refresh to check."));
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.timeout) { timer = setTimeout(() => stop(t("The micromamba command timed out.")), options.timeout); }
        const receive = (value: string, error: boolean) => {
            if (error) { stderr += value; } else { stdout += value; }
            options.onOutput?.(value);
            if (stdout.length + stderr.length > 32 * 1024 * 1024 && !failure) { stop(t("Micromamba output exceeded 32 MB.")); }
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (data: string) => receive(data, false));
        child.stderr.on('data', (data: string) => receive(data, true));
        const cleanup = () => {
            if (timer) { clearTimeout(timer); }
            options.signal?.removeEventListener('abort', cancel);
        };
        child.on('error', (error) => { cleanup(); reject(new ProcessError(t("Unable to start {0}: {1}", executable, error.message))); });
        child.on('close', (code) => {
            cleanup();
            if (failure) { reject(failure); }
            else if (code !== 0) { reject(new ProcessError((stderr || stdout || t("Command exited with code {0}", code)).trim().slice(-3000), code)); }
            else { resolve(stdout); }
        });
    });
}
