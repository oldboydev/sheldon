# Plugin platform design

## Decision

Sheldon will implement milestone M1 as a schema-first, process-isolated plugin
platform. `packages/plugin-sdk` is the public authoring kit and protocol source
of truth. `packages/plugin-host` owns discovery, installation, selection,
execution, cancellation, diagnostics, and operational state.

Every operation runs in a fresh process. Plugins communicate through JSONL on
stdin/stdout, write human-readable logs to stderr, and place large results in a
unique temporary directory. Plugins never receive a writable vault path.

## Scope

- Define and validate a versioned plugin manifest.
- Define protocol v1 as JSON Schemas with matching TypeScript types.
- Provide TypeScript helpers for implementing and running plugins.
- Discover official and locally installed plugins without hiding invalid ones.
- Install a local plugin by copying it into the Sheldon application-data root.
- Remove only plugins recorded in Sheldon's registry.
- Select plugins through `probe` confidence and declared priority.
- Run `describe`, `probe`, `ingest`, `healthcheck`, and cooperative `cancel`.
- Enforce temporary-directory, timeout, cancellation, output, and artifact
  limits.
- Persist the last healthcheck result for fast plugin listings.
- Provide a reusable contract suite and a CLI contract-test command.
- Expose plugin list, install, remove, doctor, and test commands.

## Package boundaries

### `packages/plugin-sdk`

The SDK is for plugin authors. It contains no host discovery, installation, or
vault logic. It exports:

- protocol v1 JSON Schemas and TypeScript types;
- manifest, request, response, diagnostic, and artifact validators;
- `definePlugin(...)` for TypeScript implementations;
- `runPlugin(...)`, which reads JSONL from stdin, writes only protocol envelopes
  to stdout, and directs logs to stderr;
- a process-based contract harness usable from Vitest;
- stable error codes and protocol constants.

TypeScript plugins can depend on the SDK directly. Plugins written in Python,
Go, PowerShell, or another language implement the published schemas and can run
the same process-based contract suite without importing TypeScript.

### `packages/plugin-host`

The host is private Sheldon infrastructure. It contains focused components:

- `ManifestService`: parses and validates manifests and compatibility.
- `PluginRegistry`: stages, installs, records, and safely removes local plugins.
- `PluginDiscovery`: combines official roots and the local registry while
  preserving invalid and incompatible entries for diagnostics.
- `PluginHealthStore`: atomically persists the last doctor result and timestamp.
- `PluginSelector`: probes candidates and returns either one selection or an
  explicit ambiguity.
- `PluginProcessRunner`: owns process lifecycle, JSONL framing, limits,
  cancellation, logging, and temporary-directory cleanup.
- `ArtifactValidator`: validates returned files before exposing a successful
  result to callers.

The CLI depends on `plugin-host`. Future ingestion packages may call the same
host APIs but may not bypass their validation or lifecycle rules.
`packages/persistence` provides the SQLite-backed health and execution-record
store so process history follows the repository's existing operational-state
boundary.

## Manifest

Each plugin has `sheldon-plugin.json` at its root. Protocol v1 requires:

- `schemaVersion`: manifest schema version `1`;
- `id`: stable lowercase identifier containing letters, numbers, dots, and
  hyphens;
- `name`: display name;
- `version`: semantic version;
- `protocolVersion`: `1`;
- `license`: SPDX identifier or expression;
- `command`: executable plus an array of separate arguments, never a shell
  command string;
- `capabilities`: declared input/capability identifiers;
- `priority`: integer used only after probe confidence;
- `platforms`: supported Node platform identifiers;
- `permissions`: explicit `network` and `cookies` booleans;
- `dependencies`: declared runtimes, executables, or local assets with an
  actionable installation hint.

Origin is assigned by the host and cannot be self-declared. An official plugin
must use an allowed distribution license. The initial allowlist is
`Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MIT`, and `MPL-2.0`.
Installed user plugins still require a syntactically valid SPDX license, but do
not need to be on the official allowlist.

Relative executables must resolve inside the installed plugin root. Bare
executable names such as `node` or `python` are resolved from the sanitized
process environment. The host starts commands with `shell: false`.

## Protocol v1

Each non-empty stdout line is exactly one UTF-8 JSON envelope. Requests contain
`protocolVersion`, `requestId`, `operation`, and `payload`. Responses contain
the same protocol version and request ID plus a terminal `success`, `error`, or
`cancelled` status. Errors contain a stable code, safe message, and optional
structured details.

A process handles one primary operation: `describe`, `probe`, `ingest`, or
`healthcheck`. While that operation is running, the host may send one `cancel`
request whose payload names the primary request ID. A cooperative plugin
acknowledges cancellation and terminates the primary request as cancelled.

Operation contracts are:

- `describe`: effective identity, version, license, protocol, permissions, and
  capabilities. Identity-bearing fields must agree with the manifest.
- `probe`: sanitized input to supported/not-supported, integer confidence from
  0 through 100, and a human-readable reason.
- `ingest`: sanitized input, options, and the temporary-directory path to a
  validated `SourceArtifact[]` result.
- `healthcheck`: declared checks with `info`, `warning`, or `error` severity and
  an actionable remediation.
- `cancel`: cooperative cancellation of the active primary request.

Text that is not a valid envelope on stdout is a protocol violation. Stderr is
reserved for logs and does not change a valid terminal result.

## Source artifacts

JSONL is the control plane, not the content transport. An ingesting plugin
writes files beneath its assigned temporary directory and returns artifact
descriptors containing:

- a stable artifact identifier within the result;
- role (`original`, `normalized`, `asset`, `inventory`, or `metadata`);
- relative path;
- media type;
- byte length;
- SHA-256 digest;
- optional JSON metadata.

The host rejects absolute paths, `..` traversal, missing files, directories
reported as files, links or junctions that escape the temporary root, duplicate
paths, size mismatches, and digest mismatches. The host returns artifact
descriptors only after the entire result validates. M1 does not promote files
into a vault; that integration belongs to the ingestion milestone.

## Discovery, installation, and removal

The CLI uses `%APPDATA%\Sheldon` as its Windows application-data root:

```text
Sheldon/
  plugins/
    <plugin-id>/
      sheldon-plugin.json
      ...
  plugin-registry.yaml
  plugin-state.db
```

Official plugin roots are supplied by Sheldon packaging and are read-only.
Installed plugins are copied into `plugins/<plugin-id>`. Installation copies to
a sibling staging directory, rejects escaping links and junctions, validates
the complete staged manifest, checks for identifier collisions, and then uses
an atomic rename. Installation does not run plugin code, package lifecycle
scripts, downloads, or network operations.

An installed plugin may not reuse an official or installed identifier. There is
no force override or in-place update in M1. A failed installation leaves every
existing installation and registry record intact.

Removal resolves the identifier through `plugin-registry.yaml` and verifies
that the recorded canonical path is exactly the expected child of the plugin
root before deleting it. Official plugins cannot be removed. Arbitrary paths
are never accepted by the removal operation.

The YAML registry uses atomic writes. `plugin-state.db` records the 10,000 most
recent run summaries globally and last-known health keyed by plugin ID, version,
and manifest digest. A version or digest mismatch makes health `unchecked`;
stale state is never presented as current. This database is operational state,
not knowledge, and may be rebuilt by rediscovery and doctor runs.

## Discovery and health presentation

`sheldon plugin list` does not start every plugin. It shows every discovered
entry with two independent states:

- discovery: `ready`, `invalid`, `incompatible`, or `collision`;
- last health: `healthy`, `unhealthy`, or `unchecked`, with a timestamp when a
  check exists.

Invalid and incompatible plugins remain visible with a concise reason and the
suggested `sheldon plugin doctor <id>` command when doctor can provide more
detail. A persisted health result is explicitly labeled as last-known and may
be stale.

`sheldon plugin doctor <id>` starts only the named plugin's `healthcheck`,
prints all declared checks and remediations, and atomically updates its cached
health result. A manifest or protocol incompatibility is diagnosed without
starting the process.

## Selection

The selector filters candidates by manifest compatibility and declared
capability, then runs `probe` in separate ephemeral processes. Supported
candidates are ordered first by confidence and then by manifest priority.

If multiple candidates share the highest confidence and priority, selection
returns an ambiguity with candidate IDs and reasons. The caller must provide an
explicit plugin ID or obtain a user choice. Installation origin alone never
breaks the tie. An explicit plugin override is still validated and probed.

## Process isolation and environment

Every operation receives a new temporary directory and a new child process.
The plugin working directory is its installed root. The child receives an
allowlisted environment needed for process execution and locale, rather than
the caller's full environment. On Windows this includes `PATH`, `PATHEXT`,
`SystemRoot`, `WINDIR`, `TEMP`, `TMP`, and locale variables; `TEMP` and `TMP`
point to the operation's temporary directory. Known secret-bearing environment
variables are not forwarded.

This is process isolation, not a security sandbox. A locally installed
malicious executable may still access resources available to the operating
system user. The CLI and documentation state this boundary clearly.

Default limits, injectable for tests and configurable by future callers, are:

| Limit                        | Default    |
| ---------------------------- | ---------- |
| `describe` timeout           | 10 seconds |
| `probe` timeout              | 10 seconds |
| `healthcheck` timeout        | 30 seconds |
| `ingest` timeout             | 15 minutes |
| Cooperative cancellation     | 2 seconds  |
| One JSONL line               | 1 MiB      |
| Total protocol stdout        | 8 MiB      |
| Retained stderr              | 256 KiB    |
| Artifacts per execution      | 10,000     |
| Artifact bytes per execution | 2 GiB      |

Exceeding a limit fails the complete operation. Stderr is retained as a bounded
tail so unbounded logs cannot exhaust memory.

## Timeout, cancellation, and cleanup

An `AbortSignal` initiates cancellation. The host sends the cooperative cancel
request and waits up to two seconds. If the plugin does not finish, or when an
operation times out, the host terminates the complete process tree. The Windows
implementation uses a non-shell tree-termination command and verifies process
exit; platform-specific strategies remain behind one interface.

The host creates temporary directories itself, removes them after success or
failure, and returns no artifacts for timed-out or cancelled runs. Cleanup
failure is reported without replacing the primary failure. Duration, plugin
identity and version, terminal status, exit code, bounded stderr tail, and a
sanitized error summary are recorded. Raw inputs and known secrets are not
copied into operational logs.

Invalid JSON, an unexpected request ID, protocol-version mismatch, duplicate or
late terminal responses, output after a terminal response, premature exit, and
limit violations are protocol failures. A valid result remains successful when
the plugin wrote logs to stderr.

## CLI and author workflow

The M1 CLI surface is:

```text
sheldon plugin install <directory>
sheldon plugin remove <id>
sheldon plugin list
sheldon plugin doctor <id>
sheldon plugin test <directory>
```

`plugin test` explicitly executes a plugin from its source directory against
the reusable process contract. A source plugin supplies
`sheldon-plugin.contract.json` with one supported probe case, one unsupported
probe case, and one successful ingest case plus minimal expected artifact roles.
The contract file is development-only and is not required at installation.
This lets the language-neutral harness exercise real plugin-specific inputs
without embedding plugin logic. TypeScript authors may instead pass equivalent
cases directly to the imported Vitest harness.

M1 provides a documented minimal TypeScript plugin using `definePlugin` and
`runPlugin`. Project scaffolding and a remote marketplace are not part of M1.

## Testing

The implementation follows TDD and provides four evidence layers:

1. SDK unit tests for schemas, envelopes, manifests, limits, and serialization.
2. Host unit tests for discovery, collisions, selection, registry safety,
   health persistence, artifact validation, and sanitization.
3. Real-process integration tests for malformed JSON, stderr logs, oversized
   output, timeout, cancellation, cleanup, and descendant termination.
4. CLI acceptance tests using an isolated application-data root for install,
   list, doctor, test, and remove.

The same contract suite runs against two fixtures:

- a Node/TypeScript plugin built with `plugin-sdk`;
- a PowerShell plugin that implements protocol v1 directly and imports no SDK
  code.

The timeout fixture creates a descendant process, and the Windows acceptance
test verifies both parent and descendant are gone. Cancellation must produce a
clear diagnostic, no successful artifacts, and no remaining temporary
directory. Contract coverage also includes incompatible protocols, missing or
incompatible official licenses, duplicate IDs, path traversal, atomic install
rollback, and successful stderr logging.

Completion requires `npm run verify`, including the repository coverage gate,
build, lint, typecheck, Markdown lint, domain checks, repository policy, and
Git whitespace validation. README, changelog, and roadmap status are updated
with the public behavior and acceptance evidence.

## Non-goals

- Official file, website, YouTube, or repository ingestion logic.
- Promotion of temporary artifacts into vault raws.
- A remote marketplace or automatic dependency download.
- Hidden package lifecycle scripts during installation.
- Container, VM, or operating-system security sandboxing.
- Plugin project generation.
- Linux and macOS process-tree guarantees in the Windows-first MVP.
- Long-lived plugin daemons or process pooling.
