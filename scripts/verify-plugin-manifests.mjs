import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseContractFixture, parsePluginManifest } from '../packages/plugin-sdk/dist/index.js';

const manifestName = 'sheldon-plugin.json';
const contractName = 'sheldon-plugin.contract.json';
const roots = ['test-fixtures/plugins', 'plugins'];
let invalidFiles = 0;

for (const root of roots) {
  for (const manifestPath of await findManifests(root)) {
    await validateManifest(manifestPath);
    await validateAdjacentContract(manifestPath);
  }
}

if (invalidFiles > 0) process.exitCode = 1;

async function findManifests(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) paths.push(...(await findManifests(path)));
      if (entry.isFile() && entry.name === manifestName) paths.push(path);
    }
    return paths;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function validateManifest(path) {
  try {
    parsePluginManifest(JSON.parse(await readFile(path, 'utf8')), 'installed');
  } catch (error) {
    report(path, error);
  }
}

async function validateAdjacentContract(manifestPath) {
  const contractPath = join(manifestPath, '..', contractName);
  try {
    const source = await readFile(contractPath, 'utf8');
    parseContractFixture(JSON.parse(source));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    report(contractPath, error);
  }
}

function report(path, error) {
  invalidFiles += 1;
  const message = error instanceof Error ? error.message : 'invalid plugin file';
  process.stderr.write(`${path}: ${message}\n`);
}
