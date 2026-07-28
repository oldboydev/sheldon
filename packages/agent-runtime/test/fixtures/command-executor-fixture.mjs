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
  const answer = {
    schemaVersion: 1,
    id: 'answer-001',
    question: 'What does the wiki say?',
    agent: 'codex',
    concepts: [{ path: 'wiki/concepts/example.md', citation: 'Example' }],
    raws: [{ path: 'raw/source-001/content.md', citation: 'Lines 1-3' }],
    createdAt: '2026-07-28T12:00:00.000Z',
    text: '## Wiki facts\n- Example\n\n## Inferences\n- None\n\n## Gaps\n- None',
  };
  const output = schema?.$id === 'sheldon-query-answer/v1' ? answer : proposal;
  if (lastMessageFlag >= 0) {
    await writeFile(args[lastMessageFlag + 1], JSON.stringify(output), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'result', structured_output: output }));
  }
}
