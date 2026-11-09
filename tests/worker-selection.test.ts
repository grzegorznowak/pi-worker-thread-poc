import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation, workerModuleUrl } from "../.pi/extensions/worker-thread-poc/worker-selection.ts";

for (const [args, selectedWorker, text, mode] of [
  ["", "primary", "hello", "normal"],
  ["   ", "primary", "hello", "normal"],
  ["hello", "primary", "hello", "normal"],
  ["  hello  world\nnext  ", "primary", "hello  world\nnext", "normal"],
  ["--worker secondary hello", "secondary", "hello", "normal"],
  ["--worker primary hello", "primary", "hello", "normal"],
  ["--worker secondary", "secondary", "hello", "normal"],
  [" --worker\tprimary  ", "primary", "hello", "normal"],
  ["--worker secondary  hello  world\nnext", "secondary", "hello  world\nnext", "normal"],
  ["worker secondary", "primary", "worker secondary", "normal"],
  ["--workerish hello", "primary", "--workerish hello", "normal"],
  ["prompt more text", "primary", "prompt more text", "normal"],
] as const) {
  test(`parse invocation ${JSON.stringify(args)}`, () => {
    assert.deepEqual(parseInvocation(args), { selectedWorker, text, mode });
  });
}

for (const selectedWorker of ["primary", "secondary"] as const) {
  for (const mode of ["prompt", "fail", "timeout", "crash"] as const) {
    test(`parse ${selectedWorker} ${mode}`, () => {
      assert.deepEqual(parseInvocation(`--worker ${selectedWorker} ${mode}`), { selectedWorker, text: mode, mode });
    });
  }
}

for (const args of [
  "--worker", "--worker  ", "--worker missing", "--worker missing prompt",
  "--worker ../worker.ts", "--worker file:///tmp/worker.ts", "--worker __proto__",
  "--worker constructor", "--worker Secondary", "--worker --other hello",
  "--worker=secondary hello", "--worker=", "--worker primary --worker secondary hello",
  "hello --worker secondary", "--worker primary hello --worker", "hello --worker=bad",
]) {
  test(`reject option error ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseInvocation(args), /--worker/);
  });
}

test("trusted built-in names resolve to distinct native TypeScript entries", () => {
  assert.equal(workerModuleUrl("primary").pathname.endsWith("/worker.ts"), true);
  assert.equal(workerModuleUrl("secondary").pathname.endsWith("/worker-secondary.ts"), true);
  assert.notEqual(workerModuleUrl("primary").href, workerModuleUrl("secondary").href);
});
