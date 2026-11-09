import { describe, expect, it } from "vitest";
import { postgresCaller, SupabaseRunStore } from "../src/stores/supabase.js";

function fakeSql(result: unknown) {
  const calls: Array<{ q: string; p: unknown[] }> = [];
  return { calls, unsafe: async (q: string, p: unknown[] = []) => (calls.push({ q, p }), [{ r: result }]) };
}

describe("postgresCaller", () => {
  it("binds arguments as parameters with jsonb/int/text casts", async () => {
    const sql = fakeSql(null);
    await postgresCaller(sql)("architect_save_run", { p_run: { id: "run_x", n: 1 } });
    await postgresCaller(sql)("architect_list_runs", { p_limit: 5 });
    await postgresCaller(sql)("architect_get_file", { p_run_id: "run_x", p_path: "a.png" });
    await postgresCaller(sql)("architect_put_file", { p_run_id: "run_x", p_path: "a.png", p_base64: "AAAA" });
    expect(sql.calls[0]).toEqual({ q: "select public.architect_save_run(p_run => $1::text::jsonb) as r", p: ['{"id":"run_x","n":1}'] });
    expect(sql.calls[1]!.q).toBe("select public.architect_list_runs(p_limit => $1::int) as r");
    expect(sql.calls[3]!.q).toBe("select public.architect_put_file(p_run_id => $1::text, p_path => $2::text, p_base64 => $3::text) as r");
    expect(sql.calls[2]).toEqual({ q: "select public.architect_get_file(p_run_id => $1::text, p_path => $2::text) as r", p: ["run_x", "a.png"] });
  });

  it("refuses anything but the architect functions and odd argument names", async () => {
    const call = postgresCaller(fakeSql(null));
    await expect(call("pg_read_file", { p_x: "1" })).rejects.toThrow(/not an Architect function/);
    await expect(call("architect_get_run", { "p_id); drop table x; --": "1" })).rejects.toThrow(/bad argument name/);
  });

  it("drives SupabaseRunStore end to end", async () => {
    const sql = fakeSql([{ id: "run_a", createdAt: "2026-11-08", score: {} }]);
    const store = new SupabaseRunStore({ call: postgresCaller(sql) });
    expect(await store.list(1)).toEqual([{ id: "run_a", createdAt: "2026-11-08", score: {} }]);
    const parsed = new SupabaseRunStore({ call: postgresCaller(fakeSql('[{"id":"run_b"}]')) });
    expect(await parsed.list(1)).toEqual([{ id: "run_b" }]);
  });
});
