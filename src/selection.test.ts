import { describe, expect, it } from "vite-plus/test";
import {
  assertExplicitSelectionNotEmpty,
  assertNamedTargetsBooted,
  bootedNamespaces,
  declaredNamespaces,
  declaredServices,
  droppedNamespaceEdges,
  formatUpCommand,
  namespaceSelected,
  resolveRunningSelection,
  selectFreshUp,
  selectNamedServices,
  selectRunningUp,
  selectSharedDown,
  type DroppedNamespaceEdge,
} from "./selection.js";
import type { ResolvedService, ResolvedStack } from "./stack.js";

const svc = (name: string, namespace?: string | string[]) =>
  namespace === undefined ? { name } : { name, namespace };

describe("namespaceSelected (#128, exact since #176)", () => {
  it("an empty selection selects nothing", () => {
    expect(namespaceSelected(svc("a", "one"), [])).toBe(false);
  });

  it("an unlabelled service is in `default`", () => {
    expect(namespaceSelected(svc("a"), ["default"])).toBe(true);
    expect(namespaceSelected(svc("a"), ["one"])).toBe(false);
  });
});

describe("declaredNamespaces", () => {
  it("lists distinct declared namespaces sorted, `default` for unlabelled", () => {
    expect(declaredNamespaces([svc("a", "x"), svc("b"), svc("c", "x"), svc("d", "y")])).toEqual([
      "default",
      "x",
      "y",
    ]);
  });
});

describe("resolveRunningSelection (ADR-0008)", () => {
  const stack = [svc("a", "one"), svc("b", "two"), svc("c", "two"), svc("web")];

  it("bare up targets exactly the namespaces whose services are all present", () => {
    const sel = resolveRunningSelection(stack, new Set(["a"]), undefined);
    expect(sel.namespaces).toEqual(["one"]);
    expect(sel.services.map((s) => s.name)).toEqual(["a"]);
    expect(sel.notRunning).toEqual([]);
  });

  it("bare up on a fully booted instance targets every namespace", () => {
    const sel = resolveRunningSelection(stack, new Set(["a", "b", "c", "web"]), []);
    expect(sel.namespaces).toEqual(["default", "one", "two"]);
    expect(sel.services.map((s) => s.name)).toEqual(["a", "b", "c", "web"]);
  });

  it("a partly present namespace was not booted, so bare up does not target it", () => {
    const sel = resolveRunningSelection(stack, new Set(["a", "b"]), undefined);
    expect(sel.namespaces).toEqual(["one"]);
  });

  it("explicit -n naming a booted namespace is exact and narrower than what runs", () => {
    const sel = resolveRunningSelection(stack, new Set(["a", "b", "c", "web"]), ["two"]);
    expect(sel.namespaces).toEqual(["two"]);
    expect(sel.services.map((s) => s.name)).toEqual(["b", "c"]);
    expect(sel.notRunning).toEqual([]);
  });

  it("explicit -n naming an unbooted namespace reports it with its missing services (#170)", () => {
    const sel = resolveRunningSelection(stack, new Set(["a"]), ["one", "two"]);
    expect(sel.notRunning).toEqual([{ namespace: "two", missingServices: ["b", "c"] }]);
  });

  it("a requested namespace that declares no service here is not 'not running'", () => {
    const sel = resolveRunningSelection(stack, new Set(["a"]), ["one", "nope"]);
    expect(sel.notRunning).toEqual([]);
    expect(sel.services.map((s) => s.name)).toEqual(["a"]);
  });

  it("duplicate -n values are collapsed", () => {
    const sel = resolveRunningSelection(stack, new Set(["a"]), ["one", "one"]);
    expect(sel.namespaces).toEqual(["one"]);
  });
});

describe("formatUpCommand", () => {
  it("no flags for a stack without named namespaces", () => {
    expect(formatUpCommand([svc("a"), svc("b")], ["default"])).toBe("devtrees up");
  });

  it("an empty selection falls back to every declared namespace, never a bare `up` for a namespaced stack", () => {
    expect(formatUpCommand([svc("a", "one"), svc("b", "two")], [])).toBe(
      "devtrees up -n one -n two",
    );
    expect(formatUpCommand([svc("a")], [])).toBe("devtrees up");
  });

  it("one -n per namespace otherwise", () => {
    expect(formatUpCommand([svc("a", "one"), svc("b")], ["one", "default"])).toBe(
      "devtrees up -n one -n default",
    );
  });
});

describe("list-valued namespaces (ADR-0008, #179)", () => {
  // The issue's example: db shared by two namespaces, api in `two`, web in `one`.
  const stack = [svc("db", ["one", "two"]), svc("api", "two"), svc("web", "one")];

  it("a service is selected when ANY of its namespaces is", () => {
    expect(namespaceSelected(svc("db", ["one", "two"]), ["two"])).toBe(true);
    expect(namespaceSelected(svc("db", ["one", "two"]), ["one"])).toBe(true);
    expect(namespaceSelected(svc("db", ["one", "two"]), ["default"])).toBe(false);
  });

  it("declaredNamespaces flattens every list entry", () => {
    expect(declaredNamespaces([...stack, svc("x")])).toEqual(["default", "one", "two"]);
  });

  it("bare up after `-n two` targets `two` only: `one` is partly present (db yes, web no)", () => {
    const sel = resolveRunningSelection(stack, new Set(["db", "api"]), undefined);
    expect(sel.namespaces).toEqual(["two"]);
    expect(sel.services.map((s) => s.name)).toEqual(["db", "api"]);
  });

  it("-n one on an instance booted with `-n two` is NAMESPACE_NOT_RUNNING naming only web", () => {
    const sel = resolveRunningSelection(stack, new Set(["db", "api"]), ["one"]);
    expect(sel.notRunning).toEqual([{ namespace: "one", missingServices: ["web"] }]);
  });

  it("formatUpCommand spells a list-derived fallback with one -n per namespace", () => {
    expect(formatUpCommand(stack, [])).toBe("devtrees up -n one -n two");
  });
});

describe("droppedNamespaceEdges (#179)", () => {
  const s = (
    name: string,
    namespace: string | string[] | undefined,
    deps: string[] = [],
    tier: "isolated" | "shared" = "isolated",
  ) => ({
    name,
    tier,
    dependsOn: deps.map((d) => ({ name: d })),
    ...(namespace === undefined ? {} : { namespace }),
  });

  it("reports an edge from a selected service to an unselected one, with the target's namespaces", () => {
    const stack = [s("db", ["one", "three"]), s("api", "two", ["db"]), s("web", "one")];
    const selected = stack.filter((x) => namespaceSelected(x, ["two"]));
    expect(droppedNamespaceEdges(stack, selected)).toEqual([
      { from: "api", to: "db", toNamespaces: ["one", "three"] },
    ]);
  });

  it("reports nothing when the target is selected through any of its list entries", () => {
    const stack = [s("db", ["one", "two"]), s("api", "two", ["db"])];
    const selected = stack.filter((x) => namespaceSelected(x, ["two"]));
    expect(droppedNamespaceEdges(stack, selected)).toEqual([]);
  });

  it("ignores edges from unselected services and edges to shared services", () => {
    const stack = [
      s("pg", undefined, [], "shared"),
      s("api", "two", ["pg"]),
      s("web", "one", ["api"]),
    ];
    const selected = stack.filter((x) => x.tier === "isolated" && namespaceSelected(x, ["two"]));
    expect(droppedNamespaceEdges(stack, selected)).toEqual([]);
  });

  it("a target still in the project is kept even when the selection is narrower (running instance)", () => {
    const stack = [s("db", ["one", "two"]), s("api", "two", ["db"]), s("web", "one", ["api"])];
    const selected = stack.filter((x) => namespaceSelected(x, ["one"]));
    // Booted with -n one -n two: api is present, so web -> api was never dropped.
    expect(droppedNamespaceEdges(stack, selected, new Set(["db", "api", "web"]))).toEqual([]);
    // Booted with -n one only: api is absent, so the edge is dropped.
    expect(droppedNamespaceEdges(stack, selected, new Set(["db", "web"]))).toEqual([
      { from: "web", to: "api", toNamespaces: ["two"] },
    ]);
  });

  it("an unlabelled target is reported as being in `default`", () => {
    const stack = [s("db", undefined), s("api", "two", ["db"])];
    expect(droppedNamespaceEdges(stack, stack.slice(1))).toEqual([
      { from: "api", to: "db", toNamespaces: ["default"] },
    ]);
  });
});

// --- the selection module's interface (#253) ---------------------------------
//
// One table per request kind. Each row is a request and what it targets (or
// the selection error it raises, with the code, message and details the CLI
// reports). The rules are ADR-0008 (namespace selection), ADR-0009 (named
// services), ADR-0010 (namespaced shared services) and ADR-0012 (namespaced
// shared teardown).

function service(
  name: string,
  tier: "shared" | "isolated",
  extra: Partial<ResolvedService> = {},
): ResolvedService {
  return {
    name,
    tier,
    command: `run ${name}`,
    ports: [],
    dependsOn: [],
    environment: [],
    ...extra,
  };
}

const on = (...names: string[]) => names.map((name) => ({ name }));

/** A stack with every kind of selection rule in it. */
const ruleStack: ResolvedStack = {
  services: [
    service("web", "isolated"),
    service("db", "isolated", { namespace: ["one", "two"] }),
    service("api", "isolated", { namespace: "two", dependsOn: on("db", "pg") }),
    service("app", "isolated", { namespace: "one", dependsOn: on("api") }),
    service("pg", "shared"),
    service("cache", "shared", { namespace: "two", dependsOn: on("store") }),
    service("store", "shared", { namespace: "data" }),
    service("queue", "shared", { namespace: "jobs" }),
  ],
};

/** The same stack with no `default` service. */
const namespacedStack: ResolvedStack = {
  services: ruleStack.services.filter((s) => s.name !== "web"),
};

const sharedOnly: ResolvedStack = { services: [service("pg", "shared")] };

const namesOf = (services: ReadonlyArray<{ readonly name: string }>) => services.map((s) => s.name);

/** The selection error `fn` throws, as the CLI envelope reads it. */
function selectionError(fn: () => unknown): { code: unknown; message: string; details: unknown } {
  try {
    fn();
  } catch (err) {
    const e = err as Error & { code?: unknown; details?: unknown };
    return { code: e.code, message: e.message, details: e.details };
  }
  throw new Error("expected a selection error");
}

interface UpRow {
  readonly rule: string;
  readonly stack: ResolvedStack;
  readonly requested?: ReadonlyArray<string>;
  readonly namespaces: ReadonlyArray<string>;
  readonly isolated: ReadonlyArray<string>;
  readonly shared: ReadonlyArray<string>;
  readonly dropped?: ReadonlyArray<DroppedNamespaceEdge>;
}

describe("selectFreshUp (ADR-0008, ADR-0010)", () => {
  const rows: UpRow[] = [
    {
      rule: "a bare up selects `default` alone, and the always-on shared services",
      stack: ruleStack,
      namespaces: ["default"],
      isolated: ["web"],
      shared: ["pg"],
    },
    {
      rule: "-n is exact: it never adds `default`",
      stack: ruleStack,
      requested: ["one"],
      namespaces: ["one"],
      isolated: ["db", "app"],
      shared: ["pg"],
      dropped: [{ from: "app", to: "api", toNamespaces: ["two"] }],
    },
    {
      rule: "a namespaced shared service joins with its namespace, its shared dependencies with it",
      stack: ruleStack,
      requested: ["two"],
      namespaces: ["two"],
      isolated: ["db", "api"],
      shared: ["pg", "cache", "store"],
    },
    {
      rule: "a list-valued namespace is selected when any entry is; -n values are forwarded verbatim",
      stack: ruleStack,
      requested: ["two", "one", "two"],
      namespaces: ["two", "one", "two"],
      isolated: ["db", "api", "app"],
      shared: ["pg", "cache", "store"],
    },
    {
      rule: "-n naming one real namespace and one with no services still starts the real one (#203)",
      stack: ruleStack,
      requested: ["one", "nope"],
      namespaces: ["one", "nope"],
      isolated: ["db", "app"],
      shared: ["pg"],
      dropped: [{ from: "app", to: "api", toNamespaces: ["two"] }],
    },
    {
      rule: "a stack with no isolated services starts shared only, never NO_SERVICES_SELECTED",
      stack: sharedOnly,
      namespaces: ["default"],
      isolated: [],
      shared: ["pg"],
    },
  ];

  it.each(rows)("$rule", (row) => {
    const sel = selectFreshUp(row.stack, "wt-1", row.requested);
    expect(sel.namespaces).toEqual(row.namespaces);
    expect(namesOf(sel.isolated)).toEqual(row.isolated);
    expect(namesOf(sel.shared)).toEqual(row.shared);
    expect(sel.droppedNamespaceEdges).toEqual(row.dropped ?? []);
  });

  it("a bare up on a stack with no `default` service is NO_SERVICES_SELECTED (#176)", () => {
    expect(selectionError(() => selectFreshUp(namespacedStack, "wt-1", undefined))).toEqual({
      code: "NO_SERVICES_SELECTED",
      message:
        "devtrees up: no services selected (NO_SERVICES_SELECTED) for 'wt-1'. A bare `devtrees up` " +
        "starts only the `default` namespace (services with no `namespace:`), and this stack has " +
        "none. Available namespaces: one, two. Name the ones to start with -n, e.g. " +
        "`devtrees up -n one` (repeat -n for several).",
      details: {
        worktree_id: "wt-1",
        selected_namespaces: ["default"],
        namespaces: ["one", "two"],
      },
    });
  });

  it("-n naming only namespaces with no isolated service is NO_SERVICES_SELECTED, even one with shared services (#203, #236)", () => {
    const err = selectionError(() => selectFreshUp(ruleStack, "wt-1", ["data", "nope"]));
    expect(err).toEqual({
      code: "NO_SERVICES_SELECTED",
      message:
        "devtrees up: no services selected (NO_SERVICES_SELECTED) for 'wt-1'. `-n data, nope` " +
        "names no namespace with services in this stack. Available namespaces: default, one, two. " +
        "Name the ones to start with -n, e.g. `devtrees up -n default` (repeat -n for several).",
      details: {
        worktree_id: "wt-1",
        selected_namespaces: ["data", "nope"],
        namespaces: ["default", "one", "two"],
      },
    });
  });

  it("assertExplicitSelectionNotEmpty checks an explicit -n only", () => {
    expect(() => assertExplicitSelectionNotEmpty(namespacedStack, "wt-1", undefined)).not.toThrow();
    expect(() => assertExplicitSelectionNotEmpty(namespacedStack, "wt-1", [])).not.toThrow();
    expect(
      selectionError(() => assertExplicitSelectionNotEmpty(ruleStack, "wt-1", ["nope"])).code,
    ).toBe("NO_SERVICES_SELECTED");
  });
});

describe("selectRunningUp (ADR-0008, ADR-0010)", () => {
  const rows: Array<UpRow & { readonly project: ReadonlyArray<{ name: string }> }> = [
    {
      rule: "a bare up targets the namespaces whose services are all in the project",
      stack: ruleStack,
      project: on("db", "api"),
      namespaces: ["two"],
      isolated: ["db", "api"],
      shared: ["pg", "cache", "store"],
    },
    {
      rule: "a partly present namespace was not booted: a list-valued service does not make it look booted",
      stack: ruleStack,
      project: on("web", "db", "api"),
      namespaces: ["default", "two"],
      isolated: ["web", "db", "api"],
      shared: ["pg", "cache", "store"],
    },
    {
      rule: "-n narrower than the boot is exact, and an edge to a target still in the project is kept",
      stack: ruleStack,
      requested: ["one"],
      project: on("web", "db", "api", "app"),
      namespaces: ["one"],
      isolated: ["db", "app"],
      shared: ["pg"],
    },
    {
      rule: "an edge to a target absent from the project is dropped",
      stack: ruleStack,
      project: on("db", "app"),
      namespaces: ["one"],
      isolated: ["db", "app"],
      shared: ["pg"],
      dropped: [{ from: "app", to: "api", toNamespaces: ["two"] }],
    },
    {
      rule: "duplicate -n values collapse; a namespace with no isolated service selects nothing and is not 'not running'",
      stack: ruleStack,
      requested: ["two", "two", "jobs"],
      project: on("db", "api"),
      namespaces: ["two", "jobs"],
      isolated: ["db", "api"],
      shared: ["pg", "cache", "store", "queue"],
    },
    {
      rule: "nothing booted: a bare up targets nothing but the always-on shared services",
      stack: ruleStack,
      project: [],
      namespaces: [],
      isolated: [],
      shared: ["pg"],
    },
  ];

  it.each(rows)("$rule", (row) => {
    const sel = selectRunningUp(row.stack, "wt-1", row.project, row.requested);
    expect(sel.namespaces).toEqual(row.namespaces);
    expect(namesOf(sel.isolated)).toEqual(row.isolated);
    expect(namesOf(sel.shared)).toEqual(row.shared);
    expect(sel.droppedNamespaceEdges).toEqual(row.dropped ?? []);
  });

  it("-n naming a namespace the instance did not boot is NAMESPACE_NOT_RUNNING, naming only the absent services (#170)", () => {
    const err = selectionError(() =>
      selectRunningUp(ruleStack, "wt-1", on("db", "api"), ["one", "two"]),
    );
    expect(err).toEqual({
      code: "NAMESPACE_NOT_RUNNING",
      message:
        "devtrees up: namespace 'one' is not running in 'wt-1' (not started: app). A running " +
        "instance keeps the namespaces it was booted with and cannot add more. Run " +
        "`devtrees down && devtrees up -n one -n two` to boot with them. Nothing was started or stopped.",
      details: {
        worktree_id: "wt-1",
        namespaces: ["one"],
        services: ["app"],
        remedy: "devtrees down && devtrees up -n one -n two",
      },
    });
  });

  it("several unbooted namespaces are named together", () => {
    const err = selectionError(() => selectRunningUp(ruleStack, "wt-1", on("web"), ["one", "two"]));
    expect(err.code).toBe("NAMESPACE_NOT_RUNNING");
    expect(err.message).toContain(
      "namespaces 'one', 'two' are not running in 'wt-1' (not started: db, app, api)",
    );
  });

  it("bootedNamespaces is what a bare up reads back", () => {
    const isolated = ruleStack.services.filter((s) => s.tier === "isolated");
    expect(bootedNamespaces(isolated, new Set(["web", "db", "api"]))).toEqual(["default", "two"]);
  });
});

describe("selectNamedServices / assertNamedTargetsBooted (ADR-0009)", () => {
  const declared = declaredServices({
    app: { namespace: "mobile", depends_on: { api: { condition: "process_healthy" } } },
    api: { namespace: ["backend", "mobile"] },
    web: {},
    cache: { namespace: "edge" },
  });
  const repoShared = [
    { name: "pg" },
    { name: "queue", namespace: "mobile" },
    { name: "cache", namespace: "edge" },
  ];
  const request = (named: string[], namespaces: string[] = []) => ({
    worktreeId: "wt-1",
    command: "restart" as const,
    declared,
    repoShared,
    named,
    namespaces,
  });

  const rows: Array<{
    rule: string;
    named: string[];
    namespaces?: string[];
    isolated: string[];
    skippedShared?: string[];
  }> = [
    {
      rule: "named services in depends_on order, each once",
      named: ["app", "api", "app"],
      isolated: ["api", "app"],
    },
    {
      rule: "-n expands to every isolated service in the namespace (list-valued included); shared ones are skipped",
      named: [],
      namespaces: ["mobile"],
      isolated: ["api", "app"],
      skippedShared: ["queue"],
    },
    {
      rule: "names and -n combine as a union",
      named: ["web"],
      namespaces: ["backend"],
      isolated: ["web", "api"],
    },
    {
      rule: "a name this instance declares is its own service, whatever shared service shares it",
      named: ["cache"],
      namespaces: ["edge"],
      isolated: ["cache"],
    },
  ];

  it.each(rows)("$rule", (row) => {
    const sel = selectNamedServices(request(row.named, row.namespaces));
    expect(namesOf(sel.isolated)).toEqual(row.isolated);
    expect(sel.skippedShared).toEqual(row.skippedShared ?? []);
  });

  it("a shared service is SHARED_SERVICE_REFUSED, checked before unknown names", () => {
    expect(
      selectionError(() => selectNamedServices(request(["pg", "nope", "queue", "pg"]))),
    ).toEqual({
      code: "SHARED_SERVICE_REFUSED",
      message:
        "devtrees restart: 'pg', 'queue' are shared services. The shared instance serves every " +
        "worktree, so devtrees does not restart its services from a worktree. Nothing was " +
        "touched. `devtrees down --shared && devtrees up` restarts the shared instance, for " +
        "every worktree.",
      details: { services: ["pg", "queue"], remedy: "devtrees down --shared && devtrees up" },
    });
  });

  it("an unknown name is SERVICE_NOT_FOUND, listing the derived config's services", () => {
    expect(selectionError(() => selectNamedServices(request(["web", "nope"])))).toEqual({
      code: "SERVICE_NOT_FOUND",
      message:
        "devtrees restart: unknown service 'nope' in this worktree's instance. Valid services: " +
        "app, api, web, cache.",
      details: { service: "nope", valid_services: ["app", "api", "web", "cache"] },
    });
  });

  it("a -n namespace with no isolated service is NO_SERVICES_SELECTED, naming only the empty ones", () => {
    expect(selectionError(() => selectNamedServices(request([], ["mobile", "nope"])))).toEqual({
      code: "NO_SERVICES_SELECTED",
      message:
        "devtrees restart: no services selected (NO_SERVICES_SELECTED) for 'wt-1'. `-n nope` " +
        "names no namespace with isolated services in this instance. Available namespaces: " +
        "backend, default, edge, mobile. Nothing was touched.",
      details: {
        worktree_id: "wt-1",
        selected_namespaces: ["nope"],
        namespaces: ["backend", "default", "edge", "mobile"],
      },
    });
  });

  it("every target booted: passes", () => {
    const req = request(["app"]);
    const sel = selectNamedServices(req);
    expect(() => assertNamedTargetsBooted(req, sel, on("app", "api", "web"))).not.toThrow();
  });

  it("a target the instance did not boot is NAMESPACE_NOT_RUNNING; the remedy keeps the booted namespaces", () => {
    const req = request(["app", "web"]);
    const sel = selectNamedServices(req);
    expect(selectionError(() => assertNamedTargetsBooted(req, sel, on("web", "cache")))).toEqual({
      code: "NAMESPACE_NOT_RUNNING",
      message:
        "devtrees restart: namespace 'mobile' is not running in 'wt-1' (not started: app). A " +
        "running instance keeps the namespaces it was booted with and cannot add more. Run " +
        "`devtrees down && devtrees up -n default -n edge -n mobile` to boot with them. Nothing " +
        "was started or stopped.",
      details: {
        worktree_id: "wt-1",
        namespaces: ["mobile"],
        services: ["app"],
        remedy: "devtrees down && devtrees up -n default -n edge -n mobile",
      },
    });
  });
});

describe("selectSharedDown (ADR-0012)", () => {
  const processes = {
    pg: {},
    sa: { namespace: "a" },
    sb: { namespace: "b" },
    both: { namespace: ["a", "c"] },
  };

  it.each([
    {
      rule: "targets the namespaced shared services of the named namespaces, a list-valued one if any matches",
      namespaces: ["a"],
      targets: ["sa", "both"],
      inactive: [],
    },
    {
      rule: "never targets an always-on shared service, not even with -n default",
      namespaces: ["default"],
      targets: [],
      inactive: ["default"],
    },
    {
      rule: "names a namespace with no shared service as inactive, once",
      namespaces: ["b", "nope", "nope"],
      targets: ["sb"],
      inactive: ["nope"],
    },
    {
      rule: "a namespace only a list-valued target also declares is not inactive",
      namespaces: ["c"],
      targets: ["both"],
      inactive: [],
    },
  ])("$rule", (row) => {
    expect(selectSharedDown(processes, row.namespaces)).toEqual({
      targets: row.targets,
      inactiveNamespaces: row.inactive,
    });
  });

  it("with no shared derived config every named namespace is inactive", () => {
    expect(selectSharedDown(undefined, ["a"])).toEqual({ targets: [], inactiveNamespaces: ["a"] });
  });
});
