/**
 * process-compose driver (adapter).
 *
 * The thin shell-out boundary between devtrees and the external `process-compose`
 * binary. Each instance is controlled over its own unix domain socket under the
 * anchor's run dir (ADR-0001). The argv builders are pure and unit-tested; the
 * spawning side effects and the binary locator are injected so the orchestration
 * can be exercised against a stub `process-compose` in e2e tests.
 */

import { spawn, type SpawnOptions } from "node:child_process";

/** Identifies one process-compose instance: its derived config and control socket. */
export interface InstanceRef {
  readonly configPath: string;
  readonly socketPath: string;
}

/** Raised when the `process-compose` binary cannot be found on PATH. */
export class MissingProcessComposeError extends Error {
  constructor(binary: string) {
    super(
      `${binary} not found. devtrees shells out to process-compose and does not embed it. ` +
        `Install it and ensure it is on your PATH: https://f1bonacc1.github.io/process-compose/installation/`,
    );
    this.name = "MissingProcessComposeError";
  }
}

/** Start the instance's server detached, over its UDS, with the TUI disabled. */
export function buildUpArgs(inst: InstanceRef): string[] {
  return ["up", "-f", inst.configPath, "-U", "-u", inst.socketPath, "-t=false"];
}

/** Stop the running instance by talking to its UDS. */
export function buildDownArgs(inst: InstanceRef): string[] {
  return ["down", "-U", "-u", inst.socketPath];
}

/** Attach a TUI to the running instance over its UDS. */
export function buildAttachArgs(inst: InstanceRef): string[] {
  return ["attach", "-U", "-u", inst.socketPath];
}

/** Minimal child-process surface the driver relies on. */
export interface SpawnedProcess {
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number | null) => void): void;
  unref?(): void;
}

/** Spawn a process-compose subprocess. Injected so tests can stub it. */
export type Spawner = (
  binary: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedProcess;

export interface DriverDeps {
  /** Path/name of the process-compose binary. Default: "process-compose". */
  readonly binary?: string;
  /**
   * Args prepended before the process-compose subcommand. Lets a test run a stub
   * via an interpreter (e.g. `node stub.mjs <args>`); empty for the real binary.
   */
  readonly prefixArgs?: ReadonlyArray<string>;
  /** Resolve whether `binary` exists on PATH. Default: probes the real PATH. */
  readonly exists?: (binary: string) => Promise<boolean>;
  readonly spawner?: Spawner;
}

async function ensureBinary(deps: Required<Pick<DriverDeps, "binary" | "exists">>): Promise<void> {
  if (!(await deps.exists(deps.binary))) {
    throw new MissingProcessComposeError(deps.binary);
  }
}

/** Probe PATH for a binary by attempting to spawn it with `--version`. */
function defaultExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(true));
  });
}

/**
 * A driver bound to a binary + spawner. Operations start/stop a per-instance
 * server and attach a TUI, each over the instance's UDS.
 */
export function createDriver(deps: DriverDeps = {}) {
  const binary = deps.binary ?? "process-compose";
  const prefix = deps.prefixArgs ?? [];
  const exists = deps.exists ?? defaultExists;
  const spawner = deps.spawner ?? (spawn as unknown as Spawner);

  async function run(args: string[], options: SpawnOptions): Promise<void> {
    await ensureBinary({ binary, exists });
    await new Promise<void>((resolve, reject) => {
      const child = spawner(binary, [...prefix, ...args], options);
      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`${binary} ${args[0]} exited with code ${code}`));
      });
    });
  }

  return {
    /** Start the worktree instance's server in the background. */
    async up(inst: InstanceRef): Promise<void> {
      await ensureBinary({ binary, exists });
      const child = spawner(binary, [...prefix, ...buildUpArgs(inst)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref?.();
    },
    /** Stop the running instance. */
    down(inst: InstanceRef): Promise<void> {
      return run(buildDownArgs(inst), { stdio: "inherit" });
    },
    /** Attach a TUI to the running instance. */
    attach(inst: InstanceRef): Promise<void> {
      return run(buildAttachArgs(inst), { stdio: "inherit" });
    },
  };
}
