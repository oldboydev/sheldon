import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const fixturesRoot = 'test-fixtures';
const fixtures = await readdir(fixturesRoot, { withFileTypes: true });

for (const fixture of fixtures) {
  if (!fixture.isDirectory()) continue;

  const manifestPath = join(fixturesRoot, fixture.name, 'system', 'vault.yaml');
  const manifest = await readFile(manifestPath, 'utf8');

  if (!/^format:\s+sheldon-vault\/v1$/m.test(manifest)) {
    throw new Error(`${manifestPath}: expected format sheldon-vault/v1.`);
  }
}
