# Pi worker-thread PoC

A project-local Pi extension calls a native TypeScript Node worker. The worker calls a small typed host API while the host awaits its result. Both use **the same PID and different thread IDs**. The original `/home/vscode/pi-worker-poc` project is not changed.

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

This runs only local thread RPC; no model or provider call is needed. It returns `HELLO` and a token created by the host callback.

```text
/worker-thread-poc prompt
```

**This command uses the active session's configured model and may incur provider cost.** The worker requests the literal user message `hello world`. The host sends it through `pi.sendUserMessage()` in the **same active Pi session**, waits for the assistant response, and returns the response to the worker. It does not start a second Pi process or create an SDK session. The CLI integration tests verify this flow with a deterministic local provider, not an external provider.

The session must be idle, with no queued messages and with an active model and resolved provider authentication. The message uses the current conversation, tools, model, and credentials. Input handlers can change or consume it. Do not run this command from an agent lifecycle handler or tool: awaiting that same run from its handler can deadlock.

Additional local diagnostic commands:

```text
/worker-thread-poc fail
/worker-thread-poc timeout
/worker-thread-poc crash
```

These demonstrate a remote exception, deadline, and worker-thread exit (code 7). `process.exit()` in the worker ends only that thread. Other text is handled like `hello` and uppercased.

## Report

Interactive Pi and CLI RPC mode receive notifications prefixed with `WORKER_THREAD_POC_PROGRESS` and `WORKER_THREAD_POC_RESULT`, followed by JSON. The result contains:

- `ok`, `hostPid`, `workerPid`, `hostThreadId`, `workerThreadId`.
- `hostIsMainThread`, `workerIsMainThread`, `samePid`, `differentThread` on success.
- `callback`: live host session ID, cwd, host identity, and random token.
- `result`: the worker's identity, starting snapshot, callback receipt, and output.
- In prompt mode, `result.promptReply`: session ID, assistant text, stop reason, abort state, and optional error message. `result.output` is the assistant text.
- On failure, `error` and `ok: false`.

Success requires the reported PID to match and the thread IDs to differ. Prompt errors and aborts also make `ok` false. The host captures the worker's thread ID before shutdown because Node sets it to `-1` after exit. These notifications are not model-visible tools or transcript messages. In print/JSON mode the extension has no notification UI; use interactive or RPC mode to inspect the report.

## Files and flow

```text
.pi/extensions/worker-thread-poc/
  index.ts           project-local extension and worker lifecycle
  contracts.ts       explicit data-only host/worker API contracts
  rpc.ts             symmetric typed request/response peer
  worker.ts          native TypeScript worker_threads entry
  session-prompt.ts  same-session prompt lifecycle adapter
```

Pi discovers `index.ts`, not each helper as an extension. Pi uses jiti to load the extension; Node runs `worker.ts` and its imports through native TypeScript stripping. `execArgv: ["--experimental-strip-types"]` replaces host command-line flags and explicitly enables stripping, even when `NODE_OPTIONS=--no-experimental-strip-types` is inherited. An empty `execArgv` alone does not override `NODE_OPTIONS`. This worker flag is supported in Node 22.19.0 and Node 24.14.0. The root ESM package and erasable TypeScript syntax work without an external loader. This PoC is for Node, not Bun.

1. The host starts one `Worker` per command and calls `run()` over `postMessage`.
2. While the host waits, the worker calls host `sessionInfo()` and receives current session data and a token.
3. In prompt mode it also calls host `prompt({ text: "hello world" })`.
4. The host observes `agent_start`, captures assistant text at `agent_end`, and resolves at `agent_settled` (which covers retries and continuations).
5. The worker returns its result. The host cancels pending prompt work, sends a shutdown control message, and waits for thread exit. After 750 ms it falls back to `worker.terminate()`.

The host handles worker `error`, `messageerror`, and `exit`; RPC propagates remote failures and bounds pending calls. Normal requests have a 5 s deadline; the timeout diagnostic uses 750 ms. Prompt deadlines are nested: host prompt 60 s, worker callback 65 s, outer request 70 s. Session shutdown/reload aborts active adapters and awaits worker cleanup. Worker stdout is captured and discarded, so `console.log()` cannot corrupt Pi's RPC JSONL; worker stderr remains on stderr.

## Limits

- **Not a security sandbox.** The worker has the same OS permissions and inherits an environment copy. It can access files, network, and Node APIs. Do not run untrusted code here.
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

The CLI integration suite first starts a fresh Pi process with `NODE_OPTIONS=--no-experimental-strip-types` and verifies that the actual extension still completes a native Worker call. The test sets only that child's environment; it does not change the test runner's global environment.

The package scripts preserve the original test file paths (`tests/*.test.ts`, `tests/pi-integration.mjs`, `tests/prompt-integration.mjs`). Temporary fixture state under `.test-agent-*/` and `node_modules/` is ignored. No original test artifacts or `.git` directory are copied.
