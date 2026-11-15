# Atelier (prototype V1)

A shared project workspace where people write, edit and review documents together, either directly in the web
workspace or through the AI each person already uses (Claude, ChatGPT, or an open-source model). Atelier exposes the
workspace as a **remote MCP server**; it runs no AI of its own.

One Node.js process serves everything:

| Path | What it is |
| --- | --- |
| `/` | Web workspace: projects, invites and roles, editor, contributions, proposals and review, comments, history, activity log |
| `/mcp` | Remote MCP server (Streamable HTTP) with the nine hub tools, plus `add_to_document`, `create_project` and `invite_member` |
| `/authorize`, `/token`, `/register`, `/.well-known/*` | OAuth 2.1 authorization server with dynamic client registration and PKCE |

## Run it locally

Requires Node.js 22.5 or newer. No database server is needed (it uses SQLite built into Node).

```bash
npm install
npm start                  # http://localhost:3000
```

Optional sample project: `npm run demo` (before `npm start`, same `DB_PATH`) creates `austin@demo.test`,
`nick@demo.test` and `client@demo.test`, all with password `atelier-demo`.

Run the end-to-end test of the spec's success scenario: `npm test`.

## Connect Claude or ChatGPT (needs HTTPS)

AI apps only connect to a public HTTPS URL. The quickest way while testing is a free Cloudflare quick tunnel:

```bash
# terminal 1: start the tunnel and note the https://….trycloudflare.com URL it prints
cloudflared tunnel --url http://localhost:3000
# terminal 2: start Atelier with that URL
BASE_URL=https://<your-subdomain>.trycloudflare.com TRUST_PROXY=1 npm start
```

The connector URL is then `https://<your-subdomain>.trycloudflare.com/mcp`. The **Connect AI** tab in each project
shows the URL and step-by-step setup for Claude, ChatGPT (Developer mode) and open-source chat apps.
Quick-tunnel URLs change each time you restart the tunnel; use a named tunnel or a host (below) for anything longer-lived.

## Host it

Any host that runs a Docker container with a small persistent disk works (Fly.io, Railway, Render, a VPS).

```bash
docker build -t atelier .
docker run -p 3000:3000 -v atelier-data:/data \
  -e BASE_URL=https://atelier.example.com -e TRUST_PROXY=1 -e SIGNUP_CODE=choose-a-code atelier
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:$PORT` | Public URL. Must be HTTPS for AI apps. OAuth metadata and the connector URL are built from it. |
| `PORT` | `3000` | Port to listen on |
| `DB_PATH` | `./data/atelier.db` (`/data/atelier.db` in Docker) | SQLite file. Put it on a persistent volume. |
| `TRUST_PROXY` | off | Set to `1` behind a tunnel, load balancer or PaaS router |
| `SIGNUP_CODE` | none | If set, new accounts need this code. Recommended on a public URL. |

## How it maps to the spec

**Data model (spec 7).** Users, projects (one project = one workspace), members with roles owner / editor /
commenter / viewer, contributions (private or shared, never edited after posting), versions (proposed, approved,
replaced, withdrawn) that list the contributions they were built from, reviews, comments (with replies and an optional
quoted passage), and an activity log. Every contribution, version, review and comment records the person, how it was
made (`hand`, or the AI label such as `Claude`, `ChatGPT`, `Qwen3 via LibreChat`) and the time.

**Hub tools (spec 8).** `list_projects`, `get_project`, `post_contribution`, `read_contributions`,
`propose_combined_version`, `review_version`, `get_history`, `read_comments`, `post_comment`.
Read tools are marked read-only; write tools ask the AI to confirm with the user first.
Three tools go beyond the spec. `create_project` starts a project from an AI app (the person becomes its owner).
`invite_member` lets the owner's AI create an invite link for one email and role; Atelier still sends nothing itself.
`add_to_document` proposes adding one shared contribution, as written, under a
section heading of the current version (or at the end). The web app has the same action on each contribution.
Placement is mechanical because Atelier runs no AI, and the result is an ordinary proposal that the others approve.
`get_history` also takes a `version_id` to read one version in full, which is how a reviewer's AI reads a proposal.

**Which AI made it.** When an AI app registers, Atelier guesses its label from the app name (Claude, ChatGPT,
LibreChat…). The person confirms or edits it on the consent screen, which is how an open-source model gets named.
The label is stored on the OAuth token, so everything that AI does is attributed to it.

**Merging and fairness (spec 9).**
- Any editor (or their AI) can propose; a proposal never changes the current version by itself.
- Default rule: a proposal becomes current when every *other* member who can review (owner, editors, commenters) has
  approved. Owners can switch a project to "the owner approves" for larger groups. Viewers never block.
- Nobody can approve their own proposal. A request for changes needs a note.
- "What changed" shows a side-by-side diff against the previous version, the proposal it answers, or any contributor's
  own contribution (it defaults to yours).
- Anyone can answer with a counter-proposal. When a counter-proposal is approved, the proposal it answered is marked replaced.
- Restoring an old version creates a proposal, so it goes through the same approval.
- If a project has only one reviewer-capable member, their proposals become current immediately.

**Security (spec 12).** OAuth 2.1 with PKCE and dynamic client registration for every AI connection; Atelier stores
no AI API keys. Tokens, refresh tokens and sessions are stored only as SHA-256 hashes; refresh tokens rotate.
Permissions are checked in one place (`src/core.js`) for both the web app and MCP. Private contributions are never
returned to other members (not in tool results, history, version sources or the activity log).
Another member's content is returned fenced and labeled as content from another user, not instructions. Markdown is
sanitized before display. Sharing a contribution warns that a partner's AI will send it to that AI's provider.

## Prototype decisions to revisit

- **SQLite instead of Postgres.** Zero setup for two testers, one file to back up. The schema is plain SQL; moving to
  Postgres means swapping `src/db.js` and making the data calls async.
- **Email + password sign-in, invite links instead of emails.** Owners copy an invite link and send it themselves.
  Adding an email provider (e.g. Resend or Postmark) would enable invite emails and magic-link sign-in.
- **The editor is edit-then-propose, not live co-editing.** Two people editing at once each submit a proposal; there is
  no real-time cursor sharing.
- **Not built (out of scope or later):** A2A messaging, hub-run AI or model APIs, model recommendations, file uploads,
  SSO/admin, the side-panel AI chat.

## Code map

```
server.js         Express app: OAuth router, /mcp endpoint, web API, static files
src/config.js     Environment settings
src/db.js         SQLite schema and helpers
src/core.js       All domain logic and permission checks (shared by web + MCP)
src/auth.js       Accounts, sessions, OAuth provider
src/mcp.js        The MCP tools
src/web.js        Web JSON API and the OAuth sign-in/consent pages
public/           Single-page web workspace (no build step)
test/e2e.js       End-to-end test of the spec's success scenario
scripts/demo-data.js  Sample project
```
