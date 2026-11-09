import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MessageChannel, Worker, threadId } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { session } from "../.pi/extensions/worker-thread-poc/api/session.ts";
import { bindSession, closeSession } from "../.pi/extensions/worker-thread-poc/session-binding.ts";
import { RpcPeer, type Message } from "../.pi/extensions/worker-thread-poc/rpc.ts";
import { shutdownMessage, type HostAPI, type HostReceipt, type WorkerAPI } from "../.pi/extensions/worker-thread-poc/contracts.ts";

const options = { timeout: 4000 };
const snapshot = { cwd: process.cwd(), sessionId: "api-test" };

function probe(t: TestContext, workerData: Record<string, unknown> = {}, production = false) {
  const worker = new Worker(new URL(production
    ? "../.pi/extensions/worker-thread-poc/worker-runtime.ts" : "./fixtures/api-probe-runner.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"], stdout: true, stderr: true, workerData,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const id = worker.threadId;
  const receipt: HostReceipt = { ...snapshot, hostPid: process.pid, hostThreadId: threadId,
    hostIsMainThread: true, token: randomUUID() };
  const callbacks: HostAPI["sessionInfo"]["params"][] = [];
  const prompts: string[] = [];
  const errors: Error[] = [];
  const rpc = new RpcPeer<WorkerAPI, HostAPI>((message) => worker.postMessage(message), {
    async sessionInfo(identity) {
      callbacks.push(identity);
      assert.equal(identity.workerPid, process.pid);
      assert.equal(identity.workerThreadId, id);
      assert.equal(identity.workerIsMainThread, false);
      await Promise.resolve();
      return receipt;
    },
    async prompt({ text }) {
      prompts.push(text);
      return { sessionId: snapshot.sessionId, text: `${receipt.token}:${text}`, stopReason: "stop", aborted: false };
    },
  });
  const imported = new Promise<void>((resolve) => worker.on("message", (message) => {
    if (message.event === "module-imported") resolve();
  }));
  worker.on("message", rpc.receive);
  worker.on("error", (error: Error) => { errors.push(error); rpc.close(error); });
  const exited = new Promise<number>((resolve) => worker.once("exit", (code) => {
    rpc.close(new Error(`Worker exited (code=${code})`));
    resolve(code);
  }));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (worker.threadId !== -1) worker.postMessage(shutdownMessage);
    const timer = setTimeout(() => { void worker.terminate(); }, 250);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  t.after(stop);
  const run = (text = "hello") => rpc.call("run", { text, snapshot, mode: "normal",
    filePaths: { hostPath: "unused", workerPath: "unused" } }, 2000);
  return { worker, id, rpc, receipt, callbacks, prompts, errors, exited, imported, stop, run };
}

function shutdownProbe(t: TestContext, shutdownMode: "sessionInfo" | "prompt" | "loader") {
  const { port1, port2 } = new MessageChannel();
  const events: { event: string; error?: string }[] = [];
  const waiters = new Map<string, () => void>();
  const observed = (event: string) => events.some((message) => message.event === event)
    ? Promise.resolve() : new Promise<void>((resolve) => waiters.set(event, resolve));
  port1.on("message", (message: { event: string; error?: string }) => {
    events.push(message);
    waiters.get(message.event)?.();
  });
  const observerClosed = new Promise<void>((resolve) => port1.once("close", resolve));
  const worker = new Worker(new URL("./fixtures/api-probe-runner.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"], stdout: true, stderr: true,
    workerData: { shutdownMode, probePort: port2 }, transferList: [port2],
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const errors: Error[] = [];
  const receipt: HostReceipt = { ...snapshot, hostPid: process.pid, hostThreadId: threadId,
    hostIsMainThread: true, token: randomUUID() };
  const rpc = new RpcPeer<WorkerAPI, HostAPI>((message) => worker.postMessage(message), {
    sessionInfo: () => receipt,
    prompt: ({ text }) => ({ sessionId: snapshot.sessionId, text, stopReason: "stop", aborted: false }),
  });
  let pendingReached!: () => void;
  const pending = new Promise<void>((resolve) => { pendingReached = resolve; });
  worker.on("message", (message: Message) => {
    // Withhold the reply only after the worker actually requests the selected API method.
    if (message.kind === "request" && message.method === shutdownMode) {
      pendingReached();
    } else rpc.receive(message);
  });
  worker.on("error", (error: Error) => { errors.push(error); rpc.close(error); });
  const exited = new Promise<number>((resolve) => worker.once("exit", (code) => {
    rpc.close(new Error(`Worker exited (code=${code})`));
    resolve(code);
  }));
  t.after(async () => {
    port1.close();
    if (worker.threadId !== -1) await worker.terminate();
  });
  const run = () => rpc.call("run", { text: "shutdown", snapshot, mode: "normal",
    filePaths: { hostPath: "unused", workerPath: "unused" } }, 2000);
  return { worker, port1, events, observed, observerClosed, pending, errors, exited, run };
}

for (const method of ["sessionInfo", "prompt"] as const) {
  test(`shutdown rejects a pending injected main ${method} request without a Worker error`, options, async (t) => {
    const instance = shutdownProbe(t, method);
    const rejected = assert.rejects(instance.run(), /Worker exited \(code=0\)/);
    await instance.pending;
    instance.worker.postMessage(shutdownMessage);
    assert.equal(await instance.exited, 0, "shutdown must exit naturally, without terminate()");
    await rejected;
    await instance.observerClosed;
    assert.deepEqual(instance.errors, []);
    assert.equal(instance.events.some(({ event }) => event === "api-resolved"), false);
    assert.equal(instance.events.filter(({ event }) => event === "api-rejected").length, 1);
    assert.match(instance.events.find(({ event }) => event === "api-rejected")!.error!, /RPC closed/);
    assert.deepEqual(instance.events.map(({ event }) => event), ["module-imported", "main-started", "api-rejected"]);
  });
}

test("loader resolving after shutdown cannot execute main", options, async (t) => {
  const instance = shutdownProbe(t, "loader");
  const rejected = assert.rejects(instance.run(), /Worker exited \(code=0\)/);
  await instance.observed("loader-pending");
  instance.worker.postMessage(shutdownMessage);
  await instance.observed("shutdown-observed");
  instance.port1.postMessage("release loader");
  assert.equal(await instance.exited, 0, "late loader completion must exit naturally");
  await rejected;
  await instance.observerClosed;
  assert.deepEqual(instance.errors, []);
  assert.deepEqual(instance.events.map(({ event }) => event), [
    "loader-pending", "shutdown-observed", "loader-resolved",
  ]);
});

test("runner passes a JSON string to main and returns its plain JSON payload", options, async (t) => {
  const instance = probe(t, { jsonBoundary: true });
  const text = 'hello "JSON" \\n🧵';
  const result = await instance.run(text);
  assert.deepEqual(result, {
    inputType: "string",
    payload: { text, snapshot, mode: "normal", filePaths: { hostPath: "unused", workerPath: "unused" } },
    plain: { values: ["text", 42, true, null], nested: { message: "JSON, not a contract wrapper" } },
    workerPid: process.pid,
    workerThreadId: instance.id,
    workerIsMainThread: false,
    workerDefinition: "primary",
  });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(instance.callbacks, []);
  assert.deepEqual(instance.prompts, []);
  await instance.stop();
  assert.equal(await instance.exited, 0);
});

test("module import needs no API and main passes its injected session to helpers", options, async (t) => {
  const instance = probe(t);
  await instance.imported;
  assert.deepEqual(instance.callbacks, [], "module evaluation must not call the session API");
  assert.deepEqual(instance.prompts, []);
  const result = await instance.run();
  const evidence = JSON.parse(result.output);
  assert.equal(evidence.importCompleted, true);
  assert.deepEqual(evidence.directMain, instance.receipt);
  assert.deepEqual(evidence.duringMain, instance.receipt);
  assert.equal(evidence.reply.text, `${instance.receipt.token}:hello`);
  assert.equal(result.workerDefinition, "primary");
  assert.equal(instance.callbacks.length, 2);
  assert.deepEqual(instance.prompts, ["hello"]);
  await instance.stop();
  assert.equal(await instance.exited, 0);
});

test("standalone worker with no imports receives a live API and keeps JSON input/output", options, async (t) => {
  const source = await readFile(new URL("./fixtures/standalone/injected-worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\s*\(/m);
  assert.doesNotMatch(source, /\.pi\/|api\/session|session-binding/);
  const instance = probe(t, { standalone: true });
  await instance.imported;
  assert.deepEqual(instance.callbacks, []);
  assert.deepEqual(instance.prompts, []);
  const text = 'injected "JSON" 🧵';
  const result = await instance.run(text);
  assert.deepEqual(result, {
    inputType: "string",
    payload: { text, snapshot, mode: "normal", filePaths: { hostPath: "unused", workerPath: "unused" } },
    receipt: instance.receipt,
    reply: { sessionId: snapshot.sessionId, text: `${instance.receipt.token}:${text}`,
      stopReason: "stop", aborted: false },
    apiMethods: ["prompt", "sessionInfo"],
    frozenAPI: true,
    workerPid: process.pid,
    workerThreadId: instance.id,
    workerIsMainThread: false,
    workerDefinition: "primary",
  });
  assert.equal(instance.callbacks.length, 1);
  assert.deepEqual(instance.prompts, [text]);
  await instance.stop();
  assert.equal(await instance.exited, 0);
});

test("built-in workers and shared task have no session infrastructure imports", options, async () => {
  for (const name of ["worker.ts", "worker-secondary.ts", "worker-task.ts"]) {
    const source = await readFile(new URL(`../.pi/extensions/worker-thread-poc/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /api\/session|session-binding/, name);
    await import(`../.pi/extensions/worker-thread-poc/${name}`);
  }
});

test("concurrent injected Worker sessions and replacement never reuse or crosswire sessions", options, async (t) => {
  const first = probe(t);
  const second = probe(t);
  const [a, b] = await Promise.all([first.run("one"), second.run("two")]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.receipt.token, second.receipt.token);
  assert.equal(JSON.parse(a.output).reply.text, `${first.receipt.token}:one`);
  assert.equal(JSON.parse(b.output).reply.text, `${second.receipt.token}:two`);
  await first.stop();
  assert.deepEqual((await second.run("still two")).receipt, second.receipt);
  const replacement = probe(t);
  const c = await replacement.run("three");
  assert.notEqual(replacement.id, first.id);
  assert.notEqual(replacement.receipt.token, first.receipt.token);
  assert.deepEqual(c.receipt, replacement.receipt);
  assert.deepEqual(first.prompts, ["one"]);
  assert.deepEqual(second.prompts, ["two", "still two"]);
  assert.deepEqual(replacement.prompts, ["three"]);
});

for (const [data, expected] of [
  [{ mismatch: true }, /does not match trusted selection/],
  [{ importFailure: true }, /API probe import failed/],
] as const) {
  test(`runner rejects invalid module or import failure ${JSON.stringify(data)}`, options, async (t) => {
    const instance = probe(t, data);
    await assert.rejects(instance.run(), expected);
    assert.equal(await instance.exited, 1);
    assert.equal(instance.errors.length, 1);
    assert.deepEqual(instance.callbacks, [], "main must not call sessionInfo after a load failure");
    assert.deepEqual(instance.prompts, [], "main must not execute after a load failure");
  });
}

for (const selectedWorker of [undefined, "missing", "__proto__", "file:///tmp/upload.ts"]) {
  test(`runner rejects untrusted selection ${String(selectedWorker)} before import or RPC`, options, async (t) => {
    const instance = probe(t, { selectedWorker, workerModuleUrl: "./fixtures/api-probe-entry.ts" }, true);
    await assert.rejects(instance.run(), /--worker requires primary or secondary/);
    assert.equal(await instance.exited, 1);
    assert.deepEqual(instance.callbacks, []);
    assert.deepEqual(instance.prompts, []);
  });
}

test("session facade has a typed selected surface, clear lifecycle errors and one binding", options, async () => {
  assert.deepEqual(Object.keys(session).sort(), ["prompt", "sessionInfo"]);
  assert.equal(Object.isFrozen(session), true);
  const { sessionInfo, prompt } = session;
  await assert.rejects(sessionInfo(), /Worker session API is unbound/);
  await assert.rejects(prompt({ text: "before bind" }), /Worker session API is unbound/);
  const receipt: HostReceipt = { ...snapshot, hostPid: process.pid, hostThreadId: threadId,
    hostIsMainThread: true, token: "unit-binding" };
  const client = {
    async sessionInfo() { return receipt; },
    async prompt({ text }: { text: string }) {
      return { sessionId: snapshot.sessionId, text, stopReason: "stop", aborted: false };
    },
  };
  bindSession(client);
  const again = (await import("../.pi/extensions/worker-thread-poc/api/session.ts")).session;
  assert.equal(again, session);
  assert.deepEqual(await sessionInfo(), receipt);
  assert.equal((await prompt({ text: "bound" })).text, "bound");
  assert.throws(() => bindSession(client), /cannot bind: bound/);
  closeSession();
  closeSession();
  await assert.rejects(sessionInfo(), /Worker session API is closed/);
  await assert.rejects(prompt({ text: "after close" }), /Worker session API is closed/);
  assert.throws(() => bindSession(client), /cannot bind: closed/);
  function checkTypes() {
    const info: Promise<HostReceipt> = session.sessionInfo();
    // @ts-expect-error infrastructure owns identity
    session.sessionInfo({ workerDefinition: "primary" });
    // @ts-expect-error text must be a string
    session.prompt({ text: 123 });
    // @ts-expect-error public facade does not expose transport calls
    session.call("prompt", {});
    // @ts-expect-error public facade has no connection factory
    session.startWorker();
    return info;
  }
  void checkTypes;
});
