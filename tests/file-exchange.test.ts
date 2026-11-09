import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createFileExchange, verifyFileExchange } from "../.pi/extensions/worker-thread-poc/file-exchange.ts";

async function fixture() {
  const prepared = await createFileExchange();
  const workerWrittenText = "pi-worker-thread-poc verifier test worker text\n";
  await writeFile(prepared.workerPath, workerWrittenText, { flag: "wx", mode: 0o600 });
  const receipt = { hostPath: prepared.hostPath, workerPath: prepared.workerPath,
    workerReadHostText: prepared.hostWrittenText, workerWrittenText };
  return { prepared, receipt };
}

test("verifier rejects false host readback without losing independent worker read", async () => {
  const { prepared, receipt } = await fixture();
  const proof = await verifyFileExchange(prepared, { ...receipt, workerReadHostText: "wrong test text" });
  assert.equal(proof.workerReadHostFile, false);
  assert.equal(proof.hostReadWorkerFile, true);
});

test("verifier rejects receipt text that differs from actual worker file", async () => {
  const { prepared, receipt } = await fixture();
  const proof = await verifyFileExchange(prepared, { ...receipt, workerWrittenText: "false receipt" });
  assert.equal(proof.workerReadHostFile, true);
  assert.equal(proof.hostReadWorkerFile, false);
  assert.equal(proof.fileExchange.hostReadWorkerText, await readFile(prepared.workerPath, "utf8"));
});

test("verifier rejects substituted paths even when reported contents match", async () => {
  const { prepared, receipt } = await fixture();
  const proof = await verifyFileExchange(prepared, {
    ...receipt, hostPath: `${prepared.hostPath}.other`, workerPath: `${prepared.workerPath}.other`,
  });
  assert.equal(proof.workerReadHostFile, false);
  assert.equal(proof.hostReadWorkerFile, false);
  assert.equal(proof.fileExchange.hostPath, prepared.hostPath);
  assert.equal(proof.fileExchange.workerPath, prepared.workerPath);
});

test("verifier rejects a missing worker file instead of trusting its receipt", async () => {
  const prepared = await createFileExchange();
  await assert.rejects(verifyFileExchange(prepared, {
    hostPath: prepared.hostPath, workerPath: prepared.workerPath,
    workerReadHostText: prepared.hostWrittenText, workerWrittenText: "never written",
  }), /ENOENT/);
});

test("file exchange creation keeps separate runs in separate directories", async () => {
  const first = await createFileExchange();
  const second = await createFileExchange();
  assert.notEqual(first.hostPath, second.hostPath);
  assert.notEqual(first.workerPath, second.workerPath);
  assert.notEqual(first.hostWrittenText, second.hostWrittenText);
});
