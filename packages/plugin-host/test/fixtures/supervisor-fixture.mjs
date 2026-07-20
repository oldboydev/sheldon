import { writeFileSync } from 'node:fs';

const markerPath = process.argv[2];
if (markerPath !== undefined) writeFileSync(markerPath, 'started\n', 'utf8');

process.stderr.write('fixture-stderr\n');
process.stdin.pipe(process.stdout);
