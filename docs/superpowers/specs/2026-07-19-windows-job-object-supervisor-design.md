# Windows Job Object supervisor design

## Decision

M1 will keep its mandatory Windows process-tree termination guarantee through
a small, Windows-only N-API addon and a Node supervisor process. The addon
creates a Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
places the supervisor's current process in that job before any plugin process
is started. The supervisor then starts the plugin with normal Node streams and
forwards its protocol stdin, stdout, and stderr unchanged.

The host starts the supervisor rather than the plugin directly. On timeout,
cancellation, protocol failure, or host shutdown, terminating the supervisor
causes Windows to close the job handle and terminate every process in the job,
including descendants whose direct plugin parent has already exited. This
removes the PID-reuse and exited-parent race in the previous `taskkill /T`
strategy.

## Architecture

`@sheldon/plugin-host` gains an internal Windows supervisor adapter. On
Windows it invokes the supervisor through `process.execPath`; other platforms
keep the current direct spawn behavior and do not claim equivalent tree
guarantees.

The supervisor performs this ordered sequence:

1. Load the Windows N-API addon.
2. Create the kill-on-close job and assign its own current process.
3. Start exactly one plugin child with `shell: false`, the sanitized
   environment, and the plugin root as working directory.
4. Forward host stdin to the plugin's stdin and plugin stdout/stderr to the
   corresponding supervisor streams without parsing or adding output.
5. Exit only after the plugin's streams and process settle.

The addon has one narrow API: initialize the current process's job ownership.
It does not parse plugin messages, manage files, expose arbitrary process
control, or contain protocol policy. The supervisor's process lifetime owns
the job handle; a normal exit or forced termination closes it.

## Failure handling

If the addon cannot load or initialize the job, the host fails before starting
the plugin with a stable `PLUGIN_SUPERVISOR_UNAVAILABLE` error. It never falls
back silently to a weaker Windows execution path. The error explains that the
Windows native supervisor must be present and compatible with the running Node
architecture.

The existing runner continues to bound request writes, cooperative-cancel
writes, response processing, and cleanup. Its forced termination targets the
supervisor. It awaits the supervisor close event before removing the temporary
operation directory and recording the run.

## Build and distribution

The addon uses the stable N-API C surface and is compiled only for Windows.
`packages/plugin-host/native/windows-job/` contains `binding.gyp` and the C++
source; `node-gyp rebuild` creates its private `.node` artifact there. The
Windows build path invokes that explicit native build before the normal SWC
package build, then includes the architecture-matched artifact alongside the
supervisor. The public runtime requirement remains Node.js 24+, not .NET or a
shell wrapper. Source builds require the matching Node headers, Python, MSVC
Build Tools with the C++ workload, and a Windows SDK; the build reports that
prerequisite clearly.

The Windows loader uses a dynamic runtime require behind `process.platform`,
with a narrow TypeScript declaration rather than a static `.node` import.
Non-Windows type checking, unit tests, and SWC builds remain valid because the
addon loader is not reached there. Generated `native/**/build/` directories and
`.node` artifacts are ignored; a packaged Windows distribution supplies the
matching private binary.

## Testing

Tests first prove that the supervisor initializes before its plugin child, and
that ordinary protocol behavior is transparent through it. Windows integration
tests use a fixture that spawns a pipe-inheriting descendant and exits its
direct parent. Timeout and cancellation must settle, the descendant PID must
disappear, no temporary operation directory may remain, and no asynchronous
database-close rejection may occur.

Tests also cover an unavailable addon, preserving the stable diagnostic and
proving that no plugin command was started. Existing non-Windows tests retain
their direct-spawn coverage while Windows-specific assertions are skipped only
off Windows.

## Scope boundaries

This change strengthens lifecycle ownership; it is not a security sandbox.
Plugins still run with the current user's permissions. The addon is private
host infrastructure and does not change the JSONL protocol or the public SDK.
Linux and macOS tree guarantees remain out of scope for M1.
