import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createFileExchange, verifyFileExchange } from "../.pi/extensions/worker-thread-poc/file-exchange.ts";
import { test, type TestContext } from "node:test";
import { Worker, threadId } from "node:worker_threads";
import { shutdownMessage, type HostAPI, type HostReceipt, type PromptReply, type WorkerAPI } from "../.pi/extensions/worker-thread-poc/contracts.ts";
import { RpcPeer } from "../.pi/extensions/worker-thread-poc/rpc.ts";
import { workerModuleUrl } from "../.pi/extensions/worker-thread-poc/worker-selection.ts";

const options = { timeout: 4_000 };
const workerUrl = workerModuleUrl("primary");
const runnerUrl = new URL("../.pi/extensions/worker-thread-poc/worker-runtime.ts", import.meta.url);
const snapshot = { cwd: process.cwd(), sessionId: "worker-test-session" };
const promptReply: PromptReply = {
  sessionId: snapshot.sessionId, text: "test host answer", stopReason: "stop", aborted: false,
};

function start(t: TestContext, entry = workerUrl) {
  // Deliberately lie in host-side data. Identity must come from the loaded entry.
  const claimedName = entry.href === workerModuleUrl("secondary").href ? "primary" : "secondary";
  const selectedWorker = entry.href === workerModuleUrl("secondary").href ? "secondary" : "primary";
  const builtIn = [workerModuleUrl("primary").href, workerModuleUrl("secondary").href].includes(entry.href);
  const worker = new Worker(builtIn ? runnerUrl : entry, { execArgv: ["--experimental-strip-types"], stdout: true, stderr: true,
    workerData: { selectedWorker, workerDefinition: claimedName, workerModuleUrl: "file:///not-allowed.ts" } });
  const workerThreadId = worker.threadId;
  // Drain captured output without letting Worker output corrupt the test runner protocol.
  worker.stdout.resume();
  worker.stderr.resume();
  const callbacks: HostAPI["sessionInfo"]["params"][] = [];
  const prompts: string[] = [];
  const receipt: HostReceipt = {
    ...snapshot, hostPid: process.pid, hostThreadId: threadId, hostIsMainThread: true, token: randomUUID(),
  };
  const rpc = new RpcPeer<WorkerAPI, HostAPI>((message) => worker.postMessage(message), {
    async sessionInfo(params) {
      callbacks.push(params);
      assert.equal(params.workerPid, process.pid, "same PID across real Worker boundary");
      assert.equal(params.workerThreadId, workerThreadId);
      assert.equal(params.workerIsMainThread, false);
      assert.notEqual(params.workerThreadId, threadId, "different JS execution thread");
      // Deliberately yield: duplex RPC must not deadlock while host awaits run().
      await Promise.resolve();
      return receipt;
    },
    async prompt({ text }) {
      prompts.push(text);
      await Promise.resolve();
      return promptReply;
    },
  });
  worker.on("message", rpc.receive);
  const errors: Error[] = [];
  worker.on("error", (error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    errors.push(failure);
    rpc.close(failure);
  });
  const exited = new Promise<number>((resolveExit) => worker.once("exit", (code) => {
    rpc.close(new Error(`Worker exited (code=${code})`));
    worker.off("message", rpc.receive);
    resolveExit(code);
  }));
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= (async () => {
    rpc.close(new Error("Worker stopped by host"));
    if (worker.threadId !== -1) worker.postMessage(shutdownMessage);
    const timer = setTimeout(() => { void worker.terminate(); }, 250);
    try { await exited; }
    finally { clearTimeout(timer); }
    assert.equal(worker.threadId, -1, "exit/terminate, not a PID probe, proves Worker cleanup");
  })();
  t.after(stop);
  const run = async (mode: WorkerAPI["run"]["params"]["mode"] = "normal", text = "hello", timeout = 1_000,
    filePaths?: WorkerAPI["run"]["params"]["filePaths"]) => {
    const paths = filePaths ?? await createFileExchange();
    // Deliberately strip hostWrittenText: only paths cross the Worker boundary.
    return rpc.call("run", { mode, text, snapshot,
      filePaths: { hostPath: paths.hostPath, workerPath: paths.workerPath } }, timeout);
  };
  return { worker, workerThreadId, rpc, run, receipt, callbacks, prompts, errors, exited, stop };
}

async function assertNormal(instance: ReturnType<typeof start>, text = "hello") {
  const result = await instance.run("normal", text);
  assert.equal(result.workerDefinition, "primary");
  assert.equal(result.workerPid, process.pid);
  assert.equal(result.workerThreadId, instance.workerThreadId);
  assert.equal(result.workerIsMainThread, false);
  assert.deepEqual(result.receipt, instance.receipt, "Worker returns exact asynchronous host callback reply");
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(result.output, `${text.toUpperCase()} (host callback token: ${instance.receipt.token})`);
  assert.equal(result.fileExchange.workerReadHostText, await readFile(result.fileExchange.hostPath, "utf8"));
  assert.equal(result.fileExchange.workerWrittenText, await readFile(result.fileExchange.workerPath, "utf8"));
  return result;
}

// Run the new entry-selection checks before the existing lifecycle regression tests.
for (const name of ["primary", "secondary"] as const) {
  test(`${name} entry owns identity and output despite contradictory host labels; two-way fs works`, options, async (t) => {
    const instance = start(t, workerModuleUrl(name));
    const prepared = await createFileExchange();
    const result = await instance.run("normal", "hello", 1_000, prepared);
    assert.equal(result.workerDefinition, name);
    assert.notEqual(result.workerDefinition, name === "primary" ? "secondary" : "primary");
    assert.equal(instance.callbacks[0].workerDefinition, name);
    const transformed = name === "primary" ? "HELLO" : "OLLEH";
    assert.equal(result.output, `${transformed} (host callback token: ${instance.receipt.token})`);
    assert.deepEqual(result.receipt, instance.receipt);
    assert.deepEqual(result.snapshot, snapshot);
    const files = await verifyFileExchange(prepared, result.fileExchange);
    assert.equal(files.workerReadHostFile, true);
    assert.equal(files.hostReadWorkerFile, true);
    await instance.stop();
    assert.equal(await instance.exited, 0);
  });

  test(`${name} entry preserves literal same-session prompt RPC and bidirectional files`, options, async (t) => {
    const instance = start(t, workerModuleUrl(name));
    const prepared = await createFileExchange();
    const result = await instance.run("prompt", "prompt", 1_000, prepared);
    assert.equal(result.workerDefinition, name);
    assert.deepEqual(instance.prompts, ["hello world"]);
    assert.deepEqual(result.promptReply, promptReply);
    assert.equal(result.output, promptReply.text, "never transform assistant output");
    const files = await verifyFileExchange(prepared, result.fileExchange);
    assert.equal(files.workerReadHostFile, true);
    assert.equal(files.hostReadWorkerFile, true);
  });

  test(`${name} entry preserves fail, timeout, crash and recovery semantics`, options, async (t) => {
    const instance = start(t, workerModuleUrl(name));
    await assert.rejects(instance.run("fail"), /Intentional worker failure/);
    assert.equal((await instance.run()).workerDefinition, name);
    await assert.rejects(instance.run("timeout", "timeout", 50), /RPC timeout: run after 50ms/);
    assert.equal((await instance.run()).workerDefinition, name, "a deadline does not block later requests");
    await assert.rejects(instance.run("crash"), /Worker exited \(code=7\)/);
    assert.equal(await instance.exited, 7);
    assert.equal(instance.callbacks.every((callback) => callback.workerDefinition === name), true);
    const replacement = start(t, workerModuleUrl(name));
    assert.equal((await replacement.run()).workerDefinition, name);
  });
}

test("real TypeScript Worker shares PID, has its own thread ID, and awaits host callback", options, async (t) => {
  const instance = start(t);
  assert.equal(threadId, 0);
  assert.ok(instance.workerThreadId > 0);
  await assertNormal(instance);
  assert.equal(instance.callbacks.length, 1);
  assert.deepEqual(instance.errors, []);
  await instance.stop();
  assert.equal(await instance.exited, 0, "control message closes parentPort and allows natural exit");
  await instance.stop(); // shutdown must be idempotent
});

test("real Worker requests literal hello world and receives host prompt reply data", options, async (t) => {
  const instance = start(t);
  const result = await instance.run("prompt", "prompt");
  assert.deepEqual(instance.prompts, ["hello world"]);
  assert.equal(result.fileExchange.workerReadHostText, await readFile(result.fileExchange.hostPath, "utf8"));
  assert.equal(result.fileExchange.workerWrittenText, await readFile(result.fileExchange.workerPath, "utf8"));
  assert.deepEqual(result.promptReply, promptReply);
  assert.equal(result.output, promptReply.text);
  assert.deepEqual(result.receipt, instance.receipt);
  assert.equal(result.workerPid, process.pid);
  assert.equal(result.workerThreadId, instance.workerThreadId);
});

test("real Worker file exchange uses fresh private files and paths-only RPC", options, async (t) => {
  const instance = start(t);
  const prepared = await createFileExchange();
  const result = await instance.run("normal", "not copied to disk", 1_000, prepared);
  const proof = await verifyFileExchange(prepared, result.fileExchange);
  assert.equal(proof.workerReadHostFile, true);
  assert.equal(proof.hostReadWorkerFile, true);
  assert.equal(proof.fileExchange.workerReadHostText, prepared.hostWrittenText);
  assert.match(proof.fileExchange.hostWrittenText, /^pi-worker-thread-poc host test [\da-f-]+\n$/);
  assert.match(proof.fileExchange.workerWrittenText, /^pi-worker-thread-poc worker test [\da-f-]+\n$/);
  assert.notEqual(proof.fileExchange.hostWrittenText, proof.fileExchange.workerWrittenText);
  assert.equal((await stat(prepared.hostPath)).mode & 0o777, 0o600);
  assert.equal((await stat(prepared.workerPath)).mode & 0o777, 0o600);
  assert.equal((await stat(new URL(".", `file://${prepared.hostPath}`))).mode & 0o777, 0o700);
});

test("missing host file rejects real Worker RPC, then recovery succeeds", options, async (t) => {
  const instance = start(t);
  const prepared = await createFileExchange();
  await assert.rejects(instance.run("normal", "hello", 1_000,
    { ...prepared, hostPath: `${prepared.hostPath}.missing` }), /ENOENT/);
  await assertNormal(instance, "recovered after read error");
  await instance.stop();
  assert.equal(await instance.exited, 0);
});

test("real Worker refuses to clobber an existing file, then recovery succeeds", options, async (t) => {
  const instance = start(t);
  const prepared = await createFileExchange();
  await writeFile(prepared.workerPath, "preexisting test text\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(instance.run("normal", "hello", 1_000, prepared), /EEXIST/);
  assert.equal(await readFile(prepared.workerPath, "utf8"), "preexisting test text\n");
  await assertNormal(instance, "recovered after write error");
});

test("remote failure does not kill a real Worker and permits another call", options, async (t) => {
  const instance = start(t);
  await assert.rejects(instance.run("fail"), /Intentional worker failure/);
  await assertNormal(instance, "recovered after failure");
  assert.equal(instance.callbacks.length, 2);
  assert.deepEqual(instance.errors, []);
});

test("real blocked Worker hits deadline, terminates, and a replacement succeeds", options, async (t) => {
  const instance = start(t);
  // Give startup its normal budget before testing the deliberately blocked run.
  await assertNormal(instance);
  await assert.rejects(instance.run("timeout", "timeout", 50), /RPC timeout: run after 50ms/);
  assert.equal(instance.callbacks.length, 2, "timeout happened after actual Worker callback");
  await instance.stop();
  const replacement = start(t);
  assert.notEqual(replacement.workerThreadId, instance.workerThreadId);
  await assertNormal(replacement, "recovered after timeout");
});

test("process.exit(7) inside real Worker exits that thread, rejects RPC, and host recovers", options, async (t) => {
  const instance = start(t);
  const rejection = assert.rejects(instance.run("crash"), /Worker exited \(code=7\)/);
  assert.equal(await instance.exited, 7);
  await rejection;
  assert.equal(instance.worker.threadId, -1);
  assert.deepEqual(instance.errors, []);
  // process.pid is intentionally never passed to kill(): host is this same process.
  await assertNormal(start(t), "host survived Worker crash");
});

test("uncaught real Worker error rejects pending RPC without an unhandled host error", options, async (t) => {
  const instance = start(t, new URL("./fixtures/crash-worker.ts", import.meta.url));
  const rejection = assert.rejects(instance.run(), /Intentional uncaught Worker fixture failure/);
  assert.equal(await instance.exited, 1);
  await rejection;
  assert.equal(instance.errors.length, 1);
  assert.equal(instance.worker.threadId, -1);
  await assertNormal(start(t), "host survived uncaught error");
});

test("Worker module startup failure rejects RPC and leaves host available", options, async (t) => {
  const instance = start(t, new URL("./fixtures/does-not-exist-worker.ts", import.meta.url));
  const rejection = assert.rejects(instance.run(), /Cannot find module|ERR_MODULE_NOT_FOUND/);
  assert.equal(await instance.exited, 1);
  await rejection;
  assert.equal(instance.errors.length, 1);
  assert.equal(instance.worker.threadId, -1);
  await assertNormal(start(t), "host survived startup failure");
});

test("explicit terminate stops only a blocked Worker and rejects its pending call", options, async (t) => {
  const instance = start(t);
  await assertNormal(instance);
  const calledBack = new Promise<void>((resolve) => instance.worker.once("message", () => resolve()));
  const rejection = assert.rejects(instance.run("timeout"), /Worker exited \(code=1\)/);
  await calledBack;
  assert.equal(await instance.worker.terminate(), 1);
  await rejection;
  assert.equal(instance.worker.threadId, -1);
  await assertNormal(start(t), "host survived explicit termination");
});

test("host shutdown closes an in-flight call and awaits real Worker exit", options, async (t) => {
  const instance = start(t);
  await assertNormal(instance);
  // Wait for the second callback before stopping the in-flight blocked operation.
  let callbackSeen!: () => void;
  const callback = new Promise<void>((resolve) => { callbackSeen = resolve; });
  const observe = (message: unknown) => {
    if (typeof message === "object" && message !== null && "kind" in message &&
      message.kind === "request" && "method" in message && message.method === "sessionInfo") callbackSeen();
  };
  instance.worker.on("message", observe);
  const rejection = assert.rejects(instance.run("timeout"), /Worker stopped by host/);
  await callback;
  instance.worker.off("message", observe);
  await Promise.all([instance.stop(), rejection]);
  assert.equal(instance.worker.threadId, -1);
  await assert.rejects(instance.run(), /Worker stopped by host/);
});
