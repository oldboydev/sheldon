import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const promptFile = args.indexOf('--prompt-file');
const schemaFlag = args.indexOf('--json-schema');
const sandbox = args.indexOf('--sandbox');

if (promptFile < 0 || schemaFlag < 0 || args[sandbox + 1] !== 'read-only') {
  process.exit(2);
}
if (args.includes('--')) process.exit(3);
if (process.env.SECRET_TOKEN) process.exit(4);

const prompt = await readFile(args[promptFile + 1], 'utf8');
const schema = JSON.parse(args[schemaFlag + 1]);
const proposal = {
  schemaVersion: 1,
  id: 'proposal-001',
  sources: [{ rawPath: 'raw/source-001/content.md', citation: 'Lines 1-3' }],
  files: [
    {
      path: 'wiki/concepts/example.md',
      operation: 'create',
      content: [
        process.env.XAI_API_KEY ? 'xai-forwarded' : 'xai-missing',
        process.env.USERPROFILE || process.env.HOME ? 'home-forwarded' : 'home-missing',
        prompt.includes('Turn the cited raw') ? 'prompt-file-used' : 'prompt-missing',
        schema.$id === 'sheldon-proposal/v1' ? 'schema-inline-used' : 'schema-missing',
      ].join('\n'),
      citations: ['raw/source-001/content.md'],
    },
  ],
};
const envelope = {
  text: JSON.stringify(proposal),
  stopReason: 'end_turn',
  structuredOutput: proposal,
};
if (prompt.includes('missing-payload')) {
  process.stdout.write(JSON.stringify({ text: 'not-json', stopReason: 'end_turn' }));
} else {
  process.stdout.write(JSON.stringify(envelope));
}
