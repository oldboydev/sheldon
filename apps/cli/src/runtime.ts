import type { OfficialPlatform } from '@sheldon/plugin-host';

import type { OfficialCatalogClient } from './official-catalog.js';

export interface CommandContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly officialCatalogClient: OfficialCatalogClient;
  readonly platform: OfficialPlatform;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly commandAvailable: (command: string) => Promise<boolean>;
  write(message: string): void;
}
