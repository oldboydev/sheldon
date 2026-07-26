export const PROTOCOL_VERSION = '1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type PluginOrigin = 'official' | 'installed';
export type PluginOperation = 'describe' | 'probe' | 'ingest' | 'healthcheck' | 'cancel';
export type ArtifactRole = 'original' | 'normalized' | 'asset' | 'inventory' | 'metadata';

export interface PluginCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface PluginDependency {
  readonly id: string;
  readonly kind: 'runtime' | 'executable' | 'asset';
  readonly required: boolean;
  readonly version?: string;
  readonly remediation: string;
}

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly license: string;
  readonly command: PluginCommand;
  readonly capabilities: readonly string[];
  readonly priority: number;
  readonly platforms: readonly NodeJS.Platform[];
  readonly permissions: { readonly network: boolean; readonly cookies: boolean };
  readonly dependencies: readonly PluginDependency[];
  readonly origin: PluginOrigin;
}

export type PluginDescription = Omit<PluginManifest, 'schemaVersion' | 'command' | 'origin'>;

export interface ProbeResult {
  readonly supported: boolean;
  readonly confidence: number;
  readonly reason: string;
}

export interface HealthcheckItem {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly remediation?: string;
}

export interface HealthcheckResult {
  readonly checks: readonly HealthcheckItem[];
}

export interface SourceArtifact {
  readonly id: string;
  readonly role: ArtifactRole;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface IngestRequest {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly temporaryDirectory: string;
}

type RequestBase = {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId: string;
};

export type RequestEnvelope =
  | (RequestBase & {
      readonly operation: 'describe';
      readonly payload: Readonly<Record<string, never>>;
    })
  | (RequestBase & {
      readonly operation: 'probe';
      readonly payload: { readonly input: Readonly<Record<string, JsonValue>> };
    })
  | (RequestBase & { readonly operation: 'ingest'; readonly payload: IngestRequest })
  | (RequestBase & {
      readonly operation: 'healthcheck';
      readonly payload: Readonly<Record<string, never>>;
    })
  | (RequestBase & {
      readonly operation: 'cancel';
      readonly payload: { readonly targetRequestId: string };
    });

export interface ProtocolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type ResponseEnvelope<TResult = JsonValue> =
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly requestId: string;
      readonly status: 'success';
      readonly result: TResult;
    }
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly requestId: string;
      readonly status: 'error';
      readonly error: ProtocolErrorBody;
    }
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly requestId: string;
      readonly status: 'cancelled';
      readonly error: ProtocolErrorBody;
    };

interface ContractFixtureBase {
  readonly supportedProbe: {
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly minimumConfidence: number;
  };
  readonly unsupportedProbe: { readonly input: Readonly<Record<string, JsonValue>> };
}

interface ContractSuccessfulIngest {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly expectedRoles: readonly ArtifactRole[];
}

interface ContractExpectedDiagnosticIngest {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly expectedDiagnosticCode: string;
}

interface ContractCancel {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly options: Readonly<Record<string, JsonValue>>;
}

export type ContractFixture = ContractFixtureBase &
  (
    | {
        readonly ingest: ContractSuccessfulIngest;
        readonly cancel: ContractCancel;
      }
    | {
        readonly ingest: ContractExpectedDiagnosticIngest;
        readonly cancel?: never;
      }
  );
