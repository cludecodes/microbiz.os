import { defineConfig } from "vitest/config";

// Plain vitest for unit logic. The full-stack integration suite lives in
// test/smoke.mjs, which boots a real `wrangler dev` worker with migrated
// local D1 and exercises the HTTP surface end-to-end (works on any platform).
export default defineConfig({});
