import assert from "node:assert/strict";
import {
  startPi, project, extension, provider, progressPrefix, resultPrefix, reportOf, assertIdentity,
} from "./pi-client.mjs";

const expectedText = "Hello world from the running Pi session!";
const textOf = (message) => typeof message.content === "string" ? message.content : message.content
  .filter((block) => block.type === "text").map((block) => block.text).join("");
const pi = await startPi({ fixture: true });
try {
  const { commands } = await pi.request("get_commands");
  const command = commands.find((entry) => entry.name === "worker-thread-poc");
  assert.ok(command, "worker-thread-poc project extension must auto-discover");
  assert.equal(command.source, "extension");
  assert.equal(command.sourceInfo.scope, "project");
  assert.equal(command.sourceInfo.path, extension);

  const before = await pi.request("get_state");
  assert.equal(typeof before.sessionId, "string");
  assert.ok(before.sessionId.length > 0);
  assert.equal(before.model.provider, provider, "only the local TEST provider may run");
  assert.equal(before.model.id, "hello");
  assert.equal(before.isStreaming, false);
  assert.equal(before.pendingMessageCount, 0);
  const initial = await pi.request("get_messages");
  assert.deepEqual(initial.messages.filter((message) => ["user", "assistant"].includes(message.role)), []);
  await pi.request("set_auto_retry", { enabled: false });

  const response = await pi.request("prompt", { message: "/worker-thread-poc prompt" });
  assert.equal(response.disposition, "handled", "slash handler awaits Worker and same-session reply");
  const progress = reportOf(pi.records, progressPrefix);
  const report = reportOf(pi.records, resultPrefix);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.error, undefined);
  assertIdentity(report, progress, pi.child.pid);
  assert.equal(progress.sessionId, before.sessionId);
  assert.equal(report.result.workerPid, pi.child.pid);
  assert.equal(report.result.workerThreadId, report.workerThreadId);
  assert.equal(report.result.workerIsMainThread, false);
  assert.equal(report.samePid, true);
  assert.equal(report.differentThread, true);
  assert.deepEqual(report.result.receipt, report.callback, "host callback reply reaches the Worker");
  assert.deepEqual(report.result.snapshot, { cwd: project, sessionId: before.sessionId });
  assert.deepEqual(report.result.promptReply, {
    sessionId: before.sessionId, text: expectedText, stopReason: "stop", aborted: false,
  });
  assert.equal(report.result.output, expectedText, "assistant text returns through RPC to the Worker");

  const after = await pi.request("get_state");
  assert.equal(after.sessionId, before.sessionId, "the running Pi session must not be replaced");
  assert.equal(after.sessionId, report.result.promptReply.sessionId);
  assert.equal(after.sessionId, report.result.snapshot.sessionId);
  assert.equal(after.model.provider, provider);
  assert.equal(after.model.id, "hello");
  assert.equal(after.isStreaming, false);
  assert.equal(after.pendingMessageCount, 0);

  const { messages } = await pi.request("get_messages");
  const users = messages.filter((message) => message.role === "user");
  const assistants = messages.filter((message) => message.role === "assistant");
  assert.equal(users.length, 1, "only the injected user prompt belongs in the conversation");
  assert.equal(textOf(users[0]), "hello world");
  assert.equal(assistants.length, 1);
  assert.equal(textOf(assistants[0]), expectedText);
  assert.equal(assistants[0].provider, provider);
  assert.equal(assistants[0].model, "hello");
  assert.equal(assistants[0].stopReason, "stop");
  const { entries } = await pi.request("get_entries");
  const transcript = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.deepEqual(transcript.filter((message) => message.role === "user").map(textOf), ["hello world"]);
  assert.deepEqual(transcript.filter((message) => message.role === "assistant").map(textOf), [expectedText]);

  assert.equal(pi.records.filter((record) => record.type === "agent_start").length, 1, "one actual Pi agent run");
  assert.equal(pi.records.filter((record) => record.type === "agent_end").length, 1);
  const settled = pi.records.filter((record) => record.type === "agent_settled");
  assert.equal(settled.length, 1, "one settled run, not merely an agent_end");
  assert.equal(settled[0].aborted, false);
  assert.deepEqual(pi.records.filter((record) => record.type === "extension_error"), []);
} catch (error) {
  console.error("Pi diagnostics:", JSON.stringify(pi.diagnostics(), null, 2));
  throw error;
} finally {
  await pi.stop();
}
console.log("PASS same-session hello world: local fixture provider, shared PID, distinct threads, transcript and two-way callback");
