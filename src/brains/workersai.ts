/**
 * Cloudflare Workers AI through the Worker's AI binding: no API key, billed to the account.
 * Presents the binding as an OpenAI chat-completions endpoint so OpenAICompatBrain can use it.
 */

/** The part of the Workers AI binding this adapter uses. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Default: on the Workers Free plan, tool calling, OpenAI-shaped replies. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";

export const WORKERS_AI_BASE_URL = "https://workers-ai.binding/v1";

const reply = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers POST <base>/chat/completions from env.AI.run. Errors come back as HTTP 400 like an API would. */
export function workersAiFetch(ai: AiBinding): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/chat/completions")) return reply(404, { error: { message: "only /chat/completions is served" } });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const { model, ...rest } = body;
    // JSON mode (composing a Score): reasoning models spend the whole budget thinking about a
    // large schema and return no content, so thinking is switched off for these calls.
    if (rest.response_format && rest.chat_template_kwargs === undefined) rest.chat_template_kwargs = { enable_thinking: false };
    const run = (args: Record<string, unknown>) => ai.run(String(model), args);
    let out: unknown;
    try {
      out = await run(rest);
    } catch (err) {
      // Some models reject response_format; JSON is also asked for in the prompt, so retry without it.
      if (!rest.response_format) return reply(errStatus(err), { error: { message: errText(err) } });
      try {
        const { response_format: _drop, ...plain } = rest;
        out = await run(plain);
      } catch (err2) {
        return reply(errStatus(err2), { error: { message: errText(err2) } });
      }
    }
    return reply(200, toChatCompletion(out, String(model)));
  }) as typeof fetch;
}

/** 429 when the free daily allowance is used up (ai-budget's FreeAllowanceUsed), so callers back off; else 400. */
function errStatus(err: unknown) {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 429 ? 429 : 400;
}

function errText(err: unknown) {
  return `Workers AI: ${err instanceof Error ? err.message : String(err)}`;
}

/** Workers AI replies either in OpenAI shape (choices) or as { response, tool_calls, usage }. */
export function toChatCompletion(out: unknown, model: string): Record<string, unknown> {
  const o = (out ?? {}) as Record<string, unknown>;
  if (Array.isArray(o.choices)) return { model, ...o };
  const calls = (Array.isArray(o.tool_calls) ? o.tool_calls : []) as Array<{ id?: string; name?: string; arguments?: unknown; function?: { name: string; arguments: unknown } }>;
  const toolCalls = calls.map((c, i) => {
    const name = c.function?.name ?? c.name ?? "";
    const args = c.function?.arguments ?? c.arguments ?? {};
    return { id: c.id ?? `call_${i}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
  });
  const text = typeof o.response === "string" ? o.response : o.response == null ? null : JSON.stringify(o.response);
  return {
    model,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
        message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      },
    ],
    usage: o.usage,
  };
}
