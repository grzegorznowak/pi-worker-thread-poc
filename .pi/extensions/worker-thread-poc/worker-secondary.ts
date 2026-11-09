import { startWorker } from "./worker-runtime.ts";

// A separate native TypeScript entry, not a host-selected runtime behavior flag.
startWorker({ name: "secondary", transform: (text) => [...text].reverse().join("").toUpperCase() });
