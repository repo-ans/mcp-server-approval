# Housecall Pro MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude work with **Housecall Pro**: look up customers, jobs, estimates and unpaid invoices, and create or change records, with **every write held for human approval in Slack**.

- **Role-based API keys.** `read_only` agents can only read, `writer` agents can also request writes. Keys are stored hashed.
- **Human approval gate.** Write tools never touch Housecall Pro directly. They post an Approve / Reject message to Slack, and the change runs only after a person clicks **Approve**.
- **Full audit log.** Every tool call (success, error, permission rejection, approval decision) is logged to Supabase with inputs, result and latency.
- **Email / PDF to job.** Claude reads a service request (email text or PDF work order), extracts the customer and job, and submits both for one-click approval.
- **Swappable connector.** The core (auth, permissions, approvals, logging, Slack) knows nothing about Housecall Pro. Another ERP or CRM is a new folder under `src/connectors/`.
- **Safe demo modes.** `HCP_MOCK=true` serves realistic fake data. `HCP_MOCK_WRITES=true` reads real data but simulates approved writes.

Stack: TypeScript (strict), Node.js 20+, Express, `@modelcontextprotocol/sdk` (Streamable HTTP, stateless), zod, Supabase, Slack Web API over plain HTTP, `@anthropic-ai/sdk`. Runs as a normal Node server (VPS, pm2) or on Netlify Functions.

---

## Architecture

```
  Claude (Desktop / Code / API)                     Slack  #approvals
          │  POST /mcp                                 ▲        │ Approve / Reject
          │  Authorization: Bearer <agent key>         │ post   │ POST /slack/actions
          ▼                                            │        ▼  (signature verified)
 ┌──────────────────────────────── Express app (src/app.ts) ─────────────────────────────────┐
 │                                                                                            │
 │  core/auth.ts ──► core/permissions.ts ──► tool type?                                       │
 │  key → agent+role   read_only: read only     │                                             │
 │                     writer: read + write     ├── read ──► connector handler ─────────┐     │
 │                                              │                                       │     │
 │                                              └── write ─► core/approval.ts           │     │
 │                                                   insert approval_requests (pending) │     │
 │                                                   post Slack message ──────────┐     │     │
 │                                                   return "Pending approval"    │     │     │
 │                                                                                │     │     │
 │   on Approve: pending→approved (atomic) ─► connector handler ─► update Slack   │     │     │
 │   on Reject:  pending→rejected ─────────────────────────────► update Slack     │     │     │
 │                                                                                      │     │
 │  core/logger.ts: every call ─► tool_calls                                            │     │
 │                                                                                      ▼     │
 │  connectors/housecallpro/  tools.ts (definitions)  ──►  client.ts (ALL HTTP calls) ─────┐  │
 │  workflows/job-request.ts: email/PDF ─► Claude API ─► approval (customer + job)         │  │
 └─────────────────────────────────────────────────────────────────────────────────────────│──┘
          │                                                                                │
          ▼                                                                                ▼
   Supabase (Postgres)                                                     Housecall Pro API
   agents · tool_calls · approval_requests                                 (or mock data)
```

**Request flow for a write**, e.g. "book a job for Sarah next Tuesday":

1. Claude calls `create_job`. The server checks the key and role, validates the inputs, inserts an `approval_requests` row (`pending`), posts to Slack, and tells Claude *"Pending human approval (request id …)"*.
2. A person clicks **Approve** in Slack. The server verifies Slack's signature, flips the row `pending → approved` in a single conditional update (so double clicks run it once), calls Housecall Pro, stores the result, and updates the Slack message.
3. Every step lands in `tool_calls`: `pending_approval`, then `approved` (or `rejected` / `error`).

### Project layout

```
src/
  app.ts                    Express app: POST /mcp, POST /slack/actions, POST /slack/commands, POST /workflows/job-request, GET /health
  server.ts                 Long-running entry point (npm run dev / start, pm2)
  config.ts                 Env loading + validation (fails fast with a clear message)
  registry.ts               Wires connectors + workflows into the core (add new connectors here)
  core/
    auth.ts                 API key → {agentName, role}; sha256 hashes in Supabase, 60s cache
    permissions.ts          read_only → read tools; writer → read + write tools
    approval.ts             Queue, Slack post, atomic decide, execute, Slack update
    logger.ts               tool_calls logging, secret redaction
    slack.ts                chat.postMessage / chat.update, signature verification, alerts
    slack-commands.ts       /hcp-agent admin command (create / list / role / revoke API keys)
    agents.ts               Agent management shared by the Slack command and the CLI script
    db.ts                   Supabase client (service role, server-side only)
    types.ts                ToolDef type shared by connectors
  connectors/housecallpro/
    client.ts               Every Housecall Pro HTTP call + mock mode + readable errors
    tools.ts                Tool definitions (name, AI-facing description, zod schema, read/write, handler)
    mock.ts                 Realistic fake customers, jobs, estimates, invoices
  workflows/
    job-request.ts          Email/PDF → Claude → one approval → create customer + job (+ submit_job_request tool)
  scripts/
    create-agent.ts         npm run create-agent -- <name> <role>
    test-job-request.ts     npm run test-job-request -- <file> [--dry-run]
netlify/functions/          Netlify entry points (api + Slack background worker)
supabase/schema.sql         Tables: agents, tool_calls, approval_requests
samples/                    Sample email + PDF work order for the workflow
```

---

## Tools

All tools are exposed over MCP at `POST /mcp`. Descriptions are written for the model: what each tool does, when to use it, and example inputs. Money is in **dollars** in tool inputs and outputs (Housecall Pro stores cents; the connector converts).

| Tool | Type | Who can call | Purpose | Housecall Pro API |
|---|---|---|---|---|
| `find_customer` | read | read_only, writer | Search customers by name, email, phone, company or address | `GET /customers?q=` |
| `find_job` | read | read_only, writer | List jobs by customer, status and scheduled date range | `GET /jobs` |
| `get_job_status` | read | read_only, writer | Status, schedule, tech timestamps, assignees, balance and notes for one job | `GET /jobs/{id}` |
| `list_estimates` | read | read_only, writer | Estimates with options, prices and approval status | `GET /estimates` |
| `list_unpaid_invoices` | read | read_only, writer | Open / pending-payment invoices, oldest due first, with total due | `GET /invoices?status[]=open&status[]=pending_payment` |
| `create_customer` | **write** | writer + Slack approval | Create a customer (notifications off) with an optional service address | `POST /customers` |
| `create_job` | **write** | writer + Slack approval | Create a job for a customer; the description becomes its first line item | `POST /jobs` |
| `update_job` | **write** | writer + Slack approval | Reschedule a job and/or add a note | `PUT /jobs/{id}/schedule`, `POST /jobs/{id}/notes` |
| `create_estimate` | **write** | writer + Slack approval | Estimate with 1-5 options of priced line items | `POST /estimates` |
| `create_invoice` | **write** | writer + Slack approval | Add billable line items to a job's invoice | `POST /jobs/{id}/line_items` |
| `submit_job_request` | **write** | writer + Slack approval | Paste a customer email or PDF text in chat; one approval creates customer + job (see [workflow](#job-request-workflow)) | `POST /customers` then `POST /jobs` |

A `read_only` agent calling a write tool gets a clear *Permission denied* error, logged as `rejected_permission`.

### Inputs

`?` = optional. Line item = `{ name, description?, unit_price_usd, quantity? (default 1), kind? ("labor" | "materials", default "labor") }`.

| Tool | Inputs |
|---|---|
| `find_customer` | `query` (≥2 chars), `limit?` (1-50, default 10) |
| `find_job` | `customer_id?`, `work_status?` (array of `unscheduled`, `scheduled`, `in_progress`, `completed`, `canceled`), `scheduled_from?`, `scheduled_to?` (ISO 8601), `limit?` (1-100, default 10) |
| `get_job_status` | `job_id` |
| `list_estimates` | `customer_id?`, `work_status?`, `limit?` (default 10) |
| `list_unpaid_invoices` | `customer_id?`, `due_before?` (ISO date; use today for overdue only), `limit?` (default 25) |
| `create_customer` | `first_name`, `last_name`, `email?`, `mobile_number?`, `company?`, `address?` `{street, street_line_2?, city, state, zip, country? (US)}`, `notes?`, `tags?`, `lead_source?` |
| `create_job` | `customer_id`, `description`, `address_id?` (defaults to the customer's first address), `price_usd?`, `scheduled_start?`, `scheduled_end?` (default start + 2h), `arrival_window_minutes?`, `notes?`, `tags?` |
| `update_job` | `job_id`, plus at least one of `scheduled_start` (+ `scheduled_end?`, `arrival_window_minutes?`) or `note`; `notify_customer?` (default `false`) |
| `create_estimate` | `customer_id`, `options` (1-5 × `{name, line_items[]}`), `address_id?`, `message?` (to the customer), `note?` (internal) |
| `create_invoice` | `job_id`, `line_items` (1-20) |
| `submit_job_request` | `request_text` (the full original email / form / PDF text) |

### Housecall Pro API notes

The connector is built against the official Housecall v1 OpenAPI spec (base URL `https://api.housecallpro.com`, header `Authorization: Token <API key>`; API access requires the Housecall Pro **MAX** plan). The public API has **no "create invoice" endpoint and no general "update job" endpoint**, so:
- `create_invoice` adds line items to the job. In Housecall Pro a job's invoice is built from its line items and shares its number.
- `update_job` covers what the API allows: the schedule and notes.

API errors come back to Claude as readable messages (bad key, not found, validation error, rate limit, network).

### Job request workflow

Three ways in, all with a writer key, all ending in the same single Slack approval:
- **In a Claude chat** (everyday use): paste the customer's email or attach the PDF and say *"add this to Housecall Pro"*. Claude calls `submit_job_request`.
- **Automations:** `POST /workflows/job-request` with JSON `{"text": "<email body>"}` or `{"pdf_base64": "<base64 PDF>"}`. Use this to connect an inbox-forwarding rule (Zapier, Make, n8n, Postmark inbound) or a website form, so requests arrive without anyone opening a chat.
- **Developer check:** `npm run test-job-request -- samples/job-request.pdf` runs the same pipeline on the sample files.

What happens:

1. Claude (`ANTHROPIC_MODEL`, default `claude-opus-5-5`) extracts `{customer: {first_name, last_name, email, phone, address}, job: {description, scheduled_start, notes}}` using structured outputs, and the result is validated with zod. Unknown fields are `null`, never invented.
2. If the email or phone matches an existing customer, that customer is reused, so no duplicate is created.
3. One Slack message shows both steps. One **Approve** creates the customer, then the job, using the new customer's id and address id.

Returns `202 {status: "pending_approval", approval_request_id, existing_customer, extracted}`. A read-only key gets `403`. Only the document's type and size are logged, never its content.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Supabase

Create a project, open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. Copy **Project URL** and the **service_role** key (Project Settings → API) into `.env`. Row-level security is enabled with no policies, so only the server's service-role key can read or write these tables.

### 3. Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**, pick your workspace, and paste the YAML below with your public URL. For local development, use your tunnel URL (see [Local development](#local-development)).

   ```yaml
   display_information:
     name: HCP Approvals
   features:
     bot_user:
       display_name: HCP Approvals
       always_online: true
   oauth_config:
     scopes:
       bot:
         - chat:write
   settings:
     interactivity:
       is_enabled: true
       request_url: https://YOUR-HOST/slack/actions
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```
2. **Install App** → copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
3. **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`.
4. Create a channel, run `/invite @HCP Approvals` in it, and copy its **Channel ID** (channel name → About → bottom) → `SLACK_CHANNEL_ID`.
5. **Admin key command:**
   - Go to **Slash Commands → Create New Command**. Set Command `/hcp-agent`, Request URL `https://YOUR-HOST/slack/commands`, and Short description "Manage Housecall Pro MCP API keys". Save.
   - Go to **Install App → Reinstall to Workspace**. This adds the `commands` scope.
   - Put each admin's Slack member id (profile → ⋮ → **Copy member ID**) in `SLACK_ADMIN_IDS`, comma-separated.

Scopes: `chat:write`, plus `commands` for `/hcp-agent`. Private replies (e.g. "already handled", new keys) are ephemeral and need no extra scope.

If you create the app from the manifest instead, add this under `features` (and `- commands` under `oauth_config.scopes.bot`):

```yaml
  slash_commands:
    - command: /hcp-agent
      url: https://YOUR-HOST/slack/commands
      description: Manage Housecall Pro MCP API keys
      usage_hint: create <name> <read_only|writer> | list | role <name> <role> | revoke <name>
```

### 4. Housecall Pro and Claude

- `HCP_API_KEY`: Housecall Pro → App Store → API (MAX plan). Not needed with `HCP_MOCK=true`.
- `ANTHROPIC_API_KEY`: from https://platform.claude.com. Only needed for the job request workflow.

### 5. Run

```bash
npm run dev            # http://localhost:3000/mcp  (health: /health)
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port (local / VPS) |
| `HCP_MOCK` | no | `false` | `true` = fake data for everything (no Housecall Pro key needed) |
| `HCP_MOCK_WRITES` | no | `true` | `true` = real reads, but approved writes are simulated. Set `false` to write for real |
| `HCP_API_KEY` | unless `HCP_MOCK=true` | | Housecall Pro company API key |
| `HCP_BASE_URL` | no | `https://api.housecallpro.com` | API base URL |
| `SUPABASE_URL` | yes | | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | | Service role key (server-side only, never expose) |
| `SLACK_BOT_TOKEN` | yes | | `xoxb-…` bot token |
| `SLACK_SIGNING_SECRET` | yes | | Verifies that `/slack/actions` requests come from Slack |
| `SLACK_CHANNEL_ID` | yes | | Approvals channel id (`C…`) |
| `SLACK_APPROVER_IDS` | no | (anyone in channel) | Comma-separated Slack user ids allowed to approve |
| `SLACK_ADMIN_IDS` | for `/hcp-agent` | (command off) | Comma-separated Slack user ids allowed to create / revoke API keys |
| `ANTHROPIC_API_KEY` | for the workflow | | Claude API key |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | Model used for email/PDF extraction |

The server validates these at startup and exits with the name of any variable that is missing or malformed.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run typecheck` | Type-check everything, including the Netlify functions |
| `npm run create-agent -- <name> <read_only\|writer>` | Create an agent and print its API key once |
| `npm run test-job-request -- [file] [--dry-run]` | Run the workflow on `samples/…` (`--dry-run` = extract only, no Slack) |

---

## Connecting Claude

Every `/mcp` request needs `Authorization: Bearer <key>` (or `x-api-key: <key>`). Unknown keys get `401`.

**Claude Code**

```bash
claude mcp add --transport http housecallpro https://YOUR-HOST/mcp --header "Authorization: Bearer hcp_..."
```

**Claude Desktop.** Add the server through `mcp-remote` so the key can be sent as a header. Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "housecallpro": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-HOST/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer hcp_..." }
    }
  }
}
```

The header value goes in `env` because Windows breaks arguments that contain spaces. Claude Desktop's built-in *Custom connector* UI only supports OAuth or no auth, which is why this uses `mcp-remote`.

**MCP Inspector:** run `npx @modelcontextprotocol/inspector`, choose transport **Streamable HTTP**, enter URL `…/mcp`, and add the `Authorization` header under **Custom Headers**.

---

## Adding a new agent (API key)

One key = one person or one integration, with one role:
- **`read_only`:** can look things up.
- **`writer`:** can also request changes, and each change still needs Approve in Slack.

Keys live in Supabase, so a key works on the live server as soon as it's created.

**From Slack (no code needed).** Any admin listed in `SLACK_ADMIN_IDS` types, in any channel:

```
/hcp-agent create jane-dispatcher writer     → private reply with the key + connection instructions
/hcp-agent list                              → all agents and roles
/hcp-agent role jane-dispatcher read_only    → change a role
/hcp-agent revoke jane-dispatcher            → key stops working
```

**From a terminal** (developers, in the project folder): `npm run create-agent -- jane-dispatcher writer`.

The key (`hcp_…`) is shown **once**. Only its sha256 hash is stored, so a lost key can't be recovered; create a new one. Send keys privately, with a one-time link (onetimesecret.com, Bitwarden Send, 1Password), never in plain email or Slack messages. Admin actions are logged in `tool_calls` as `admin_create_agent`, `admin_set_role` and `admin_revoke_agent`.

---

## Adding a connector for another ERP / CRM

The core only depends on the `ToolDef` shape in [`src/core/types.ts`](src/core/types.ts): `name`, `description`, `type: 'read' | 'write'`, `inputSchema` (zod) and `handler`. Auth, permissions, the approval gate, Slack and logging apply automatically.

1. Create `src/connectors/<name>/client.ts` with every HTTP call to that system (base URL and credentials from env, readable error messages, optional mock branch).
2. Create `src/connectors/<name>/tools.ts` exporting `tools: AnyTool[]`, built with `defineTool({...})`. Mark anything that changes data as `type: 'write'`, so it goes through Slack approval with no extra code. Use `validate` to reject impossible requests before they reach a human.
3. Register it in [`src/registry.ts`](src/registry.ts): `export const tools = [...hcpTools, ...newTools]`. Keep tool names unique, e.g. prefix them (`jobber_find_client`).
4. Add its env vars to `src/config.ts` and `.env.example`.
5. Workflows call connector tools by name. To reuse the job request workflow for another system, point `runPlan` in `src/workflows/job-request.ts` at that connector's create-customer and create-job tools.

---

## Deployment

### Option A: Netlify (serverless)

The Express app runs as one Netlify Function ([`netlify/functions/api.ts`](netlify/functions/api.ts), via `serverless-http`). Slack clicks are handed to a **background function** ([`slack-worker-background.ts`](netlify/functions/slack-worker-background.ts)). That's because a serverless function is frozen once it responds, and Slack needs an answer within 3 seconds. The background function re-verifies Slack's signature itself. Routing is in [`netlify.toml`](netlify.toml).

```bash
npm install -g netlify-cli
netlify login
netlify init                  # create a new project
netlify env:import .env       # copy all variables to Netlify
netlify deploy --build --prod
```

Then:
1. Set the Slack **Interactivity Request URL** to `https://<site>.netlify.app/slack/actions`.
2. Point Claude at `https://<site>.netlify.app/mcp`.
3. Check `https://<site>.netlify.app/health`.

Netlify limits that matter here: 60 seconds per request, and 6 MB request body (PDFs up to about 4.5 MB). Background functions are available on all plans. After changing environment variables, redeploy.

### Option B: VPS with pm2 and Caddy (HTTPS)

On an Ubuntu VPS with a DNS record (e.g. `mcp.example.com`) pointing at it:

```bash
# Node 20+ and pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2

# App
git clone <your repo> /opt/hcp-mcp && cd /opt/hcp-mcp
npm ci && npm run build
cp .env.example .env && nano .env          # fill in values, keep PORT=3000
pm2 start dist/src/server.js --name hcp-mcp
pm2 save && pm2 startup                    # restart on reboot (run the command it prints)
```

Caddy terminates HTTPS with automatic Let's Encrypt certificates:

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

Set the Slack Request URL to `https://mcp.example.com/slack/actions` and Claude's server URL to `https://mcp.example.com/mcp`. Logs: `pm2 logs hcp-mcp`. Update: `git pull && npm ci && npm run build && pm2 restart hcp-mcp`.

**nginx instead of Caddy:** add a server block with `proxy_pass http://127.0.0.1:3000;`, and get a certificate with `sudo certbot --nginx -d mcp.example.com`.

### Local development

Slack must reach your machine over HTTPS for the buttons to work. Use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```

Set the Slack Request URL to `https://<random>.trycloudflare.com/slack/actions` and click **Save Changes**. The URL changes whenever cloudflared restarts. For a stable URL, use ngrok with its free static domain: `ngrok http 3000 --url=<name>.ngrok-free.app`.

---

## Security notes

- **API keys:** random 192-bit keys, stored only as sha256 hashes. They're never logged; inputs and results are redacted for secret-looking fields before logging.
- **Supabase:** the service-role key is used server-side only. RLS is on with no policies, so the anon key has no access.
- **Slack:** every interaction is checked against `X-Slack-Signature` (HMAC-SHA256, timing-safe compare, 5-minute timestamp window). Optionally only listed users can approve (`SLACK_APPROVER_IDS`).
- **Approvals:** run at most once. The `pending → approved/rejected` transition is a single conditional update. Approved actions that fail are marked `failed`, reported in the Slack message, and also posted as a separate alert.
- **Housecall Pro safety:** customers are created with notifications off, and `update_job` never notifies the customer unless asked. `HCP_MOCK_WRITES=true` is the default.
