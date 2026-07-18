import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('SWC build', () => {
  it('emits JavaScript for every workspace and a runnable CLI', async () => {
    const build = await execFileAsync(process.execPath, ['scripts/build.mjs']);

    expect(build.stderr).toBe('');
    await expect(access('packages/core/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/vault/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/persistence/dist/index.js')).resolves.toBeUndefined();
    await expect(access('apps/cli/dist/sheldon.js')).resolves.toBeUndefined();

    const corePackage = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
    expect(corePackage.exports['.']).toBe('./dist/index.js');

    const cli = await execFileAsync(process.execPath, ['apps/cli/dist/sheldon.js', '--help']);
    expect(cli.stdout).toContain('Local-first personal knowledge vault.');
  });
});
