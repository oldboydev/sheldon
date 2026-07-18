export interface PluginLimits {
  readonly timeouts: {
    readonly describe: number;
    readonly probe: number;
    readonly healthcheck: number;
    readonly ingest: number;
    readonly cancellationGrace: number;
  };
  readonly lineBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly artifactCount: number;
  readonly artifactBytes: number;
}

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = {
  timeouts: {
    describe: 10_000,
    probe: 10_000,
    healthcheck: 30_000,
    ingest: 15 * 60_000,
    cancellationGrace: 2_000,
  },
  lineBytes: 1024 * 1024,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  artifactCount: 10_000,
  artifactBytes: 2 * 1024 * 1024 * 1024,
};
