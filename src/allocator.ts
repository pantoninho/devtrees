/**
 * Port allocator.
 *
 * Assigns a contiguous **port block** to a worktree by hashing its id to a
 * starting block, then linear-probing forward past any block that collides with
 * an already-registered worktree or whose ports are reported in use. Named ports
 * map to fixed offsets within the block, so a worktree's numbers are derived from
 * its block base and stay stable across restarts once registered.
 *
 * Pure modulo the injected `isFree` probe: hashing and probing are unit-testable
 * without binding real sockets (see CONTEXT.md "Port block", "Allocation registry").
 */

export interface AllocatorOptions {
  /** Lowest port a block may start at. Default per PRD: 20000. */
  readonly portBase: number;
  /** Number of ports per block. Default per PRD: 32. */
  readonly blockSize: number;
}

/** A worktree's allocated block of ports. */
export interface PortBlock {
  readonly base: number;
  /** The concrete port for the named port at `offset` within the block. */
  portFor(offset: number): number;
}

/** A read-only view of the registry: worktree id → its block base. */
export type RegistrySnapshot = Readonly<Record<string, number>>;

/**
 * Reports whether a concrete port is free to bind. Injected so cores stay pure.
 * The default implementation (`defaultIsPortFree` in `port-probe.ts`) is async
 * because the underlying `net.createServer().listen()` bind is async; the seam
 * accepts a sync stub too so unit tests don't need to wrap trivial answers
 * in promises.
 */
export type PortFreeProbe = (port: number) => boolean | Promise<boolean>;

/** Highest valid TCP port; blocks must fit entirely at or below this. */
const MAX_PORT = 65535;

function fnv1a(worktreeId: string): number {
  // FNV-1a — small, stable, dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < worktreeId.length; i++) {
    h ^= worktreeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** How many whole blocks fit between `portBase` and the TCP ceiling. */
function blockCount(options: AllocatorOptions): number {
  const span = MAX_PORT + 1 - options.portBase;
  return Math.max(1, Math.floor(span / options.blockSize));
}

function makeBlock(base: number): PortBlock {
  return { base, portFor: (offset) => base + offset };
}

async function blockIsAvailable(
  base: number,
  blockSize: number,
  taken: ReadonlySet<number>,
  isFree: PortFreeProbe,
): Promise<boolean> {
  if (taken.has(base)) return false;
  for (let port = base; port < base + blockSize; port++) {
    if (!(await isFree(port))) return false;
  }
  return true;
}

/**
 * Allocate (or look up) the port block for `worktreeId`. A block already recorded
 * for this worktree in `snapshot` is returned verbatim — stability across restarts.
 * Otherwise hash to a candidate and probe forward past registered or in-use blocks.
 */
export async function allocateBlock(
  worktreeId: string,
  snapshot: RegistrySnapshot,
  options: AllocatorOptions,
  isFree: PortFreeProbe,
): Promise<PortBlock> {
  const existing = snapshot[worktreeId];
  if (existing !== undefined) return makeBlock(existing);

  const { portBase, blockSize } = options;
  const taken = new Set<number>(Object.values(snapshot));
  const blocks = blockCount(options);
  const startIndex = fnv1a(worktreeId) % blocks;

  for (let step = 0; step < blocks; step++) {
    const base = portBase + ((startIndex + step) % blocks) * blockSize;
    if (await blockIsAvailable(base, blockSize, taken, isFree)) {
      return makeBlock(base);
    }
  }

  throw new Error(`no free port block found for worktree '${worktreeId}'`);
}
