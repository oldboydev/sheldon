import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { runPluginContract } from '../packages/plugin-sdk/dist/index.js';

for (const pluginRoot of [
  resolve('test-fixtures', 'plugins', 'node-sdk'),
  resolve('test-fixtures', 'plugins', 'powershell'),
  resolve('packages', 'plugins', 'official', 'source.file'),
]) {
  const report = await runPluginContract(pluginRoot);
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  process.stdout.write(`${report.pluginId}: contract passed\n`);
}
