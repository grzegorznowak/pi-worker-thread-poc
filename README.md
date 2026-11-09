# Pi worker-thread PoC

> **⚠️ WARNING: This is pure experimentation.** A small proof of concept for exploring how a
> [Pi](https://github.com/earendil-works/pi) extension can select native TypeScript
> Node.js worker threads, exchange typed messages and files, and ask the *same
> running Pi session* to answer a prompt. It is not production infrastructure and
> is not a security boundary. Workers share the host process and OS permissions.
> Expect rough edges, missing features, and behavior that may change.

A project-local Pi extension selects one of two native TypeScript worker modules at invocation time. A shared runner binds a small typed session SDK before importing the selected module and calling its `main(input)`. The worker uses that SDK while the host awaits its result. Both use **the same PID and different thread IDs**. The original `/home/vscode/pi-worker-poc` project is not changed.

## Run

Requires Node **>=22.19.0** and an installed Pi (developed with Pi 1.5.0 / Node 24.14.0). There are no runtime dependencies, build step, global extension changes, or new Pi sessions.

```sh
cd /home/vscode/pi-worker-thread-poc
pi --approve
```

`--approve` trusts this project for that process. Review the extension first. If Pi is already running here, use `/reload`.

```text
/worker-thread-poc hello
```

This runs local thread RPC and a two-way file exchange; no model or provider call is needed. The default `primary` entry returns `HELLO` and a token created by the host callback. With no argument, it runs the same `hello` flow.

Select a different entry in the **same running Pi session**, without `/reload`:

```text
/worker-thread-poc hello
/worker-thread-poc --worker secondary hello
/worker-thread-poc --worker primary hello
```

The outputs start with `HELLO`, `OLLEH`, and `HELLO`. Each invocation starts the shared `worker-runtime.ts` entry with an allowlisted selection in `workerData`. The runner binds the session SDK, then dynamically imports `worker.ts` for `primary` or `worker-secondary.ts` for `secondary`. These are separate behavior modules, each with its own exported identity, `main(input)`, and text transform. No definition functions cross IPC.

Syntax: `/worker-thread-poc [--worker primary|secondary] [text]`. The optional selection must appear once, before text; the `--worker=value` form is not supported. With no text, either entry runs `hello`. Leading and trailing text whitespace is trimmed; internal spacing is kept. Missing/unsupported selections, repeated selections, and misplaced `--worker` options return an error before any worker, `/tmp` files, or model work starts. Other text remains normal input.

This demonstrates runtime selection/injection of **trusted built-in definitions**, not arbitrary code upload. There is no raw `eval`, source-string execution, or user-supplied module path. To add another definition, maintain a trusted entry and its explicit mapping in `worker-selection.ts`; do not accept unvalidated paths.

```text
/worker-thread-poc prompt
/worker-thread-poc --worker secondary prompt
```

**This command uses the active session's configured model and may incur provider cost.** The worker requests the literal user message `hello world`. The host sends it through `pi.sendUserMessage()` in the **same active Pi session**, waits for the assistant response, and returns the response to the worker. It does not start a second Pi process or create an SDK session. The CLI integration tests verify this flow with a deterministic local provider, not an external provider.

The session must be idle, with no queued messages and with an active model and resolved provider authentication. The message uses the current conversation, tools, model, and credentials. Input handlers can change or consume it. Do not run this command from an agent lifecycle handler or tool: awaiting that same run from its handler can deadlock.

Additional local diagnostic commands:

```text
/worker-thread-poc fail
/worker-thread-poc timeout
/worker-thread-poc crash
```

These demonstrate a remote exception, deadline, and worker-thread exit (code 7). Each also accepts `--worker primary` or `--worker secondary` before the diagnostic text. `process.exit()` in the worker ends only that thread. Other text is uppercased by `primary`, or reversed by Unicode code point then uppercased by `secondary`. Both prompt modes return the assistant text unchanged.

## Worker-facing session SDK

Workers import the plugin-owned `session` object. They do not start a worker, create a connection, list RPC methods, or receive Pi's `pi` or `ctx` objects. The actual primary module is:

```ts
import type { WorkerInput } from "./contracts.ts";
import { session } from "./sdk/session.ts";
import { executeTask } from "./worker-task.ts";

export const workerDefinition = "primary";
export async function main(input: WorkerInput) {
  return executeTask(input, await session.sessionInfo(), (text) => text.toUpperCase());
}
```

`executeTask()` holds the shared demo file checks, diagnostics, and prompt behavior. In prompt mode, it uses the same facade:

```ts
const reply = await session.prompt({ text: "hello world" });
```

`sessionInfo()` takes no identity arguments. The runner attaches the trusted selection and actual PID/thread identity. Both methods return typed promises; RPC stays inside the infrastructure. Adding a capability requires a facade method, a contract, and a host implementation, not changes to each worker's connection setup.

The runner binds the SDK **before module evaluation**, so imports and helpers can use it before `main()` starts. Imports share one frozen facade and one connection within that Worker isolate. Separate Workers have separate module state, even though they share a PID. Calls before binding or after closure reject with a clear lifecycle error; a closed binding cannot be reused. This is a selected host-capability API, not the full Pi SDK or a new session.

## Report

Interactive Pi and CLI RPC mode receive notifications prefixed with `WORKER_THREAD_POC_PROGRESS` and `WORKER_THREAD_POC_RESULT`, followed by JSON. The result contains:

- `selectedWorker`: the host's parsed selection; `workerModuleUrl`: the selected behavior module URL, not the shared runner URL passed to `new Worker()`.
- `workerDefinition`: the loaded module's exported name, checked by the runner against the selection and returned in `result.workerDefinition`. The progress callback carries the runner-attached trusted selection and actual thread identity.
- `workerDefinitionMatches`: the returned definition equals the selected name. This must be `true` for `ok`.
- `ok`, `hostPid`, `workerPid`, `hostThreadId`, `workerThreadId`.
- `hostIsMainThread`, `workerIsMainThread`, `samePid`, `differentThread` on success.
- `callback`: live host session ID, cwd, host identity, and random token.
- `result`: the worker's identity, starting snapshot, callback receipt, output, and `fileExchange` receipt.
- `fileExchange`: `hostPath`, `workerPath`, `hostWrittenText`, `workerReadHostText`, `workerWrittenText`, and `hostReadWorkerText`. The paths point to retained `/tmp/pi-worker-thread-poc-*/host.txt` and `worker.txt` files.
- `workerReadHostFile`: the worker's host-file path and readback match the host's original path and fresh test text.
- `hostReadWorkerFile`: the worker's output path matches the expected path, and the host independently read that file and matched its contents to the worker's receipt. Both booleans are top-level report fields.
- In prompt mode, `result.promptReply`: session ID, assistant text, stop reason, abort state, and optional error message. `result.output` is the assistant text.
- Exceptions produce `error`, `ok: false`, and both file-check booleans set to `false`. On a worker error, `workerDefinition` comes from its progress callback, or is `null` if no callback arrived. A readback, path, or definition mismatch produces `ok: false`.
- Invalid options produce only an error result notification with `workerStarted: false`; there is no worker identity, progress callback, module URL, or file exchange.

Success requires the actual definition to match the selection, the reported PID to match, the thread IDs to differ, and **both file-check booleans to be true**. Missing files and file I/O errors cannot produce successful proof. Prompt errors and aborts also make `ok` false. The host captures the worker's thread ID before shutdown because Node sets it to `-1` after exit. These notifications are not model-visible tools or transcript messages. In print/JSON mode the extension has no notification UI; use interactive or RPC mode to inspect the report.

## Files and flow

```text
.pi/extensions/worker-thread-poc/
  index.ts           project-local extension and worker lifecycle
  contracts.ts       explicit data-only host/worker API contracts
  file-exchange.ts   private test-file creation and independent host verification
  rpc.ts             internal symmetric transport and typed method-client helper
  worker-selection.ts small argument parser and trusted module mapping
  worker.ts          primary module exporting main(input) (uppercase)
  worker-secondary.ts secondary module exporting main(input) (reverse-uppercase)
  worker-runtime.ts  native Worker entry, validates the selected built-in module
  worker-runner.ts   connection setup, SDK binding, dynamic import, and lifecycle
  session-binding.ts internal one-lifetime, isolate-local SDK binding
  sdk/session.ts     worker-facing typed session object, no transport setup
  worker-task.ts     shared demo file exchange, diagnostics, and prompt behavior
  session-prompt.ts  host-side same-session prompt lifecycle adapter
```

Pi discovers `index.ts`, not each helper as an extension. Pi uses jiti to load the extension; Node runs `worker-runtime.ts`, the selected behavior module, and their imports through native TypeScript stripping. `execArgv: ["--experimental-strip-types"]` replaces host command-line flags and explicitly enables stripping, even when `NODE_OPTIONS=--no-experimental-strip-types` is inherited. An empty `execArgv` alone does not override `NODE_OPTIONS`. This worker flag is supported in Node 22.19.0 and Node 24.14.0. The root ESM package and erasable TypeScript syntax work without an external loader. This PoC is for Node, not Bun.

1. The host parses and validates the selection, resolves its trusted module URL, and starts one `Worker` at the shared runtime per valid command. Inside the guarded lifecycle, it creates a unique directory with `mkdtemp('/tmp/pi-worker-thread-poc-')` and writes fresh nonsecret test text to `host.txt`.
2. The runner creates the connection and binds `session` before dynamically importing the selected module. It checks the module's exported identity and `main` function. The host calls internal `run()` over `postMessage` with typed **file paths only**, not the host file's contents. The runner waits for the import, then invokes `main(input)`. While the host waits, the module calls `session.sessionInfo()` and receives current session data and a token.
3. For normal/default and prompt modes, the worker uses Node `readFile(hostPath)` and writes its own fresh test text with `writeFile(workerPath)`. It returns the readback and its written text/path in a typed receipt. Fail/timeout/crash diagnostics stop before this step.
4. In prompt mode it also calls `session.prompt({ text: "hello world" })`. The host observes `agent_start`, captures assistant text at `agent_end`, and resolves at `agent_settled` (which covers retries and continuations).
5. On return, the host checks the entry's own `workerDefinition` against its selection and independently uses `readFile(workerPath)`. It compares the worker's host-file readback with its original text, and its own worker-file readback with the worker's receipt. Neither direction can pass on a path mismatch.
6. The host cancels pending prompt work, sends a shutdown control message, and waits for thread exit, including on file I/O failure. The runner closes the SDK binding, RPC, and port. After 750 ms the host falls back to `worker.terminate()`.

The directory has mode `0700`; files use mode `0600` and exclusive creation (`wx`) to avoid overwriting existing files. File contents contain only an identifiable test label and a fresh UUID, never command arguments, model output, session data, or credentials. Files are retained for operator inspection: there is no file deletion or automatic cleanup. Each command/test run can add a directory under `/tmp`, so these files accumulate.

The host handles worker `error`, `messageerror`, and `exit`; RPC propagates remote failures and bounds pending calls. Normal requests have a 5 s deadline; the timeout diagnostic uses 750 ms. Prompt deadlines are nested: host prompt 60 s, worker callback 65 s, outer request 70 s. Session shutdown/reload aborts active adapters and awaits worker cleanup. Worker stdout is captured and discarded, so `console.log()` cannot corrupt Pi's RPC JSONL; worker stderr remains on stderr.

## Execution sequence

This diagram covers startup, command execution, the optional model call, and cleanup. The Pi harness and extension run on the same main thread; the worker runs on a separate thread in that process.

```mermaid
sequenceDiagram
    actor User
    participant Pi as Pi harness / active session
    participant Ext as Extension (main thread)
    participant Worker as Shared runner + selected TS module (worker thread)
    participant FS as Local filesystem (/tmp)
    participant Model as Configured model provider

    User->>Pi: Start pi --approve
    Pi->>Pi: Discover trusted project extensions
    Pi->>Ext: Load index.ts via jiti
    Ext->>Pi: Register /worker-thread-poc
    Note over Ext: No worker started yet

    User->>Pi: /worker-thread-poc [--worker primary|secondary] hello OR prompt
    Pi->>Ext: Invoke command handler(args, ctx)
    Ext->>Ext: Validate selection, reject invalid options before any work
    Ext->>Ext: Resolve trusted worker.ts OR worker-secondary.ts URL
    Ext->>Worker: new Worker(shared runtime URL, selectedWorker)
    Worker->>Worker: Create connection and bind session SDK
    Worker->>Worker: Dynamically import selected module, verify exported identity
    Note over Ext,Worker: Same PID, different thread IDs and V8 isolates<br/>Native TypeScript stripping in worker

    Ext->>FS: mkdtemp /tmp/pi-worker-thread-poc-* (0700)
    FS-->>Ext: Unique directory
    Ext->>FS: writeFile host.txt (fresh test text, wx, 0600)
    Ext->>Worker: RPC run(text, mode, session snapshot, file paths)
    Note over Ext,Worker: Typed messages via postMessage / structured clone<br/>Host awaits run(), but still handles callbacks
    Worker->>Worker: Await module import, invoke main(input)
    Worker->>Worker: main calls session.sessionInfo()
    Worker->>Ext: Internal RPC sessionInfo(runner-attached identity)
    Ext->>Pi: Read live session ID and cwd
    Pi-->>Ext: Session data
    Ext->>Pi: Notify WORKER_THREAD_POC_PROGRESS
    Ext-->>Worker: Session data, host identity, random token

    Worker->>FS: readFile(hostPath)
    FS-->>Worker: Host test text (not sent in RPC params)
    Worker->>FS: writeFile(workerPath, fresh worker test text, wx, 0600)

    alt hello mode (also the default)
        Worker->>Worker: Apply entry's transform and include callback token
    else prompt mode
        Worker->>Worker: session.prompt({ text: "hello world" })
        Worker->>Ext: Internal RPC prompt("hello world")
        Ext->>Ext: Check idle session and active model
        Ext->>Pi: Subscribe to lifecycle events
        Ext->>Ext: Resolve authentication and recheck session state
        Ext->>Pi: sendUserMessage("hello world")
        Note over Pi,Ext: Uses the existing session, history, and tools<br/>sendUserMessage returns void

        Pi-->>Ext: agent_start
        Pi->>Model: Run agent with current conversation
        Model-->>Pi: Assistant response
        Pi-->>Ext: agent_end(messages)
        Ext->>Ext: Capture latest assistant text
        Note over Pi,Ext: Retries or continuations may repeat these events
        Pi-->>Ext: agent_settled
        Ext->>Ext: Remove subscriptions and deadline timer
        Ext-->>Worker: Prompt reply with text and session ID
    end

    Worker-->>Ext: RPC result with actual definition, output, and file receipt
    Ext->>FS: readFile(original workerPath)
    FS-->>Ext: Worker test text
    Ext->>Ext: Compare both readbacks and receipt paths
    Ext->>Ext: Check definition match, same PID, different threads, both file checks
    Note over Ext,FS: Retain both files for inspection, no deletion
    Ext->>Worker: Shutdown control message
    Worker->>Worker: Close session binding, RPC, and parentPort
    Worker-->>Ext: Thread exit event
    Note over Ext,Worker: Fallback: terminate() after 750 ms if needed

    Ext->>Pi: Notify WORKER_THREAD_POC_RESULT
    Pi-->>User: Display result
```

Errors, crashes, and deadlines produce `ok: false` and follow the cleanup path.

## Limits

- **Not a security sandbox.** The worker has the same OS permissions and inherits an environment copy. It can access files, network, and Node APIs. The file exchange proves shared filesystem access, not security isolation. Restrictive file modes do not isolate the worker from the host. Do not run untrusted code here.
- Each worker has its own V8 isolate, JS globals, module cache, and event loop, but shares the process and its resource/failure scope. `terminate()` is not process isolation. There are no resource quotas.
- Messages use structured clone, not shared Pi SDK objects. No `pi`, `ctx`, functions, session manager, or credentials are sent. This is a small explicit API, not a transparent full SDK proxy. Types are compile-time checks; envelopes have basic runtime checks only. The PoC sends no shared memory.
- Pi's public `sendUserMessage()` returns `void`, so the adapter observes lifecycle events. Events have no request/run IDs. Exclusive idle guards reduce overlap but cannot isolate a prompt from human steering or other extensions.
- A timeout or shutdown can abort an observed same-session run. It cannot retract an already submitted message still in input preparation before `agent_start`. Auth resolution has no public cancellation signal; late results are ignored. An input handler that consumes the message produces no settled event; the deadline bounds that wait.
- Keep long or blocking work out of the host event callbacks. The slash-command handler may await the worker; the synchronous lifecycle observers only capture state and resolve promises.

## Tests

The separate `tests/` suite uses Node's built-in test runner and CLI RPC fixtures; it does not need real provider calls:

```sh
npm test
npm run test:unit
npm run test:pi
npm run test:prompt
```

Real Worker tests use the shared runner to load both native TS modules, verify their distinct output and exported identity despite contradictory extra `workerData` labels, and check the typed callback, two-way files, prompt, failure, timeout, crash, and recovery. SDK tests cover binding before import and `main()`, shared helper imports, concurrent and replacement Worker isolation, unbound/closed errors, rejected rebinding, load failures, shutdown during pending import/main calls, and prevention of late `main()` execution after shutdown. Strict compiler checks cover the facade and selected-method client types. Parser tests cover valid forms, preserved text, default text, and invalid options. Existing tests still cover missing input files, refusal to overwrite existing output, and recovery after I/O errors. Host-verifier tests cover false readbacks, false written-text receipts, substituted paths, and missing output. CLI tests switch default → secondary → explicit primary in one running Pi process/session without reload, verify each module URL/definition, and prove invalid-selection recovery without creating files or starting model work. Both definitions run the fixture prompt in one session. Tests independently read retained files, check permissions, and print representative evidence.

The CLI integration suite also starts a fresh Pi process with `NODE_OPTIONS=--no-experimental-strip-types` and verifies that the actual extension still completes a native Worker call. The test sets only that child's environment; it does not change the test runner's global environment.

The package scripts preserve the original test file paths (`tests/*.test.ts`, `tests/pi-integration.mjs`, `tests/prompt-integration.mjs`). Temporary fixture state under `.test-agent-*/` and `node_modules/` is ignored. No original test artifacts or `.git` directory are copied.
