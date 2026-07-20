import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? '';
if (prompt.includes('invalid-json')) {
  process.stdout.write('not-json');
} else {
  const schemaFlag = args.indexOf('--output-schema');
  const lastMessageFlag = args.indexOf('--output-last-message');
  const schema =
    schemaFlag >= 0 ? JSON.parse(await readFile(args[schemaFlag + 1], 'utf8')) : undefined;
  const proposal = {
    schemaVersion: 1,
    id: 'proposal-001',
    sources: [{ rawPath: 'raw/source-001/content.md', citation: 'Lines 1-3' }],
    files: [
      {
        path: 'wiki/concepts/example.md',
        operation: 'create',
        content:
          schema?.$id === 'sheldon-proposal/v1'
            ? (process.env.SHELDON_AGENT_RUNTIME_SECRET ?? 'schema-file-used')
            : 'invalid-schema-file',
        citations: ['raw/source-001/content.md'],
      },
    ],
  };
  if (lastMessageFlag >= 0) {
    await writeFile(args[lastMessageFlag + 1], JSON.stringify(proposal), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'result', structured_output: proposal }));
  }
}
