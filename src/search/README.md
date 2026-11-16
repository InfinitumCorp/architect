# Infinitum Search

Perplexity-style web search for every Infinitum product. Someone types **`@search <question>`** in a chat, Ask or compose box, or uses the product's search box. Infinitum Search then:

1. Finds pages on the web.
2. Reads the best ones.
3. Writes a short answer with numbered citations `[1]`, `[2]` that link to its sources.

`search.mjs` has no dependencies and runs on Node 18+, Cloudflare Workers, Deno and Bun. Copies in product repos are synced from this file.

## Wire it into a product (server side)

```js
import { searchRoutesFromEnv } from "./search/search.mjs";
const search = searchRoutesFromEnv(env);                  // off until a search engine is set
// after the product's own Cumulus ID sign-in:
const res = await search(request, { user: signedInId, context: "what the person is looking at" });
if (res) return res;                                       // null for paths it doesn't own
```

- `GET /api/search` returns `{ connected, engines, answers }`.
- `POST /api/search { query }` runs a search from the search box.
- `POST /api/search { text }` handles a chat message. It returns `{ mention: false }`, or `{ mention: true, query, answer, cited, sources, engine, read }` when the text contains `@search`.

To write answers with the product's own `@infinitum/ai` router, pass `chat: (messages) => …`.

## Settings

| Variable | What it does |
| --- | --- |
| `VEIL_SEARCH_URL` | Infinitum's own engine: `https://infinitumveil.app/api/search`. VEILBot's index first, blended with the web APIs VEIL holds keys for, Hacker News, Stack Overflow and Wikipedia. Needs no key here. |
| `SEARXNG_URL` | Self-hosted SearXNG with `json` in `search.formats`. Host it on the Yandex VM for Russia. |
| `EXA_API_KEY` | [Exa](https://exa.ai) web search (Infinitum has $1,000 startup credits, valid to 2027-11-13). The query goes to Exa in a POST body. On whenever the key is set; `EXA_SEARCH=off` turns it off. |
| `YANDEX_SEARCH_API_KEY`, `YANDEX_FOLDER_ID` | Yandex Search API v2. The service account needs `search-api.webSearch.user`. Works in Russia. |
| `BRAVE_SEARCH_API_KEY` | Brave Search API. |
| `AI_BASE_URL` (+ `AI_API_KEY`, `AI_MODEL`) or `OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY` | The open-weight model that writes the answers. `SEARCH_MODEL` overrides the model. Set `SEARCH_ANSWERS=off` to return sources only. |

Engines are tried in the order above, and the next one takes over if one fails. Keys stay on the server and never reach a browser.

## Safety

- **Fetching:** only public `http(s)` pages on ports 80/443. Every redirect is re-checked, and private, loopback, link-local and metadata addresses are refused. Pages are capped at 1.5 MB and 7 s.
- **robots.txt:** respected for `InfinitumSearch` (else `*`), matched the way Google's open-source parser does it ([google/robotstxt](https://github.com/google/robotstxt), Apache-2.0, ported to JS with its conformance tests): merged groups, longest match with Allow winning ties, `*` and `$`, %-normalised patterns, common typos accepted.
- **Page content:** passed to the model as data, never as instructions. Citations to sources that don't exist are removed.
- **Limits:** each person gets 12 searches a minute per server instance.
