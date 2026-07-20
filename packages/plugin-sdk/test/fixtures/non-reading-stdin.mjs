import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
process.stdin.pause();
setInterval(() => undefined, 1_000);
