import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const extension = resolve(project, ".pi/extensions/worker-thread-poc/index.ts");
export const provider = "worker-thread-poc-test-only";
export const progressPrefix = "WORKER_THREAD_POC_PROGRESS ";
export const resultPrefix = "WORKER_THREAD_POC_RESULT ";

export async function startPi({ approved = true, fixture = false, nodeOptions } = {}) {
  // Allowlist the environment: never inherit auth, ambient NODE_OPTIONS, or global Pi state.
  // Leave generated, ignored directories in place for diagnosis; do not delete files.
  const agentDir = await mkdtemp(resolve(project, ".test-agent-"));
  const args = [
    "--offline", approved ? "--approve" : "--no-approve", "--no-session", "--mode", "rpc",
    "--provider", fixture ? provider : "anthropic",
    "--model", fixture ? "hello" : "claude-haiku-4-5-20251001",
    "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ];
  // The provider fixture is explicit; the project extension MUST auto-discover.
  if (fixture) args.push("-e", resolve(project, "tests/fixtures/hello-provider.ts"));
  const child = spawn("pi", args, {
    cwd: project,
    env: {
      PATH: process.env.PATH, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_TELEMETRY: "0", NODE_DISABLE_COMPILE_CACHE: "1",
      // Set only this fresh child's environment; parallel tests keep their own flags.
      ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }),
      ...(fixture ? { PI_WORKER_THREAD_POC_TEST_PROVIDER: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  const pending = new Map();
  const observers = new Set();
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  let fatalError;
  let hasClosed = false;
  function fail(error) {
    fatalError ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const observer of [...observers]) observer.reject(error);
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  const closed = new Promise((resolveClose) => child.once("close", (code, signal) => {
    hasClosed = true;
    fail(new Error(`Pi exited: ${code}/${signal}\n${stderr}`));
    resolveClose({ code, signal });
  }));
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-10000); });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1_000_000) {
      fail(new Error("Pi stdout record exceeds test limit"));
      child.kill("SIGKILL");
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      // Only LF frames JSONL; Unicode U+2028/U+2029 can occur in JSON strings.
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch (cause) {
        fail(new Error(`Non-JSON Pi stdout: ${line}`, { cause }));
        child.kill("SIGKILL");
        return;
      }
      records.push(record);
      if (records.length > 5000) {
        fail(new Error("Pi record count exceeds test limit"));
        child.kill("SIGKILL");
        return;
      }
      for (const observer of [...observers]) observer.accept(record);
      if (record.type === "response" && pending.has(record.id)) {
        const request = pending.get(record.id);
        pending.delete(record.id);
        clearTimeout(request.timer);
        record.success ? request.resolve(record.data) : request.reject(new Error(record.error));
      }
    }
  });
  function request(type, fields = {}) {
    return new Promise((resolveRequest, reject) => {
      if (fatalError || hasClosed) { reject(fatalError ?? new Error("Pi is closed")); return; }
      const id = String(++nextId);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi ${type} deadline exceeded\n${stderr}`));
      }, 15000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => { if (error) fail(error); });
    });
  }
  function waitForRecord(predicate, start = 0) {
    const found = records.slice(start).find(predicate);
    if (found) return Promise.resolve(found);
    if (fatalError) return Promise.reject(fatalError);
    return new Promise((resolveRecord, reject) => {
      const clean = () => { clearTimeout(timer); observers.delete(observer); };
      const observer = {
        accept(record) { if (predicate(record)) { clean(); resolveRecord(record); } },
        reject(error) { clean(); reject(error); },
      };
      const timer = setTimeout(() => observer.reject(new Error("Pi event deadline exceeded")), 5000);
      observers.add(observer);
    });
  }
  const watchdog = setTimeout(() => {
    fail(new Error("Pi integration watchdog exceeded 40s"));
    child.kill("SIGKILL");
  }, 40000);
  let shutdown;
  const stop = () => shutdown ??= (async () => {
    child.stdin.end(); // Documented graceful RPC shutdown. Only Pi is a child process.
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      assert.deepEqual(await closed, { code: 0, signal: null }, `Pi must exit cleanly on EOF\n${stderr}`);
      assert.equal(buffer, "", "stdout must end at an LF record boundary");
    } finally {
      clearTimeout(timer);
      clearTimeout(watchdog);
      fail(new Error("Test finished"));
    }
  })();
  return { child, records, request, waitForRecord, stop,
    diagnostics() { return { stderr, recent: records.slice(-6) }; },
  };
}

export function reportOf(records, prefix) {
  const matches = records.filter((record) => record.type === "extension_ui_request" &&
    record.method === "notify" && record.message.startsWith(prefix));
  assert.equal(matches.length, 1, `expected one ${prefix}notification`);
  return JSON.parse(matches[0].message.slice(prefix.length));
}

export function assertSelection(report, progress, expected) {
  assert.equal(report.selectedWorker, expected);
  assert.equal(report.workerDefinition, expected, "actual entry identity, not just the host selection");
  assert.equal(report.workerDefinitionMatches, true);
  const filename = expected === "primary" ? "worker.ts" : "worker-secondary.ts";
  assert.equal(report.workerModuleUrl, new URL(`../.pi/extensions/worker-thread-poc/${filename}`, import.meta.url).href);
  assert.equal(progress.selectedWorker, expected);
  assert.equal(progress.workerDefinition, expected);
  assert.equal(progress.workerModuleUrl, report.workerModuleUrl);
  if (report.result) assert.equal(report.result.workerDefinition, expected);
}

export async function assertFileExchange(report) {
  assert.equal(report.workerReadHostFile, true, "worker actually read host.txt");
  assert.equal(report.hostReadWorkerFile, true, "plugin actually read worker.txt");
  const files = report.fileExchange;
  assert.match(files.hostPath, /^\/tmp\/pi-worker-thread-poc-[^/]+\/host\.txt$/);
  assert.equal(files.workerPath, files.hostPath.replace(/host\.txt$/, "worker.txt"));
  assert.match(files.hostWrittenText, /^pi-worker-thread-poc host test [\da-f-]+\n$/);
  assert.match(files.workerWrittenText, /^pi-worker-thread-poc worker test [\da-f-]+\n$/);
  assert.equal(files.workerReadHostText, files.hostWrittenText);
  assert.equal(files.hostReadWorkerText, files.workerWrittenText);
  assert.equal(await readFile(files.hostPath, "utf8"), files.hostWrittenText);
  assert.equal(await readFile(files.workerPath, "utf8"), files.workerWrittenText);
  assert.equal((await stat(files.hostPath)).mode & 0o777, 0o600);
  assert.equal((await stat(files.workerPath)).mode & 0o777, 0o600);
  assert.equal((await stat(new URL(".", `file://${files.hostPath}`))).mode & 0o777, 0o700);
  assert.deepEqual(report.result.fileExchange, {
    hostPath: files.hostPath, workerPath: files.workerPath,
    workerReadHostText: files.workerReadHostText, workerWrittenText: files.workerWrittenText,
  });
}

export function assertIdentity(report, progress, piPid) {
  assert.equal(report.hostPid, piPid);
  assert.equal(report.workerPid, piPid, "Worker threads share the host process PID");
  assert.equal(report.hostThreadId, 0, "Pi extension runs on the main thread");
  assert.equal(report.hostIsMainThread, true);
  assert.ok(Number.isSafeInteger(report.workerThreadId) && report.workerThreadId > 0);
  assert.notEqual(report.workerThreadId, report.hostThreadId);
  assert.equal(progress.workerPid, report.workerPid);
  assert.equal(progress.workerThreadId, report.workerThreadId);
  assert.equal(progress.workerIsMainThread, false);
  assert.equal(typeof progress.token, "string");
  assert.ok(progress.token.length > 0);
  assert.deepEqual(report.callback, {
    hostPid: piPid, hostThreadId: 0, hostIsMainThread: true,
    cwd: project, sessionId: progress.sessionId, token: progress.token,
  });
  // Never process.kill(report.workerPid): it is the live Pi process, not a child.
}
