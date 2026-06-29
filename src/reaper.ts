/**
 * Out-of-band resource reaper (issue #148).
 *
 * When a worktree's stack is torn down *after* `git worktree remove` has
 * deleted the worktree directory, process-compose can no longer launch a
 * process's `shutdown.command`: it `chdir`s into the process's `working_dir`
 * (the worktree root) first, that directory is gone, and it silently skips the
 * hook (logging the `chdir` failure at `ERR` only, exiting 0). The hook is the
 * only thing that reaps the service's out-of-band resources (containers,
 * volumes, networks the author started), so they leak — `prune` reports a
 * clean teardown while the heavyweight resources linger.
 *
 * Devtrees still holds the derived config at teardown time. This module runs
 * each process's `shutdown.command` *itself*, socket-free, from a working
 * directory that exists (the anchor / git common dir — never the deleted
 * worktree path), with the process's own embedded `environment:` lines applied
 * so `$DEVTREES_WORKTREE_ID` / `$HOME` / `$XDG_STATE_HOME` and the allocated
 * ports all resolve. The reap is idempotent by design — an already-gone stack's
 * hook reaps nothing.
 *
 * Stays fully generic (ADR-0002): devtrees runs whatever `shutdown.command` the
 * author wrote and learns nothing about Docker / Supabase / compose-project
 * naming. It can only judge the *exit status of the command it runs* — which is
 * exactly the signal `process-compose down` does not give (it exits 0 even when
 * the hook fails to launch), so running the hook directly is what makes a failed
 * reap observable (acceptance #5).
 */

import { spawn } from "node:child_process";
import type { DerivedConfig } from "./deriver.js";

/** Why a hook run did not succeed. */
export type HookFailureReason = "launch" | "exit" | "timeout";

/** Outcome of running a single shutdown hook. */
export type HookResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HookFailureReason; readonly message?: string };

/** One shutdown.command invocation the reaper asks the runner to perform. */
export interface HookRun {
  /** The process the hook belongs to — used for diagnostics. */
  readonly process: string;
  /** The author's `shutdown.command`, run verbatim through the shell. */
  readonly command: string;
  /** A working directory that exists — never the (possibly deleted) `working_dir`. */
  readonly cwd: string;
  /** devtrees' process env merged with the process's embedded `environment:` lines. */
  readonly env: Readonly<Record<string, string>>;
  /** `shutdown.timeout_seconds` in milliseconds, or `undefined` when none was declared. */
  readonly timeoutMs?: number;
}

/** Performs one hook run. Injected so the orchestration is exercisable without a real subprocess. */
export type HookRunner = (run: HookRun) => Promise<HookResult>;

/** A hook that failed, as `reapShutdownHooks` reports it. */
export interface HookFailure {
  readonly process: string;
  readonly command: string;
  readonly reason: HookFailureReason;
  readonly message?: string;
}

/** Aggregate outcome of reaping every shutdown hook in a derived config. */
export interface ReapOutcome {
  /** How many hooks were actually run (processes declaring a `shutdown.command`). */
  readonly ranCount: number;
  /** Every hook that failed to launch, timed out, or exited non-zero. */
  readonly failures: ReadonlyArray<HookFailure>;
}

export interface ReapDeps {
  /**
   * A directory that exists, used as the cwd for every hook — the anchor / git
   * common dir at the call sites. NEVER the worktree path (it may be deleted).
   */
  readonly cwd: string;
  /** Run one hook. Default: a real shell-out via `defaultHookRunner`. */
  readonly run?: HookRunner;
  /** Base environment hooks inherit. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Read a `shutdown.command` string off an opaque shutdown block, or `undefined`. */
function shutdownCommand(
  shutdown: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const command = shutdown?.command;
  return typeof command === "string" && command !== "" ? command : undefined;
}

/** Read `shutdown.timeout_seconds` as a positive millisecond budget, or `undefined`. */
function timeoutMs(shutdown: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const seconds = shutdown?.timeout_seconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : undefined;
}

/** Build a process's hook env: the base env plus its embedded `KEY=VALUE` lines. */
function hookEnv(
  base: Readonly<Record<string, string | undefined>>,
  environment: ReadonlyArray<string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const line of environment) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/**
 * Run every `shutdown.command` declared in `derived`'s processes, from `deps.cwd`,
 * with each process's embedded environment applied. Every hook runs even if a
 * prior one fails (best-effort reclamation — one failed reap must not abandon the
 * rest), and each failure (launch error / non-zero exit / timeout) is collected so
 * the caller can warn (acceptance #5). Processes without a `shutdown.command` are
 * skipped.
 */
export async function reapShutdownHooks(
  derived: DerivedConfig,
  deps: ReapDeps,
): Promise<ReapOutcome> {
  const run = deps.run ?? defaultHookRunner;
  const base = deps.env ?? process.env;
  let ranCount = 0;
  const failures: HookFailure[] = [];

  for (const [name, process_] of Object.entries(derived.processes)) {
    const command = shutdownCommand(process_.shutdown);
    if (command === undefined) continue;
    ranCount++;
    const ms = timeoutMs(process_.shutdown);
    const hookRun: HookRun = {
      process: name,
      command,
      cwd: deps.cwd,
      env: hookEnv(base, process_.environment),
      ...(ms !== undefined ? { timeoutMs: ms } : {}),
    };
    const result = await run(hookRun);
    if (!result.ok) {
      failures.push({
        process: name,
        command,
        reason: result.reason,
        ...(result.message !== undefined ? { message: result.message } : {}),
      });
    }
  }

  return { ranCount, failures };
}

/**
 * Default hook runner: spawn the command through `/bin/sh -c` from `run.cwd`
 * with `run.env`, kill it (SIGKILL) if it overruns `run.timeoutMs`, and classify
 * the outcome. A spawn error is `launch`, a timeout is `timeout`, a non-zero exit
 * is `exit`; exit 0 (or a null code from a clean signal) is success.
 */
function defaultHookRunner(run: HookRun): Promise<HookResult> {
  return new Promise<HookResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", run.command], {
      cwd: run.cwd,
      env: { ...run.env },
      stdio: "ignore",
    });
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (run.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, run.timeoutMs);
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, reason: "launch", message: err.message });
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, reason: "timeout", message: `timed out after ${run.timeoutMs}ms` });
        return;
      }
      if (code === 0 || code === null) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, reason: "exit", message: `exited with code ${code}` });
    });
  });
}
