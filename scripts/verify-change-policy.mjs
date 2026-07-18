import { execFileSync } from 'node:child_process';

import { evaluateChangePolicy } from './change-policy.mjs';

const status = execFileSync('git', ['-c', 'core.excludesFile=', 'status', '--porcelain=v1'], {
  encoding: 'utf8',
});
const paths = status
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.slice(3))
  .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1] : path));
const errors = evaluateChangePolicy(paths);

if (errors.length > 0) {
  throw new Error(errors.join('\n'));
}
