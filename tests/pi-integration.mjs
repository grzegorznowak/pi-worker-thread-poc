import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import {
  startPi, project, extension, progressPrefix, resultPrefix, reportOf, assertIdentity, assertFileExchange, assertSelection,
} from "./pi-client.mjs";

async function verify(approved) {
  const pi = await startPi({ approved });
  try {
    const { commands } = await pi.request("get_commands");
    const command = commands.find((entry) => entry.name === "worker-thread-poc");
    if (!approved) {
      assert.equal(command, undefined, "unapproved project must not load extension");
      console.log("PASS project trust refusal prevents discovery");
    } else {
      assert.ok(command, "project extension must auto-discover");
      assert.equal(command.source, "extension");
      assert.equal(command.sourceInfo.scope, "project");
      assert.equal(command.sourceInfo.path, extension);
      const workerThreads = new Set();
      const sessionId = (await pi.request("get_state")).sessionId;
      // Switch module URLs in one live process/session, without /reload.
      const invocations = [
        ["hello", "primary", "hello"],
        ["--worker secondary hello", "secondary", "hello"],
        ["--worker primary hello", "primary", "hello"],
        ["", "primary", "hello"],
        ...["primary", "secondary"].flatMap((name) =>
          ["", "hello", "fail", "hello after fail", "timeout", "hello after timeout", "crash", "hello after crash", "prompt", "hello again"]
            .map((text) => [`--worker ${name} ${text}`, name, text || "hello"])),
      ];
      // Every failure is followed by a working command in this SAME Pi process.
      for (const [args, selectedWorker, text] of invocations) {
        const start = pi.records.length;
        const response = await pi.request("prompt", { message: `/worker-thread-poc ${args}` });
        assert.equal(response.disposition, "handled", "slash commands must not enter a model run");
        const records = pi.records.slice(start);
        const progress = reportOf(records, progressPrefix);
        const report = reportOf(records, resultPrefix);
        assertIdentity(report, progress, pi.child.pid);
        assertSelection(report, progress, selectedWorker);
        assert.equal((await pi.request("get_state")).sessionId, sessionId, "selection must not replace the session");
        assert.equal(workerThreads.has(report.workerThreadId), false, "each command creates a fresh Worker");
        workerThreads.add(report.workerThreadId);
        const expectedErrors = {
          fail: /Intentional worker failure/,
          timeout: /RPC timeout: run after 750ms/,
          crash: /Worker.*(exited|exit|code=7)/i,
          prompt: /No authentication for provider "anthropic"/,
        };
        if (Object.hasOwn(expectedErrors, text)) {
          assert.equal(report.ok, false);
          assert.equal(report.workerReadHostFile, false);
          assert.equal(report.hostReadWorkerFile, false);
          assert.match(report.error, expectedErrors[text]);
        } else {
          assert.equal(report.ok, true, JSON.stringify(report));
          await assertFileExchange(report);
          assert.equal(report.result.workerPid, report.hostPid);
          assert.equal(report.result.workerThreadId, report.workerThreadId);
          assert.equal(report.result.workerIsMainThread, false);
          assert.equal(report.samePid, true);
          assert.equal(report.differentThread, true);
          assert.deepEqual(report.result.receipt, report.callback, "host callback reply returned to Worker");
          assert.deepEqual(report.result.snapshot, { cwd: project, sessionId: progress.sessionId });
          const transformed = selectedWorker === "primary" ? text.toUpperCase() : [...text].reverse().join("").toUpperCase();
          assert.equal(report.result.output, `${transformed} (host callback token: ${progress.token})`);
          console.log(`SELECTION_EVIDENCE ${JSON.stringify({ sessionId, selectedWorker, workerDefinition: report.workerDefinition,
            workerModuleUrl: report.workerModuleUrl, pid: report.hostPid, threadId: report.workerThreadId,
            output: report.result.output, workerDefinitionMatches: report.workerDefinitionMatches,
            workerReadHostFile: report.workerReadHostFile, hostReadWorkerFile: report.hostReadWorkerFile })}`);
        }
        console.log(`PASS ${args}: shared PID=${report.hostPid}, threads=${report.hostThreadId}/${report.workerThreadId}`);
      }
      const directoriesBefore = (await readdir("/tmp")).filter((name) => name.startsWith("pi-worker-thread-poc-")).sort();
      for (const args of ["--worker", "--worker missing prompt", "--worker ../worker.ts", "--worker=secondary", "--worker primary --worker secondary", "hello --worker secondary"]) {
        const start = pi.records.length;
        const response = await pi.request("prompt", { message: `/worker-thread-poc ${args}` });
        assert.equal(response.disposition, "handled", "invalid options must never fall through to the model");
        const records = pi.records.slice(start);
        const report = reportOf(records, resultPrefix);
        assert.equal(report.ok, false);
        assert.equal(report.workerStarted, false);
        assert.match(report.error, /--worker/);
        assert.equal(report.workerThreadId, undefined);
        assert.equal(report.fileExchange, undefined);
        assert.equal(report.callback, undefined);
        assert.equal(records.some((record) => record.message?.startsWith(progressPrefix)), false);
        assert.equal((await pi.request("get_state")).sessionId, sessionId);
      }
      assert.deepEqual((await readdir("/tmp")).filter((name) => name.startsWith("pi-worker-thread-poc-")).sort(), directoriesBefore,
        "invalid selection must not create any /tmp proof files");
      const recoveryStart = pi.records.length;
      await pi.request("prompt", { message: "/worker-thread-poc --worker secondary" });
      const recoveryRecords = pi.records.slice(recoveryStart);
      const recovery = reportOf(recoveryRecords, resultPrefix);
      assert.equal(recovery.ok, true);
      assertSelection(recovery, reportOf(recoveryRecords, progressPrefix), "secondary");
      assert.match(recovery.result.output, /^OLLEH /, "missing text defaults to hello after invalid selection");
      await assertFileExchange(recovery);
      assert.equal((await pi.request("get_state")).sessionId, sessionId);
      console.log("PASS invalid selections create no Worker/files/model run; same-session secondary recovery");
    }
    assert.equal(pi.records.some((record) => record.type === "agent_start"), false, "no model runs");
    assert.deepEqual(pi.records.filter((record) => record.type === "extension_error"), []);
  } catch (error) {
    console.error("Pi diagnostics:", JSON.stringify(pi.diagnostics(), null, 2));
    throw error;
  } finally {
    await pi.stop();
  }
}

async function verifyStripTypesOverride() {
  // NODE_OPTIONS is read at process startup. A fresh Pi process tests its jiti-loaded
  // extension and actual Worker options, not a duplicate Worker setup in this test.
  const pi = await startPi({ nodeOptions: "--no-experimental-strip-types" });
  try {
    const { commands } = await pi.request("get_commands");
    assert.ok(commands.some((entry) => entry.name === "worker-thread-poc"));
    const start = pi.records.length;
    const response = await pi.request("prompt", { message: "/worker-thread-poc hello" });
    assert.equal(response.disposition, "handled");
    const records = pi.records.slice(start);
    const report = reportOf(records, resultPrefix);
    assert.equal(report.ok, true, `native Worker must override NODE_OPTIONS: ${JSON.stringify(report)}`);
    const progress = reportOf(records, progressPrefix);
    assertIdentity(report, progress, pi.child.pid);
    assertSelection(report, progress, "primary");
    assert.equal(report.samePid, true);
    assert.equal(report.differentThread, true);
    await assertFileExchange(report);
    console.log(`HELLO_FILE_EXCHANGE ${JSON.stringify(report.fileExchange)}`);
    assert.deepEqual(report.result.receipt, report.callback);
    assert.equal(report.result.output, `HELLO (host callback token: ${progress.token})`);
    assert.equal(pi.records.some((record) => record.type === "agent_start"), false, "no model run");
    assert.deepEqual(pi.records.filter((record) => record.type === "extension_error"), []);
    console.log("PASS native Worker overrides NODE_OPTIONS=--no-experimental-strip-types via real Pi CLI");
  } catch (error) {
    console.error("Pi diagnostics:", JSON.stringify(pi.diagnostics(), null, 2));
    throw error;
  } finally {
    await pi.stop();
  }
}

async function verifyActiveShutdown() {
  const pi = await startPi();
  let pending;
  try {
    await pi.request("get_commands");
    const start = pi.records.length;
    // Attach rejection handling before EOF. A pending command may be rejected by shutdown.
    pending = pi.request("prompt", { message: "/worker-thread-poc timeout" }).then(
      (value) => ({ value }), (error) => ({ error }),
    );
    await pi.waitForRecord((record) => record.type === "extension_ui_request" &&
      record.method === "notify" && record.message.startsWith(progressPrefix), start);
    // EOF while the Worker is blocked must terminate the Worker and let Pi exit.
    await pi.stop();
    await pending;
    assert.equal(pi.records.some((record) => record.type === "agent_start"), false);
    console.log("PASS EOF with an active blocked Worker exits cleanly");
  } finally {
    await pi.stop();
    if (pending) await pending;
  }
}

// Run dynamic selection first, then the startup-flag and lifecycle regressions.
await verify(true);
await verifyStripTypesOverride();
await verify(false);
await verifyActiveShutdown();
console.log("PASS real Pi CLI Worker integration; no provider calls or global state changes");
