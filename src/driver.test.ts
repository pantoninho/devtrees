import { describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  MissingProcessComposeError,
  buildUpArgs,
  buildDownArgs,
  buildAttachArgs,
  buildLogsArgs,
  createDriver,
  type LogEvent,
} from "./driver.js";

describe("process-compose driver — argv construction", () => {
  const inst = {
    configPath: "/anchor/devtrees/login.yaml",
    socketPath: "/anchor/devtrees/run/login.sock",
  };

  it("starts an instance detached, over its UDS, with the TUI disabled", () => {
    const args = buildUpArgs(inst);
    expect(args).toContain("up");
    expect(args).toContain("-f");
    expect(args).toContain("/anchor/devtrees/login.yaml");
    // unix domain socket control plane (ADR-0001)
    expect(args).toContain("-U");
    expect(args).toContain("-u");
    expect(args).toContain("/anchor/devtrees/run/login.sock");
    // the background server must not grab the terminal
    expect(args).toContain("-t=false");
  });

  it("stops an instance by talking to its UDS", () => {
    const args = buildDownArgs(inst);
    expect(args).toContain("down");
    expect(args).toContain("-U");
    expect(args.join(" ")).toContain("/anchor/devtrees/run/login.sock");
  });

  it("attaches a TUI to an instance over its UDS", () => {
    const args = buildAttachArgs(inst);
    expect(args).toContain("attach");
    expect(args).toContain("-U");
    expect(args.join(" ")).toContain("/anchor/devtrees/run/login.sock");
  });
});

describe("process-compose driver — logs argv", () => {
  const socket = "/anchor/devtrees/run/login.sock";

  it("targets `process logs` over the instance's UDS in raw-log mode", () => {
    const args = buildLogsArgs(socket, "web", {});
    expect(args.slice(0, 3)).toEqual(["process", "logs", "web"]);
    expect(args).toContain("-U");
    expect(args).toContain("-u");
    expect(args).toContain(socket);
    // raw-log so we don't get the process-name prefix; the driver attaches
    // service attribution itself when emitting `LogEvent`s.
    expect(args).toContain("--raw-log");
    // a one-shot read by default — no follow, no tail cap
    expect(args).not.toContain("-f");
    expect(args).not.toContain("-n");
  });

  it("passes -f when follow is set", () => {
    const args = buildLogsArgs(socket, "web", { follow: true });
    expect(args).toContain("-f");
  });

  it("passes -n N when tail is set", () => {
    const args = buildLogsArgs(socket, "web", { tail: 25 });
    const i = args.indexOf("-n");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("25");
  });
});

describe("process-compose driver — streamLogs", () => {
  /** Build a SpawnedProcess that emits the given stdout lines, then exits 0. */
  function fakeChildWithStdout(lines: ReadonlyArray<string>) {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    const stdout = Readable.from(lines.map((l) => `${l}\n`).join(""));
    const stderr = Readable.from("");
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    emitter.kill = () => {
      stdout.destroy();
      stderr.destroy();
    };
    stdout.on("end", () => queueMicrotask(() => emitter.emit("exit", 0)));
    return emitter;
  }

  async function collect(it: AsyncIterable<LogEvent>): Promise<LogEvent[]> {
    const out: LogEvent[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("yields one LogEvent per stdout line, tagged with the service name", async () => {
    const child = fakeChildWithStdout(["first line", "second line"]);
    const driver = createDriver({
      exists: () => Promise.resolve(true),
      // biome-ignore lint/suspicious/noExplicitAny: fake child for test
      spawner: (() => child as any) as never,
    });
    const events = await collect(driver.streamLogs("/a.sock", { service: "web" }));
    expect(events).toHaveLength(2);
    expect(events[0]?.service).toBe("web");
    expect(events[0]?.line).toBe("first line");
    expect(events[0]?.stream).toBe("stdout");
    expect(typeof events[0]?.ts).toBe("string");
    expect(events[1]?.line).toBe("second line");
  });

  it("preserves line content with embedded special characters", async () => {
    const child = fakeChildWithStdout(['payload {"foo":"bar"} done']);
    const driver = createDriver({
      exists: () => Promise.resolve(true),
      // biome-ignore lint/suspicious/noExplicitAny: fake child for test
      spawner: (() => child as any) as never,
    });
    const events = await collect(driver.streamLogs("/a.sock", { service: "web" }));
    expect(events[0]?.line).toBe('payload {"foo":"bar"} done');
  });

  it("refuses to spawn when the binary is missing", async () => {
    const driver = createDriver({
      exists: () => Promise.resolve(false),
      // biome-ignore lint/suspicious/noExplicitAny: fake spawner that should not run
      spawner: (() => {
        throw new Error("should not spawn");
      }) as any,
    });
    await expect(collect(driver.streamLogs("/a.sock", { service: "web" }))).rejects.toBeInstanceOf(
      MissingProcessComposeError,
    );
  });
});

describe("process-compose driver — missing binary", () => {
  it("MissingProcessComposeError carries an actionable, named message", () => {
    const err = new MissingProcessComposeError("process-compose");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/process-compose/);
    expect(err.message).toMatch(/install|PATH/i);
  });

  it("up() refuses to spawn and surfaces the error when the binary is absent", async () => {
    let spawned = false;
    const driver = createDriver({
      exists: () => Promise.resolve(false),
      spawner: () => {
        spawned = true;
        return { on: () => {}, unref: () => {} };
      },
    });
    await expect(
      driver.up({ configPath: "/x.yaml", socketPath: "/x.sock" }),
    ).rejects.toBeInstanceOf(MissingProcessComposeError);
    expect(spawned).toBe(false);
  });
});
