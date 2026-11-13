import { describe, expect, it } from "vitest";
import { withImplied } from "../src/types.js";

describe("implied permissions", () => {
  it("adds read access to write, shell and http.write, in canonical order", () => {
    expect(withImplied(["shell"])).toEqual(["workspace.read", "shell"]);
    expect(withImplied(["workspace.write"])).toEqual(["workspace.read", "workspace.write"]);
    expect(withImplied(["http.write", "browser"])).toEqual(["browser", "http.read", "http.write"]);
  });

  it("adds nothing to read-only or unrelated permissions", () => {
    expect(withImplied(["workspace.read", "browser"])).toEqual(["browser", "workspace.read"]);
    expect(withImplied([])).toEqual([]);
  });
});
