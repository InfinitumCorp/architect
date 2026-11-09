import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees live under .claude/worktrees; keep their copies of the suite out of this run.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
