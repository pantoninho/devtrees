import { describe, expect, it } from "vite-plus/test";
import {
  declaredNamespaces,
  formatUpCommand,
  namespaceSelected,
  resolveRunningSelection,
} from "./selection.js";

const svc = (name: string, namespace?: string) =>
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

  it("one -n per namespace otherwise", () => {
    expect(formatUpCommand([svc("a", "one"), svc("b")], ["one", "default"])).toBe(
      "devtrees up -n one -n default",
    );
  });
});
