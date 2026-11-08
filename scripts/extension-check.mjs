// Static checks for extension/ before it is zipped (also run by the tests).
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const KEY_PATTERNS = [/sk-ant-[\w-]{10,}/, /sk-[A-Za-z0-9]{20,}/, /SUPABASE_SERVICE_ROLE/, /eyJhbGciOi[\w-]{20,}\.[\w-]{20,}/];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Returns a list of problems; empty means the extension is ready to zip. */
export async function checkManifest(dir) {
  const problems = [];
  const m = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  if (m.manifest_version !== 3) problems.push("manifest_version must be 3");
  if (!/^\d+(\.\d+){0,3}$/.test(m.version ?? "")) problems.push("version must be 1-4 dot-separated integers");
  if (!m.name || m.name.length > 75) problems.push("name is required and at most 75 characters");
  if (!m.description || m.description.length > 132) problems.push("description is required and at most 132 characters");
  const referenced = [
    ...Object.values(m.icons ?? {}),
    ...Object.values(m.action?.default_icon ?? {}),
    m.side_panel?.default_path,
    m.options_page,
    m.action?.default_popup,
    m.background?.service_worker,
  ].filter(Boolean);
  for (const f of referenced) if (!(await exists(path.join(dir, f)))) problems.push(`missing file: ${f}`);
  if (!m.icons?.["128"]) problems.push("a 128px icon is required for the Web Store");
  // Every script and stylesheet an HTML page loads must exist (MV3 forbids remote code).
  for (const page of referenced.filter((f) => f.endsWith(".html"))) {
    const html = await readFile(path.join(dir, page), "utf8");
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/^https?:/.test(ref)) {
        if (/<script[^>]+src="https?:/.test(html)) problems.push(`${page} loads a remote script`);
        continue;
      }
      if (!(await exists(path.join(dir, path.dirname(page), ref)))) problems.push(`${page} references missing ${ref}`);
    }
    if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) problems.push(`${page} has an inline script (blocked by the MV3 CSP)`);
  }
  // No secrets may ship inside the package.
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(js|json|html|css)$/.test(e.name)) {
        const text = await readFile(full, "utf8");
        for (const re of KEY_PATTERNS) if (re.test(text)) problems.push(`${path.relative(dir, full)} looks like it contains a secret`);
      }
    }
  };
  await walk(dir);
  return problems;
}
