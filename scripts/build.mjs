import { rm } from 'node:fs/promises';

import { build } from 'esbuild';

const outputDirectory = 'apps/cli/dist';
await rm(outputDirectory, { recursive: true, force: true });

await build({
  entryPoints: ['apps/cli/src/sheldon.ts'],
  outfile: `${outputDirectory}/sheldon.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['commander', 'yaml'],
  legalComments: 'none',
  logLevel: 'info',
  plugins: [
    {
      name: 'preserve-node-protocol',
      setup(builder) {
        builder.onResolve({ filter: /^node:/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
});
