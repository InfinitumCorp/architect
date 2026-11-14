# Langfuse tracing

`src/brains/ai-langfuse.mjs` (zero dependencies, same file as scalvs-ai `api/_ai-langfuse.mjs`) wraps the Workers AI
binding after `budgetedAI` in two places: the hosted Conductor brain (`src/worker.ts`) and the free model at
`/free/v1` (`src/free.ts`, product `architect-free`). Each call is one OpenTelemetry generation span: model, latency,
token usage, error.

- `POST {LANGFUSE_BASE_URL}/api/public/otel/v1/traces`, OTLP/HTTP JSON, `x-langfuse-ingestion-version: 4`
  (the legacy `/api/public/ingestion` trace events are shut off by Langfuse Cloud on 2026-11-16).
- On whenever `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` are Worker secrets; `LANGFUSE=off` disables it.
- Metadata only by default; `LANGFUSE_CAPTURE_CONTENT=on` adds prompts and replies (8 KB cap). No user ids or IPs.
- Sent with `waitUntil`, 3 s timeout, errors swallowed: tracing never fails or slows a run.
- Not traced yet: `architect serve` / desktop brains (Claude, OpenAI-compatible, OmniRoute) in Node.
- Plan: Langfuse Hobby (free). Coupon STARTUP-LF-50 only for a future upgrade, with William's OK.
