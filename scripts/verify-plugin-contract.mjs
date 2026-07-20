import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { runPluginContract } from '../packages/plugin-sdk/dist/index.js';

for (const fixture of ['node-sdk', 'powershell']) {
  const report = await runPluginContract(resolve('test-fixtures', 'plugins', fixture));
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  process.stdout.write(`${report.pluginId}: contract passed\n`);
}
