import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { activationCommand, containsPath, debugEnvironment, detectShell, environmentName, environmentPrefixes, packageRecords, packageSpecs, parseJson, samePath } from '../core';
import { runProcess } from '../process';

test('parses micromamba 1.x arrays and 2.9 package objects including pip origin', () => {
    const records = [{ name: 'numpy', version: '2.0', build_string: 'py312_0', channel: 'conda-forge' },
        { name: 'torch', version: '2.8', build_string: 'pypi_0', channel: 'pypi' }];
    assert.deepEqual(packageRecords(records), packageRecords({ packages: records, log_history: [] }));
    assert.equal(packageRecords(records)[1].isPip, true);
    assert.equal(packageRecords(records)[0].isPip, false);
    assert.throws(() => packageRecords({ error: 'not found' }));
});

test('accepts JSON with BOM or informational prefix, rejects malformed output', () => {
    assert.deepEqual(environmentPrefixes(parseJson('\uFEFF{"envs":["/root","/root","/root/envs/test"]}')), ['/root', '/root/envs/test']);
    assert.deepEqual(parseJson('Loading config\n{"envs":[]}'), { envs: [] });
    assert.throws(() => parseJson('not json'));
    assert.throws(() => environmentPrefixes({}));
});

test('validates environment names and prevents traversals and option injection', () => {
    assert.equal(environmentName('data-science_3.12'), 'data-science_3.12');
    for (const name of ['base', '..', '../escape', '-n', 'a/b', 'a\\b', 'a\n;rm']) { assert.throws(() => environmentName(name)); }
    assert.deepEqual(packageSpecs('numpy>=1.26,<3 conda-forge::scipy requests[socks]==2.32'), ['numpy>=1.26,<3', 'conda-forge::scipy', 'requests[socks]==2.32']);
    for (const spec of ['', '--prefix=/tmp/a', 'numpy;echo', '$(echo)', '"foo"']) { assert.throws(() => packageSpecs(spec)); }
});

test('resource ownership respects directory boundaries', () => {
    const root = path.resolve('workspace');
    assert.equal(containsPath(root, path.join(root, 'src', 'main.py')), true);
    assert.equal(containsPath(root, root + '-other'), false);
    assert.equal(samePath(path.join(root, 'a', '..'), root), true);
});

test('quotes activation paths for PowerShell, bash and CMD', () => {
    const ps = activationCommand('powershell', "C:\\Tools\\O'Brien\\micromamba.exe", 'C:\\Mamba Root', "C:\\Mamba Root\\envs\\O'Brien");
    assert.ok(ps.includes("'C:\\Tools\\O''Brien\\micromamba.exe'"));
    assert.ok(ps.includes('shell hook --shell powershell'));
    const bash = activationCommand('bash', '/opt/mamba tools/micromamba', '/opt/mamba', "/opt/mamba/envs/a'$(touch nope)");
    assert.ok(bash.includes(`'"'"'`));
    assert.ok(bash.includes('micromamba activate'));
    assert.ok(activationCommand('cmd.exe', 'C:\\Tools\\micromamba.exe', 'C:\\mamba', 'C:\\mamba\\envs\\test', 'C:\\Temp\\activate.bat').endsWith('call "C:\\Temp\\activate.bat"'));
    assert.throws(() => activationCommand('cmd.exe', 'C:\\%TOOLS%\\micromamba.exe', 'C:\\mamba', 'C:\\env', 'C:\\a.bat'));
    assert.throws(() => activationCommand('bash', '/bin/mamba', '/root', 'bad\ncommand'));
    assert.equal(detectShell('pwsh.exe'), 'powershell');
    assert.equal(detectShell('/usr/bin/zsh'), 'zsh');
    assert.equal(detectShell('nu.exe'), undefined);
});

test('process execution passes hostile shell strings as literal arguments', async () => {
    const args = ['space separated', '$(echo secret)', 'a;echo b', '"quoted"', '中文'];
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]);
    assert.deepEqual(JSON.parse(result), args);
});

test('process runner reports failures, cancels and enforces timeout', async () => {
    await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("fixture failure");process.exit(7)']), /fixture failure/);
    await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /timed out/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), /cancelled/);
});

test('preserves UTF-8 characters split across process output chunks', async () => {
    const result = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("中文路径"); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),30)']);
    assert.equal(result, '中文路径');
});

test('debug activation merges Windows keys without duplicates and preserves user overrides', () => {
    const activated = { PATH: 'env-path', USERPROFILE: 'same', CONDA_PREFIX: 'env', '=D:': 'hidden' };
    const inherited = { Path: 'base-path', USERPROFILE: 'same' };
    assert.deepEqual(debugEnvironment(activated, inherited, {}, true), { PATH: 'env-path', CONDA_PREFIX: 'env' });
    assert.deepEqual(debugEnvironment(activated, inherited, { Path: 'user-path', EXTRA: 'custom' }, true), { PATH: 'user-path', CONDA_PREFIX: 'env', EXTRA: 'custom' });
    assert.deepEqual(debugEnvironment({ PATH: 'env-path', Path: 'other' }, { PATH: 'base' }, {}, false), { PATH: 'env-path', Path: 'other' });
});
