import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Common demo behavior. The caller passes the live API, with temporary edge typing.
// No transport, singleton import, or connection setup belongs in worker code.
export async function executeTask(input: string, session: any,
  receipt: { token: string }, transform: (text: string) => string): Promise<string> {
  const { text, snapshot, mode, filePaths } = JSON.parse(input);
  if (mode === "fail") throw new Error("Intentional worker failure");
  // In a Worker, process.exit ends this thread, not Pi.
  if (mode === "crash") process.exit(7);
  if (mode === "timeout") return await new Promise<never>(() => {});
  const workerReadHostText = await readFile(filePaths.hostPath, "utf8");
  const workerWrittenText = `pi-worker-thread-poc worker test ${randomUUID()}\n`;
  await writeFile(filePaths.workerPath, workerWrittenText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const promptReply = mode === "prompt" ? await session.prompt({ text: "hello world" }) : undefined;
  return JSON.stringify({
    snapshot, receipt,
    fileExchange: { ...filePaths, workerReadHostText, workerWrittenText },
    output: promptReply ? promptReply.text : `${transform(text)} (host callback token: ${receipt.token})`,
    ...(promptReply ? { promptReply } : {}),
  });
}
