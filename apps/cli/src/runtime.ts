import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
export const bundledOfficialPluginRoot = fileURLToPath(
  new URL(
    basename(runtimeDirectory) === 'src'
      ? '../../../packages/plugins/official/'
      : './plugins/official/',
    import.meta.url,
  ),
);

export interface CommandContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly officialPluginRoots: readonly string[];
  readonly confirm: (message: string) => Promise<boolean>;
  readonly commandAvailable: (command: string) => Promise<boolean>;
  write(message: string): void;
}
