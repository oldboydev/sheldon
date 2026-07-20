export interface CommandContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly officialPluginRoots: readonly string[];
  readonly confirm: (message: string) => Promise<boolean>;
  readonly commandAvailable: (command: string) => Promise<boolean>;
  write(message: string): void;
}
