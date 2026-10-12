/**
 * Driver integration tests for `reloadConfig`'s default transport.
 *
 * `reloadConfig` talks to process-compose's REST API over the instance's
 * unix socket (issue #194). These tests stand up a real HTTP server on a
 * short-path UDS that answers like process-compose's
 * `POST /project/configuration`, and drive the driver's default requester
 * against it: the happy path, a refusal, a server that never answers, and
 * a socket nobody listens on.
 *
 * Kept separate from the pure `driver.test.ts` unit tests so this file's
 * scope is "do real socket round-trips work".
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createDriver } from "./driver.js";

const SHORT_TMP = process.platform === "darwin" ? "/tmp" : (process.env.RUNNER_TEMP ?? "/tmp");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** A fresh instance layout; nothing listens on its socket yet. */
function makeInstance(): { configPath: string; socketPath: string } {
  const root = mkdtempSync(join(SHORT_TMP, "dt-reload-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { configPath: join(root, "login.yaml"), socketPath: join(root, "login.sock") };
}

/** Serve `handler` on `socketPath`; records every `METHOD path` it receives. */
async function serve(
  socketPath: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string[]> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return seen;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("driver.reloadConfig — HTTP over the control socket", () => {
  it("happy path: POSTs /project/configuration and returns ok:true on a 200", async () => {
    const inst = makeInstance();
    const seen = await serve(inst.socketPath, (_req, res) => json(res, 200, { web: "updated" }));
    const result = await createDriver().reloadConfig(inst);
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["POST /project/configuration"]);
  });

  it("a 400 from process-compose is reason:error with its complaint", async () => {
    const inst = makeInstance();
    await serve(inst.socketPath, (_req, res) => json(res, 400, { error: "bad config" }));
    expect(await createDriver().reloadConfig(inst)).toEqual({
      ok: false,
      reason: "error",
      message: "process-compose config reload answered HTTP 400: bad config",
    });
  });

  it("a server that never answers is aborted at the budget: reason:timeout", async () => {
    const inst = makeInstance();
    await serve(inst.socketPath, () => {
      // Like an update stuck on an old process that never exits: no answer.
    });
    const result = await createDriver({ reloadTimeoutMs: 100 }).reloadConfig(inst);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("a socket nobody listens on is reason:error", async () => {
    const inst = makeInstance();
    const result = await createDriver().reloadConfig(inst);
    expect(result).toMatchObject({ ok: false, reason: "error" });
    if (result.ok) throw new Error("expected ok:false");
    expect(result.message).toMatch(/ENOENT|ECONNREFUSED/);
  });
});
