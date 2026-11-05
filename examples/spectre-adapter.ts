/**
 * Example: +SPCTR (Spectre) exposing CRM actions to /CNDCTR/, and raising a renewal-risk signal.
 *
 *   npx tsx examples/spectre-adapter.ts
 *   # then point Conductor at it:
 *   CNDCTR_PRODUCT_SPECTRE_URL=http://localhost:7401 CNDCTR_PRODUCT_SPECTRE_TOKEN=dev-spectre node dist/cli.js serve
 *
 * The CRM here is an in-memory stand-in; a real Spectre wires these actions to its own services.
 */
import { createServer } from "node:http";
import { createActionHandler } from "../src/adapter.js";
import { CndctrClient } from "../src/sdk.js";

const accounts = new Map([
  ["acme", { name: "Acme Corp", owner: "dana@acme.example", plan: "Team", usageTrend: "-40% over 60 days", renewal: "2026-12-01" }],
  ["globex", { name: "Globex", owner: "sam@globex.example", plan: "Enterprise", usageTrend: "+12%", renewal: "2027-03-15" }],
]);
const drafts: Array<{ to: string; subject: string; body: string }> = [];

const handler = createActionHandler({
  token: process.env.SPECTRE_TOKEN ?? "dev-spectre",
  actions: {
    find_account: {
      description: "Look up an account by key or name. payload: { query }",
      risk: "read",
      run: ({ query }) => {
        const q = String(query ?? "").toLowerCase();
        return [...accounts.entries()].filter(([k, a]) => k.includes(q) || a.name.toLowerCase().includes(q)).map(([k, a]) => ({ key: k, ...a }));
      },
    },
    draft_followup: {
      description: "Save a follow-up email as a draft for the account owner to review. Not sent. payload: { to, subject, body }",
      risk: "write",
      run: ({ to, subject, body }) => {
        if (!to || !subject || !body) throw new Error("to, subject and body are required");
        drafts.push({ to: String(to), subject: String(subject), body: String(body) });
        return { draftId: drafts.length, status: "draft" };
      },
    },
    list_drafts: {
      description: "List follow-up drafts. payload: {}",
      risk: "read",
      run: () => drafts,
    },
  },
});

const port = Number(process.env.PORT ?? 7401);
createServer(async (req, res) => {
  if (await handler(req, res)) return;
  res.writeHead(404).end();
}).listen(port, async () => {
  console.log(`Spectre adapter on http://localhost:${port}/cndctr/v1/actions`);
  if (process.env.CNDCTR_URL) {
    // Spectre spotted something: hand it to Conductor as a signal.
    const cndctr = new CndctrClient({ baseUrl: process.env.CNDCTR_URL, token: process.env.CNDCTR_TOKEN });
    const res = await cndctr.signal("spectre", "renewal_risk", { account: "Acme Corp", owner: "dana@acme.example", reason: "usage down 40% in 60 days" });
    console.log("signal sent:", res);
  }
});
