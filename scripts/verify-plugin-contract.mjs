import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { runPluginContract } from '../packages/plugin-sdk/dist/index.js';

const pluginRoots = [
  resolve('test-fixtures', 'plugins', 'node-sdk'),
  resolve('packages', 'plugins', 'official', 'source.file'),
  resolve('packages', 'plugins', 'official', 'source.repository'),
  resolve('packages', 'plugins', 'official', 'source.url'),
  resolve('packages', 'plugins', 'official', 'source.youtube'),
  resolve('packages', 'plugins', 'official', 'source.instagram'),
  resolve('packages', 'plugins', 'official', 'source.linkedin'),
];

if (process.platform === 'win32') {
  pluginRoots.splice(1, 0, resolve('test-fixtures', 'plugins', 'powershell'));
}

for (const pluginRoot of pluginRoots) {
  const report = await runPluginContract(pluginRoot);
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  process.stdout.write(`${report.pluginId}: contract passed\n`);
}
