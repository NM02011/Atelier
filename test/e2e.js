// End-to-end test of the spec's success scenario (section 2), run against a real server:
// two people, one "on Claude" and one "on ChatGPT", connect through OAuth (dynamic client
// registration + PKCE), post drafts, read each other's, merge, review, hand-edit, and check attribution.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3999, BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'atelier-test-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  env: { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_PATH: join(dir, 'test.db') }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('running') && resolve()));

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// --- a tiny web client with a cookie jar ---
function webClient() {
  let cookie = '';
  const call = async (method, path, body, { raw = false, form = false } = {}) => {
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
    return data;
  };
  return call;
}

// --- connect an "AI app" the way Claude/ChatGPT do: DCR → authorize → sign in → consent → token ---
async function connectAI(web, clientName, label) {
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: ['https://ai.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  assert.ok(reg.client_id, 'dynamic client registration works');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://ai.example/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${BASE}/mcp` })
    .forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const a = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(a.status, 302);
  const consentPath = a.headers.get('location');
  const html = await (await web('GET', consentPath, null, { raw: true })).text();
  assert.match(html, /Connect /, 'signed-in user sees the consent screen');
  const reqId = html.match(/name="req" value="([^"]+)"/)[1], csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.match(html, new RegExp(`value="${label}"`), `AI label is guessed as ${label}`);
  const c = await web('POST', '/oauth/consent', { req: reqId, csrf, ai_label: label, decision: 'allow' }, { raw: true, form: true });
  const redirect = new URL(c.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  const tok = await (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://ai.example/callback', resource: `${BASE}/mcp` }) })).json();
  assert.ok(tok.access_token && tok.refresh_token, 'token exchange works');
  const client = new Client({ name: clientName, version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((x) => x.text).join('\n');
    if (r.isError) throw Object.assign(new Error(text), { toolError: true });
    return text;
  };
  return { client, call, tok, reg, meta };
}

try {
  console.log('Atelier end-to-end test');
  const austinWeb = webClient(), nickWeb = webClient(), clientWeb = webClient();
  let project, austinAI, nickAI, draftA, draftN, merge;

  await step('unauthenticated MCP request gets 401 with resource metadata', async () => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
  });

  await step('Austin signs up, creates a project and invites Nick by email', async () => {
    await austinWeb('POST', '/api/signup', { email: 'austin@example.com', name: 'Austin', password: 'password123' });
    project = await austinWeb('POST', '/api/projects', { name: 'Trail guide pitch', goal: 'A one-page pitch for a Colorado trail guide app' });
    const inv = await austinWeb('POST', `/api/projects/${project.id}/invites`, { email: 'nick@example.com', role: 'editor' });
    await nickWeb('POST', '/api/signup', { email: 'nick@example.com', name: 'Nick', password: 'password456' });
    await nickWeb('POST', `/api/invites/${inv.token}/accept`, {});
    const p = await nickWeb('GET', `/api/projects/${project.id}`);
    assert.equal(p.members.length, 2);
  });

  await step('Austin connects "Claude" and Nick connects "ChatGPT" via OAuth + DCR', async () => {
    austinAI = await connectAI(austinWeb, 'Claude', 'Claude');
    nickAI = await connectAI(nickWeb, 'ChatGPT', 'ChatGPT');
    const tools = (await austinAI.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['add_to_document', 'create_project', 'get_history', 'get_project', 'list_projects', 'post_comment', 'post_contribution', 'propose_combined_version', 'read_comments', 'read_contributions', 'review_version'].sort());
  });

  await step('list_projects and get_project', async () => {
    const t = await austinAI.call('list_projects');
    assert.match(t, /Trail guide pitch/);
    assert.match(await nickAI.call('get_project', { project_id: project.id }), /Austin \(owner\)[\s\S]*Nick \(editor\)/);
  });

  await step('each posts a draft through their own AI (post_contribution)', async () => {
    const a = await austinAI.call('post_contribution', { project_id: project.id, title: "Austin's pitch", content: '# Pitch\n\nTrails for everyone.\n\nBudget: TBD', visibility: 'shared' });
    draftA = a.match(/\[(c_[^\]]+)\]/)[1];
    const n = await nickAI.call('post_contribution', { project_id: project.id, title: "Nick's pitch", content: '# Pitch\n\nOffline maps for every trail.\n\nBudget: $40k', visibility: 'shared' });
    draftN = n.match(/\[(c_[^\]]+)\]/)[1];
    await nickAI.call('post_contribution', { project_id: project.id, title: 'Nick private notes', content: 'secret idea', visibility: 'private' });
  });

  await step("each reads the other's draft, labeled by person and AI; private stays private", async () => {
    const t = await austinAI.call('read_contributions', { project_id: project.id, member: 'Nick' });
    assert.match(t, /by Nick via ChatGPT/);
    assert.match(t, /BEGIN CONTENT FROM ANOTHER USER/);
    assert.match(t, /Offline maps/);
    assert.doesNotMatch(t, /secret idea/);
    const t2 = await nickAI.call('read_contributions', { project_id: project.id });
    assert.match(t2, /by Austin via Claude/);
    assert.match(t2, /secret idea/, 'author sees own private');
  });

  await step("Austin's AI proposes a combined version; it is NOT current until Nick approves", async () => {
    const t = await austinAI.call('propose_combined_version', { project_id: project.id, title: 'Pitch', content: '# Pitch\n\nTrails for everyone, with offline maps for every trail.\n\nBudget: $40k', contribution_ids: [draftA, draftN], summary: 'Merged both drafts' });
    merge = t.match(/\[(v_[^\]]+)\]/)[1];
    assert.match(t, /Waiting on approval from: Nick/);
    assert.match(await nickAI.call('get_project', { project_id: project.id }), /None yet/);
  });

  await step('the proposer cannot approve their own merge', async () => {
    await assert.rejects(austinAI.call('review_version', { version_id: merge, decision: 'approve' }), /cannot review your own/);
  });

  await step('Nick reads the proposal and comments through his AI', async () => {
    const t = await nickAI.call('get_history', { project_id: project.id, version_id: merge });
    assert.match(t, /Built from:[\s\S]*Austin's pitch[\s\S]*Nick's pitch/);
    await nickAI.call('post_comment', { target_id: merge, comment: 'Love the merge', passage: 'offline maps for every trail' });
    const c = await austinAI.call('read_comments', { project_id: project.id, target_id: merge });
    assert.match(c, /Nick via ChatGPT/);
    assert.match(c, /on the passage: "offline maps/);
  });

  await step('Nick approves through his AI → it becomes the current version', async () => {
    const t = await nickAI.call('review_version', { version_id: merge, decision: 'approve', comment: 'Looks great' });
    assert.match(t, /now the current version/);
    assert.match(await austinAI.call('get_project', { project_id: project.id }), /Current version: v1/);
  });

  await step('Nick edits the current version by hand in Atelier and submits it for approval', async () => {
    const v = await nickWeb('POST', `/api/projects/${project.id}/versions`, { title: 'Pitch', body: '# Pitch\n\nTrails for everyone, with offline maps.\n\nBudget: $45k', summary: 'Tightened wording, updated budget' });
    assert.equal(v.status, 'proposed');
    assert.equal(v.via, 'hand');
    assert.deepEqual(v.approval.waiting_on, ['Austin']);
    await austinWeb('POST', `/api/versions/${v.id}/review`, { decision: 'request_changes', comment: 'Keep $40k' });
    const counter = await austinAI.call('propose_combined_version', { project_id: project.id, title: 'Pitch', content: '# Pitch\n\nTrails for everyone, with offline maps.\n\nBudget: $40k', counter_to: v.id, summary: 'Counter: keep budget' });
    const cid = counter.match(/\[(v_[^\]]+)\]/)[1];
    const r = await nickWeb('POST', `/api/versions/${cid}/review`, { decision: 'approve' });
    assert.equal(r.became_current, true);
    assert.equal(r.origin, 'counter');
  });

  await step('history shows who made each version, with which AI, and when; restore is a proposal', async () => {
    const h = await nickAI.call('get_history', { project_id: project.id });
    assert.match(h, /v1 .* replaced, by Austin via Claude/);
    assert.match(h, /v2 .* replaced, by Nick by hand in Atelier/);
    assert.match(h, /v3 .* approved, by Austin via Claude/);
    const v1 = (await austinWeb('GET', `/api/projects/${project.id}/versions`)).find((v) => v.number === 1);
    const restored = await austinWeb('POST', `/api/versions/${v1.id}/restore`, {});
    assert.equal(restored.status, 'proposed');
    assert.equal(restored.origin, 'restore');
  });

  await step('activity log records every action with person and AI', async () => {
    const log = await austinWeb('GET', `/api/projects/${project.id}/activity`);
    const actions = log.map((a) => `${a.actor_name}:${a.action}:${a.via}`);
    for (const x of ['Austin:posted_contribution:Claude', 'Nick:posted_contribution:ChatGPT', 'Austin:proposed:Claude', 'Nick:approved:ChatGPT', 'Nick:commented:ChatGPT', 'Nick:proposed:hand', 'Austin:requested_changes:hand']) {
      assert.ok(actions.includes(x), `activity has ${x}`);
    }
    assert.ok(!log.some((a) => a.detail.includes('Nick private notes')), "Nick's private contribution is hidden from Austin's log");
  });

  await step('roles: a commenter (outside client) can comment and review but not post', async () => {
    const inv = await austinWeb('POST', `/api/projects/${project.id}/invites`, { email: 'client@example.com', role: 'commenter' });
    await clientWeb('POST', '/api/signup', { email: 'client@example.com', name: 'Client', password: 'password789' });
    await clientWeb('POST', `/api/invites/${inv.token}/accept`, {});
    const clientAI = await connectAI(clientWeb, 'LibreChat', 'LibreChat');
    await assert.rejects(clientAI.call('post_contribution', { project_id: project.id, title: 'x', content: 'y' }), /commenter/);
    await clientAI.call('post_comment', { target_id: draftA, comment: 'Nice start' });
    await assert.rejects(clientAI.call('read_contributions', { project_id: project.id, contribution_id: 'c_doesnotexist' }), /not found/);
  });

  await step('add a contribution to the document under a chosen section, as a proposal', async () => {
    const p2 = await austinWeb('POST', '/api/projects', { name: 'Brief' });
    const post = (title, body, visibility = 'shared') => austinWeb('POST', `/api/projects/${p2.id}/contributions`, { title, body, visibility });
    const add = (c, section_index) => austinWeb('POST', `/api/contributions/${c.id}/add-to-document`, { section_index });
    // No document yet: the contribution starts it. Austin is alone, so it is current at once.
    const a = await post('Brief', '# Brief\n\n## Goals\n\nShip it.\n\n---\n\n## Risks\n\nNone yet.');
    const v1 = await add(a);
    assert.equal(v1.status, 'approved');
    assert.equal(v1.origin, 'add');
    const sections = await austinWeb('GET', `/api/projects/${p2.id}/sections`);
    assert.deepEqual(sections.map((s) => `${s.level}:${s.title}`), ['1:Brief', '2:Goals', '2:Risks']);
    // Under "Goals": lands at the end of that section, above the divider, with headings moved to fit.
    const b = await post('Budget', '# Costs\n\nFive dollars.\n\n```\n# not a heading\n```');
    const v2 = await add(b, 1);
    assert.equal(v2.body, '# Brief\n\n## Goals\n\nShip it.\n\n### Costs\n\nFive dollars.\n\n```\n# not a heading\n```\n\n---\n\n## Risks\n\nNone yet.');
    assert.deepEqual(v2.sources.map((s) => s.id), [a.id, b.id]);
    await assert.rejects(add(b, 1), /already/);
    await assert.rejects(add(await post('Secret', 'x', 'private')), /Share this contribution/);
    // With a second reviewer it waits for approval, and an AI can do it by naming the heading.
    const inv = await austinWeb('POST', `/api/projects/${p2.id}/invites`, { email: 'nick@example.com', role: 'editor' });
    await nickWeb('POST', `/api/invites/${inv.token}/accept`, {});
    const c = await post('Timeline note', 'Two weeks.');
    await assert.rejects(austinAI.call('add_to_document', { contribution_id: c.id, section: 'Nope' }), /no section titled "Nope".*"Goals"/s);
    const out = await austinAI.call('add_to_document', { contribution_id: c.id, section: 'risks' });
    assert.match(out, /Proposed v3 .*under "Risks".*Waiting on approval from: Nick/s);
    const p = await austinWeb('GET', `/api/projects/${p2.id}`);
    assert.equal(p.current_version.number, 2, 'not current until Nick approves');
    const done = await nickWeb('POST', `/api/versions/${p.open_proposals[0].id}/review`, { decision: 'approve' });
    assert.equal(done.became_current, true);
    assert.ok(done.body.endsWith('## Risks\n\nNone yet.\n\n### Timeline note\n\nTwo weeks.'));
    const end = await add(await post('Appendix', 'Extra.'));
    assert.equal(end.status, 'proposed');
    assert.ok(end.body.endsWith('\n\n## Appendix\n\nExtra.'));
  });

  await step('an AI can create a project; the person owns it and it is credited to them and their AI', async () => {
    const out = await nickAI.call('create_project', { name: 'Nick via AI', goal: 'Test it' });
    const pid = out.match(/\[(p_[^\]]+)\]/)[1];
    const p = await nickWeb('GET', `/api/projects/${pid}`);
    assert.equal(p.my_role, 'owner');
    assert.equal(p.goal, 'Test it');
    assert.match(await nickAI.call('list_projects'), /Nick via AI/);
    const log = await nickWeb('GET', `/api/projects/${pid}/activity`);
    assert.ok(log.some((a) => a.action === 'created_project' && a.via === 'ChatGPT'));
    await assert.rejects(nickAI.call('create_project', { name: '  ' }), /needs a name/);
    await assert.rejects(austinWeb('GET', `/api/projects/${pid}`), /not found/);
  });

  await step('non-members cannot see a project; refresh tokens rotate', async () => {
    const outsider = webClient();
    await outsider('POST', '/api/signup', { email: 'x@example.com', name: 'X', password: 'password000' });
    await assert.rejects(outsider('GET', `/api/projects/${project.id}`), /not found/);
    const { meta, reg, tok } = austinAI;
    const refresh = async (rt) => (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: reg.client_id }) }));
    const r1 = await refresh(tok.refresh_token);
    assert.equal(r1.status, 200);
    assert.equal((await refresh(tok.refresh_token)).status, 400, 'old refresh token no longer works');
  });

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
