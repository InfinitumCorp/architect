// Shared by the local workspace and the cloud GitHub instrument (no Node imports).

/** A compact line diff for review: the changed region with a little context. */
export function lineDiff(before: string, after: string, file: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const out = [`--- a/${file}`, `+++ b/${file}`, `@@ -${from + 1} +${from + 1} @@`];
  for (let i = from; i < start; i++) out.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) out.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 1 + context); i++) out.push(` ${a[i]}`);
  return out.join("\n");
}
