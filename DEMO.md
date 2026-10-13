# Loom demo script (about 5 minutes)

Shows Claude reading Housecall Pro data, requesting changes that a human approves in Slack, role-based permissions, the email/PDF → job workflow, and the audit log.

## Before recording

1. **Use mock data.** In `.env`, set `HCP_MOCK=true`. A real Housecall Pro account contains real customers' names, phones and addresses, which shouldn't appear in a public video. Mock mode serves realistic data (Sarah Mitchell, David Ramirez, Emily Chen) and simulates writes. Restart the server after changing `.env`.
2. Start the server and the tunnel: `npm run dev`, and `cloudflared tunnel --url http://localhost:3000`. Check that the Slack **Request URL** matches the tunnel and ends in `/slack/actions`. On Netlify, use the site URL instead.
3. Create two demo agents in Slack, if you haven't already. Your Slack member id must be in `SLACK_ADMIN_IDS`.
   ```
   /hcp-agent create demo-writer writer
   /hcp-agent create demo-reader read_only
   ```
4. Connect **both** to Claude, so you can switch roles without restarting.
   **Claude Code:**
   ```bash
   claude mcp add --transport http hcp-writer http://localhost:3000/mcp --header "Authorization: Bearer <writer key>"
   claude mcp add --transport http hcp-reader http://localhost:3000/mcp --header "Authorization: Bearer <reader key>"
   ```
   **Claude Desktop** (`claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "hcp-writer": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization:${AUTH}"], "env": { "AUTH": "Bearer <writer key>" } },
       "hcp-reader": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization:${AUTH}"], "env": { "AUTH": "Bearer <reader key>" } }
     }
   }
   ```
5. Arrange your windows: Claude on the left, Slack `#mcp-approvals` on the right. Have the Supabase **tool_calls** table open in a browser tab, and a terminal in the project folder.
6. Optional: clear old rows in Supabase (`delete from tool_calls; delete from approval_requests;`) so the log starts clean.

---

## Script

### 0. Intro (20s)
> "This is a remote MCP server that connects Claude to Housecall Pro. Claude can read anything, but every change waits for a human to approve it in Slack, and every call is logged in Supabase. Agents get API keys with roles: read-only or writer."

Optionally show the architecture diagram in `README.md` for a few seconds.

### 1. Reading data (60s)

Type in Claude:

> **Who owes us money right now, and what's actually overdue as of today?**

Expected: `list_unpaid_invoices` runs. Two unpaid invoices, $2,610 total: #10455 Emily Chen $2,150 (due Oct 22), and #10398 Ramirez Properties $460, **overdue** since Sep 30.

> **What's the status of Sarah Mitchell's AC job? Is the tech there yet?**

Expected: `find_customer` → `find_job` → `get_job_status`. The job is **in progress**: Marcus Lee was on his way at 14:05 and started at 14:32, the balance is $485, and the gate code note shows.

> **What did we quote Emily Chen?**

Expected: `list_estimates`. Estimate #5021, with Repair for $890 or a new 16 SEER2 system for $7,850, both still open.

Say: *"Reads run immediately. Now watch what happens when Claude wants to change something."*

### 2. A write needs human approval (75s)

> **Schedule a follow-up for Sarah Mitchell next Tuesday at 10am: replace the run capacitor we diagnosed, $185. Note that she has a dog in the backyard.**

Expected: Claude calls `create_job` and replies that it's **pending human approval** with a request id. Nothing has been created yet.

Switch to Slack:
1. Show the **"Approval needed: create_job"** message, with the agent name, every field, and **Approve / Reject** buttons.
2. Click **Approve**. The message updates to *"✅ Approved by … and executed"* with the new job id.
3. Click **Approve** again. Only you get a private *"already handled"* reply, and nothing runs twice.

Back in Claude:

> **Also add a note to the Ramirez Properties maintenance job: bring the roof hatch key from the office.**

Expected: `update_job` goes to Slack for approval. Click **Reject** this time: *"❌ Rejected by …. Nothing was changed."*

### 3. Role-based permissions (30s)

Use the **reader** server:

> **Using the hcp-reader tools, create a customer named Test User.**

Expected: Claude reports *"Permission denied: agent demo-reader has role read_only and cannot call write tool create_customer."* Nothing reaches Slack.

Say: *"Each AI agent or integration gets its own key and role, so a reporting bot can never change data."*

Optional: in Slack, type `/hcp-agent list` to show that keys are created, re-roled and revoked from Slack by admins, with no code involved.

### 4. Email / PDF → customer + job (60s)

Attach `samples/job-request.pdf` to the Claude chat (a property manager's work order for a leaking sink) and type:

> **This work order just came in. Add it to Housecall Pro.**

Expected: Claude calls `submit_job_request` and shows what was extracted: Maria Gonzalez (Lakeline Property Management), the Brushy Creek Rd service address, start *Oct 16, 2:00 PM Central*, and notes with the tenant contact, lockbox code and the $450 limit. It says the request is pending approval.

In Slack: **"Approval needed: job_request"** lists both steps, *1. Create customer* and *2. Create job*. Click **Approve**. The customer is created, then the job is created for that new customer.

Optionally, paste the text of `samples/job-request-email.txt` into the chat instead. "Next Tuesday at 9am" gets turned into an actual date.

Say: *"The same workflow has an HTTP endpoint, so an inbox rule or a website form can feed it automatically, with no chat needed."*

### 5. The audit log (30s)

Open Supabase → **tool_calls**, sorted by `created_at`. Point out:
- agent, tool, inputs, result and latency for every call
- statuses `success`, `pending_approval`, `approved`, `rejected`, `rejected_permission`
- **approval_requests**: who approved or rejected what, and when

### 6. Wrap-up (20s)
> "Housecall Pro is just one connector. The auth, approvals, Slack and logging are separate, so adding Jobber, ServiceTitan or a CRM is one new folder. It deploys to Netlify or any VPS behind HTTPS. Turning off mock mode switches it to the live Housecall Pro API."

---

## If something goes wrong while recording

| Symptom | Fix |
|---|---|
| Claude doesn't list the tools | Restart Claude after editing its config; check that `http://localhost:3000/health` responds |
| `401` / "Invalid API key" | Use the full `hcp_…` key after `Bearer `, with no `<` `>` |
| Slack button shows ⚠️ or a 404 | The tunnel URL changed: update the Slack Request URL (`…/slack/actions`) and click **Save Changes** |
| `not_in_channel` | Run `/invite @HCP Approvals` in the channel |
| Workflow says `ANTHROPIC_API_KEY is not set` | Add it to `.env` and restart |
