# The SCALVS gateway (what `@scalvs` talks to)

`@scalvs` in the Architect app goes to `POST /v1/openclaw` on the Worker, which calls an
OpenClaw gateway with the `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` Worker secrets.
This page records how that gateway is run. It holds no secrets.

## Where it runs

| Piece | Setting |
|---|---|
| Host | `infinitum-product-1` (Ubuntu 24.04), next to the VEIL node |
| User | `openclaw` (system user, no shell, no sudo), home `/opt/openclaw` |
| Node | Private Node 24 in `/opt/openclaw/node` (the system Node 22 is VEIL's, untouched) |
| OpenClaw | `openclaw@2026.11.3`, installed in `/opt/openclaw/npm` |
| Service | `openclaw-gateway.service`, loopback only on `127.0.0.1:18789`, `MemoryMax=2200M` |
| Public address | `https://claw.rchtch.app`, via Cloudflare Tunnel `scalvs-gateway` (`cloudflared-scalvs.service`) |
| Model | Architect's free model, `https://rchtch.app/free/v1` (`@cf/zai-org/glm-4.7-flash`) |

No port is opened on the server: `cloudflared` connects out to Cloudflare. The tunnel passes
only `^/v1/chat/completions$`. Every other path, including the control UI and WebSocket,
returns 404. The gateway also checks its own token (`gateway.auth.mode = token`), and it
trusts forwarded client headers only from `127.0.0.1` and `::1`.

## Locked down on purpose

Anyone signed in to Architect with Cumulus ID can message `@scalvs`, so the agent gets no way
into the server:

- `tools.profile = minimal`, `tools.exec.mode = deny`, `tools.elevated.enabled = false`
- denied: exec, process, bash, web_fetch, web_search, browser, canvas, nodes, cron, gateway,
  write, edit, apply_patch (web fetches could reach services on the host)
- `plugins.allow = ["openai"]` (the stock set of 41 plugins ran the 3.8 GB host out of memory)
- `agents.defaults.maxConcurrent = 2`

Give it more tools only together with sandboxing (`agents.defaults.sandbox`, Docker is
installed), never by running tools on the host.

## Operating it

```bash
ssh infinitum-product-1
systemctl status openclaw-gateway cloudflared-scalvs
sudo journalctl -u openclaw-gateway -f
sudo -u openclaw HOME=/opt/openclaw PATH=/opt/openclaw/npm/bin:/opt/openclaw/node/bin:/usr/bin:/bin openclaw --version
```

Config: `/opt/openclaw/.openclaw/openclaw.json` (mode 600; it holds the gateway token).
Tunnel token: `/etc/cloudflared/scalvs-gateway.token` (root, 600).

**Rotating the token:** set a new `gateway.auth.token` in the config and restart the service.
Then pipe it straight into the Worker without printing it:

```bash
ssh infinitum-product-1 "sudo python3 -c \"import json,sys;sys.stdout.write(json.load(open('/opt/openclaw/.openclaw/openclaw.json'))['gateway']['auth']['token'])\"" | npx wrangler secret put OPENCLAW_GATEWAY_TOKEN
```

**Known limits:**
- All gateway traffic to the free model comes from one IP, so it shares one `FREE_RATE` bucket.
- Replies take about 10 s.
