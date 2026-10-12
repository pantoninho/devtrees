import { describe, expect, it } from "vite-plus/test";
import {
  declaredNamespaces,
  droppedNamespaceEdges,
  formatUpCommand,
  namespaceSelected,
  resolveRunningSelection,
} from "./selection.js";

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
