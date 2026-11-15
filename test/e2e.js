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
    assert.deepEqual(tools, ['add_to_document', 'create_project', 'get_history', 'get_project', 'invite_member', 'plan_next_steps', 'list_projects', 'post_comment', 'post_contribution', 'propose_combined_version', 'read_comments', 'read_contributions', 'review_version', 'save_next_steps'].sort());
  });

  await step('list_projects and get_project', async () => {
    const t = await austinAI.call('list_projects');
    assert.match(t, /Trail guide pitch/);
    assert.match(await nickAI.call('get_project', { project_id: project.id }), /Austin \(owner\)[\s\S]*Nick \(editor\)/);
  });

  await step('each posts a draft through their own AI (post_contribution)', async () => {
    const a = await austinAI.call('post_contribution', { project_id: project.id, title: "Austin's pitch", content: '# Pitch\n\nTrails for everyone.\n\nBudget: TBD', kind: 'draft', visibility: 'shared' });
    draftA = a.match(/\[(c_[^\]]+)\]/)[1];
    const n = await nickAI.call('post_contribution', { project_id: project.id, title: "Nick's pitch", content: '# Pitch\n\nOffline maps for every trail.\n\nBudget: $40k', kind: 'draft', visibility: 'shared' });
    draftN = n.match(/\[(c_[^\]]+)\]/)[1];
    await nickAI.call('post_contribution', { project_id: project.id, title: 'Nick private notes', content: 'secret idea', kind: 'reference', visibility: 'private' });
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
    await assert.rejects(clientAI.call('post_contribution', { project_id: project.id, title: 'x', content: 'y', kind: 'draft' }), /commenter/);
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

  await step('an owner\'s AI can create an invite link; non-owners cannot', async () => {
    const pid = (await nickAI.call('create_project', { name: 'Invite test' })).match(/\[(p_[^\]]+)\]/)[1];
    const out = await nickAI.call('invite_member', { project_id: pid, email: 'Austin@Example.com', role: 'commenter' });
    assert.match(out, /austin@example\.com to join as commenter/);
    const token = out.match(/\/invite\/(\S+)/)[1];
    await austinWeb('POST', `/api/invites/${token}/accept`, {});
    const p = await austinWeb('GET', `/api/projects/${pid}`);
    assert.equal(p.my_role, 'commenter');
    const log = await nickWeb('GET', `/api/projects/${pid}/activity`);
    assert.ok(log.some((a) => a.action === 'invited' && a.via === 'ChatGPT'));
    await assert.rejects(austinAI.call('invite_member', { project_id: pid, email: 'z@example.com' }), /cannot manage this project/);
    await assert.rejects(nickAI.call('invite_member', { project_id: pid, email: 'austin@example.com' }), /already a member/);
    await assert.rejects(nickAI.call('invite_member', { project_id: pid, email: 'not-an-email' }), /valid email/);
  });

  await step('next steps: writes ask for a refresh, each save replaces the list, history is kept', async () => {
    const made = await nickAI.call('create_project', { name: 'Steps test', goal: 'Try next steps' });
    const pid = made.match(/\[(p_[^\]]+)\]/)[1];
    assert.match(made, new RegExp(`next steps are now out of date.*plan_next_steps.*"${pid}".*save_next_steps`, 's'));
    assert.deepEqual(await nickWeb('GET', `/api/projects/${pid}/next-steps`), { current: null, history: [], changes_since: [] });
    const plan = await nickAI.call('plan_next_steps', { project_id: pid });
    assert.match(plan, /Goal: Try next steps/);
    assert.match(plan, /None yet\. This will be the first list\./);
    assert.match(await nickAI.call('save_next_steps', { project_id: pid, steps: '1. Write the draft (Nick).' }), /Saved next steps \[n_/);
    let ns = await nickWeb('GET', `/api/projects/${pid}/next-steps`);
    assert.equal(ns.current.body, '1. Write the draft (Nick).');
    assert.equal(ns.current.via, 'ChatGPT');
    assert.equal(ns.changes_since.length, 0, 'fresh right after saving');
    // A shared write makes them out of date and says so; a private one does not ask for a refresh.
    const posted = await nickAI.call('post_contribution', { project_id: pid, title: 'Draft one', content: 'Hello.', kind: 'draft' });
    assert.match(posted, /next steps are now out of date/);
    assert.doesNotMatch(await nickAI.call('post_contribution', { project_id: pid, title: 'Secret plan', content: 'x', kind: 'draft', visibility: 'private' }), /out of date/);
    ns = await nickWeb('GET', `/api/projects/${pid}/next-steps`);
    assert.equal(ns.changes_since.length, 2);
    const plan2 = await nickAI.call('plan_next_steps', { project_id: pid });
    assert.match(plan2, /not yet in the document\n- \[c_[^\]]+\] "Draft one"/);
    assert.doesNotMatch(plan2, /Secret plan/, 'private notes are not offered as material');
    assert.match(plan2, /1\. Write the draft \(Nick\)\./, 'previous list is shown');
    // Saving by hand replaces the list; the old one moves to history.
    await nickWeb('POST', `/api/projects/${pid}/next-steps`, { body: '1. Add "Draft one" to the document (Nick).' });
    ns = await nickWeb('GET', `/api/projects/${pid}/next-steps`);
    assert.equal(ns.current.via, 'hand');
    assert.deepEqual(ns.history.map((n) => n.body), ['1. Write the draft (Nick).']);
    assert.equal(ns.changes_since.length, 0);
    await assert.rejects(nickWeb('POST', `/api/projects/${pid}/next-steps`, { body: '  ' }), /empty/);
    await assert.rejects(austinWeb('GET', `/api/projects/${pid}/next-steps`), /not found/);
    // Another member does not see someone else's private note in "what changed".
    const inv = await nickWeb('POST', `/api/projects/${pid}/invites`, { email: 'austin@example.com', role: 'viewer' });
    await austinWeb('POST', `/api/invites/${inv.token}/accept`, {});
    await nickAI.call('post_contribution', { project_id: pid, title: 'Hidden', content: 'y', kind: 'draft', visibility: 'private' });
    const seen = await austinWeb('GET', `/api/projects/${pid}/next-steps`);
    assert.ok(!JSON.stringify(seen).includes('Hidden'));
    await assert.rejects(austinWeb('POST', `/api/projects/${pid}/next-steps`, { body: 'x' }), /viewer/);
  });

  await step('contribution types: each type changes what Atelier does with a contribution', async () => {
    const pid = (await nickAI.call('create_project', { name: 'Types test' })).match(/\[(p_[^\]]+)\]/)[1];
    const post = async (args) => (await nickAI.call('post_contribution', { project_id: pid, content: 'Body.', ...args })).match(/\[(c_[^\]]+)\]/)[1];
    const get = (cid) => nickWeb('GET', `/api/contributions/${cid}`);
    // An AI has to say what it is posting.
    await assert.rejects(nickAI.call('post_contribution', { project_id: pid, title: 'x', content: 'y' }), /Say what type this is.*draft:.*status:/s);
    const d1 = await post({ title: 'Plan draft', content: '# Plan\n\nShip it.', kind: 'draft' });
    const d2 = await post({ title: 'Second draft', kind: 'draft' });
    assert.equal((await get(d2)).standing.state, 'unused');
    // Status gets the date in its title; the old "note" is filed as reference.
    const s1 = await post({ title: 'Tool check', kind: 'status' });
    assert.match((await get(s1)).title, /^\d{4}-\d{2}-\d{2}: Tool check$/);
    const r1 = await post({ title: 'Background', kind: 'note' });
    assert.equal((await get(r1)).kind, 'reference');
    // Feedback must say what it is about; a decision is one line.
    await assert.rejects(post({ title: 'Too vague', kind: 'feedback' }), /what it is about/);
    const f1 = await post({ title: 'On the plan', kind: 'feedback', about: d1 });
    assert.equal((await get(f1)).about_label, 'Plan draft');
    await assert.rejects(post({ title: 'x'.repeat(201), kind: 'decision' }), /one line/);
    await post({ title: 'We start with accounting firms', kind: 'decision' });
    // Replacing: the old one stays readable, is marked, and drops out of what AIs are shown.
    const s2 = await post({ title: 'Tool recheck', kind: 'status', replaces: s1 });
    assert.equal((await get(s1)).replaced_by_id, s2);
    await assert.rejects(post({ title: 'Again', kind: 'status', replaces: s1 }), /already been replaced/);
    const read = await nickAI.call('read_contributions', { project_id: pid });
    assert.ok(read.startsWith(`## [${r1}] REFERENCE:`), 'reference comes first');
    assert.doesNotMatch(read, /Tool check"/);
    assert.match(read, /1 replaced contribution\(s\) not shown/);
    assert.match(read, /DRAFT: "Second draft".*not yet used in the document/);
    assert.match(await nickAI.call('read_contributions', { project_id: pid, kind: 'status', include_replaced: true }), /Tool check".*REPLACED by/);
    assert.match(await nickAI.call('get_project', { project_id: pid }), new RegExp(`Reference to read first[^]*\\[${r1}\\] "Background"`));
    // Only drafts go into the document, and a draft shows where it stands.
    await assert.rejects(nickAI.call('add_to_document', { contribution_id: r1 }), /Only drafts can be added.*filed as reference/);
    await nickAI.call('add_to_document', { contribution_id: d1 });
    assert.deepEqual((await get(d1)).standing, { state: 'in_document', since_number: 1 });
    const plan = await nickAI.call('plan_next_steps', { project_id: pid });
    const offered = plan.split('## Shared drafts not yet in the document')[1].split('##')[0];
    assert.match(offered, /Second draft/);
    assert.doesNotMatch(offered, /Tool|Background|On the plan|accounting/);
    assert.match(plan, /## Recent feedback to resolve\n- \[c_[^\]]+\] "On the plan".*about Plan draft/);
    assert.match(plan, /## Decisions already made\n- \[c_[^\]]+\] "We start with accounting firms"/);
    // The author or owner can refile; then it follows the new type's rules. Others cannot.
    const refiled = await nickWeb('PATCH', `/api/contributions/${d2}`, { kind: 'reference' });
    assert.equal(refiled.kind, 'reference');
    assert.equal(refiled.standing, undefined);
    await assert.rejects(nickAI.call('add_to_document', { contribution_id: d2 }), /Only drafts/);
    await assert.rejects(nickWeb('PATCH', `/api/contributions/${d2}`, { kind: 'feedback' }), /what it is about/);
    const inv = await nickWeb('POST', `/api/projects/${pid}/invites`, { email: 'austin@example.com', role: 'editor' });
    await austinWeb('POST', `/api/invites/${inv.token}/accept`, {});
    await assert.rejects(austinWeb('PATCH', `/api/contributions/${d2}`, { kind: 'draft' }), /Only its author or the project owner/);
    await assert.rejects(austinAI.call('post_contribution', { project_id: pid, title: 'Mine now', content: 'z', kind: 'draft', replaces: d1 }), /Only its author or the project owner/);
    // With a second reviewer, a draft in an open proposal says who it is waiting on.
    const d3 = await post({ title: 'Third draft', kind: 'draft' });
    await nickAI.call('add_to_document', { contribution_id: d3 });
    const st = (await get(d3)).standing;
    assert.equal(st.state, 'proposed');
    assert.deepEqual(st.waiting_on, ['Austin']);
  });

  await step('out-of-date proposals cannot be approved; adds are redone, edits need their author', async () => {
    const pid = (await nickAI.call('create_project', { name: 'Stale test' })).match(/\[(p_[^\]]+)\]/)[1];
    const web = (who) => (m, path, body) => who(m, path, body);
    const propose = (who, body, extra = {}) => who('POST', `/api/projects/${pid}/versions`, { title: 'Doc', body, ...extra });
    const reviewV = (who, v, decision = 'approve', comment = '') => who('POST', `/api/versions/${v.id}/review`, { decision, comment });
    const v1 = await propose(nickWeb, '# Doc\n\n## Plan\n\nOriginal.');           // Nick is alone: current at once
    assert.equal(v1.status, 'approved');
    const inv = await nickWeb('POST', `/api/projects/${pid}/invites`, { email: 'austin@example.com', role: 'editor' });
    await austinWeb('POST', `/api/invites/${inv.token}/accept`, {});
    // Two edits written against v1. Nick's is approved first.
    const a = await propose(nickWeb, '# Doc\n\n## Plan\n\nOriginal.\n\nChange A.');
    const b = await propose(austinWeb, '# Doc\n\n## Plan\n\nOriginal.\n\nChange B.');
    assert.equal((await reviewV(austinWeb, a)).became_current, true);
    // Austin's is now out of date: it cannot be approved, by web or by AI, and it does not overwrite Change A.
    assert.equal((await nickWeb('GET', `/api/versions/${b.id}`)).stale, true);
    await assert.rejects(reviewV(nickWeb, b), /out of date and cannot be approved.*written against v1.*now v2.*Austin/s);
    await assert.rejects(nickAI.call('review_version', { version_id: b.id, decision: 'approve' }), /out of date and cannot be approved/);
    assert.match(await nickAI.call('get_project', { project_id: pid }), /OUT OF DATE: written against v1/);
    assert.match((await nickWeb('GET', `/api/projects/${pid}`)).current_version.body, /Change A\./);
    await reviewV(nickWeb, b, 'request_changes', 'Please update to v2.');           // still allowed
    // Austin brings it up to date: a new proposal on v2 that replaces the old one. It needs approval like any other.
    const b2 = await propose(austinWeb, '# Doc\n\n## Plan\n\nOriginal.\n\nChange A.\n\nChange B.', { counter_to: b.id });
    assert.equal(b2.origin, 'update');
    assert.equal(b2.stale, false);
    assert.equal((await nickWeb('GET', `/api/versions/${b.id}`)).status, 'replaced');
    assert.equal((await reviewV(nickWeb, b2)).became_current, true);
    const now3 = (await nickWeb('GET', `/api/projects/${pid}`)).current_version;
    assert.match(now3.body, /Change A\.\n\nChange B\./, 'both changes survive');
    // "Add to document" proposals are redone on the new version and keep their approvals.
    const post = (title, text) => nickWeb('POST', `/api/projects/${pid}/contributions`, { title, body: text, kind: 'draft', visibility: 'shared' });
    const c1 = await post('Risks', 'Risk one.'), c2 = await post('Budget', 'Ten dollars.');
    const add1 = await nickWeb('POST', `/api/contributions/${c1.id}/add-to-document`, { section_index: 1 });
    const add2 = await nickWeb('POST', `/api/contributions/${c2.id}/add-to-document`, {});
    assert.equal((await reviewV(austinWeb, add1)).became_current, true);
    const redone = await nickWeb('GET', `/api/versions/${add2.id}`);
    assert.equal(redone.stale, false, 'redone automatically');
    assert.match(redone.body, /### Risks\n\nRisk one\.[^]*## Budget\n\nTen dollars\.$/, 'contains the other add and its own');
    assert.deepEqual(redone.sources.map((s) => s.id), [c1.id, c2.id]);
    assert.equal((await reviewV(austinWeb, add2)).became_current, true);
    const log = (await nickWeb('GET', `/api/projects/${pid}/activity`)).map((x) => x.action);
    assert.ok(log.includes('brought_up_to_date'));
    // A proposal that every reviewer already approved does not slip through when it goes out of date.
    const inv2 = await nickWeb('POST', `/api/projects/${pid}/invites`, { email: 'client@example.com', role: 'commenter' });
    await clientWeb('POST', `/api/invites/${inv2.token}/accept`, {});
    const x = await propose(nickWeb, 'X only.'), y = await propose(nickWeb, 'Y only.');
    await reviewV(austinWeb, x); await reviewV(austinWeb, y);                      // both wait only on the client
    const client = (await nickWeb('GET', `/api/projects/${pid}`)).members.find((mm) => mm.name === 'Client');
    await nickWeb('DELETE', `/api/projects/${pid}/members/${client.id}`, {});         // removing them satisfies both at once
    const after = await nickWeb('GET', `/api/projects/${pid}`);
    assert.equal(after.current_version.id, x.id, 'the first becomes current');
    assert.deepEqual(after.open_proposals.map((v) => [v.id, v.stale]), [[y.id, true]], 'the second is held as out of date');
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
