import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileExchangePaths, FileExchangeReceipt } from "./contracts.ts";

// Keep preparation and verification separate from Pi so tests can check false receipts.
export type PreparedFileExchange = FileExchangePaths & { hostWrittenText: string };

export async function createFileExchange(): Promise<PreparedFileExchange> {
  // mkdtemp creates a private (0700) directory. Never reuse or delete it.
  const directory = await mkdtemp("/tmp/pi-worker-thread-poc-");
  const hostPath = join(directory, "host.txt");
  const workerPath = join(directory, "worker.txt");
  // No command text, model output, session data, or credentials belong in these files.
  const hostWrittenText = `pi-worker-thread-poc host test ${randomUUID()}\n`;
  await writeFile(hostPath, hostWrittenText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { hostPath, workerPath, hostWrittenText };
}

export async function verifyFileExchange(prepared: PreparedFileExchange, receipt: FileExchangeReceipt) {
  // Read our original path, never a path substituted by a worker receipt.
  const hostReadWorkerText = await readFile(prepared.workerPath, "utf8");
  return {
    workerReadHostFile: receipt.hostPath === prepared.hostPath
      && receipt.workerReadHostText === prepared.hostWrittenText,
    hostReadWorkerFile: receipt.workerPath === prepared.workerPath
      && receipt.workerWrittenText.length > 0 && hostReadWorkerText === receipt.workerWrittenText,
    fileExchange: {
      ...prepared,
      workerReadHostText: receipt.workerReadHostText,
      workerWrittenText: receipt.workerWrittenText,
      hostReadWorkerText,
    },
  };
}
