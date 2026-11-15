// JSON API for the web workspace (cookie sessions), plus the OAuth sign-in/consent page.
import express from 'express';
import * as core from './core.js';
import * as auth from './auth.js';
import { config } from './config.js';

const COOKIE = 'atelier_session';
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.sessionTtl * 1000, path: '/' };

function currentUser(req) {
  return auth.sessionUser(req.cookies?.[COOKIE]);
}

const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (!(e instanceof core.AppError)) console.error(e);
    res.status(e.status || 500).json({ error: e instanceof core.AppError ? e.message : 'Something went wrong.' });
  }
};

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));

  // Mutations must be JSON: with SameSite=Lax cookies this blocks cross-site form posts (CSRF).
  r.use((req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
    next();
  });

  r.post('/signup', handle((req, res) => {
    const u = auth.signUp(req.body);
    res.cookie(COOKIE, auth.createSession(u.id), cookieOpts);
    return { user: u };
  }));
  r.post('/login', handle((req, res) => {
    const u = auth.logIn(req.body);
    res.cookie(COOKIE, auth.createSession(u.id), cookieOpts);
    return { user: u };
  }));
  r.post('/logout', handle((req, res) => {
    auth.destroySession(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
  }));
  r.get('/config', handle(() => ({ mcpUrl: config.mcpUrl, baseUrl: config.baseUrl, signupCodeRequired: Boolean(config.signupCode) })));
  r.get('/invites/:token', handle((req) => {
    const i = core.getInvite(req.params.token);
    return { project_name: i.project_name, invited_by: i.invited_by_name, email: i.email, role: i.role, used: Boolean(i.accepted_at) };
  }));

  // Everything below needs a signed-in user.
  r.use((req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    req.user = user;
    req.actor = { userId: user.id, via: 'hand' };
    next();
  });

  r.get('/me', handle((req) => ({ user: req.user, connections: auth.listConnections(req.user.id) })));
  r.delete('/me/connections/:clientId', handle((req) => auth.disconnect(req.user.id, req.params.clientId)));
  r.post('/invites/:token/accept', handle((req) => ({ project_id: core.acceptInvite(req.actor, req.params.token) })));

  r.get('/projects', handle((req) => core.listProjects(req.actor)));
  r.post('/projects', handle((req) => core.createProject(req.actor, req.body)));
  r.get('/projects/:pid', handle((req) => core.getProject(req.actor, req.params.pid)));
  r.patch('/projects/:pid', handle((req) => core.updateProject(req.actor, req.params.pid, req.body)));

  r.get('/projects/:pid/invites', handle((req) => core.listInvites(req.actor, req.params.pid)));
  r.post('/projects/:pid/invites', handle((req) => core.createInvite(req.actor, req.params.pid, req.body)));
  r.delete('/invites/:iid', handle((req) => core.revokeInvite(req.actor, req.params.iid)));
  r.patch('/projects/:pid/members/:uid', handle((req) => core.setMemberRole(req.actor, req.params.pid, req.params.uid, req.body.role)));
  r.delete('/projects/:pid/members/:uid', handle((req) => core.removeMember(req.actor, req.params.pid, req.params.uid)));

  r.get('/projects/:pid/contributions', handle((req) => core.listContributions(req.actor, req.params.pid, { member: req.query.member })));
  r.post('/projects/:pid/contributions', handle((req) => core.postContribution(req.actor, req.params.pid, req.body)));
  r.get('/contributions/:cid', handle((req) => core.getContribution(req.actor, req.params.cid)));
  r.get('/projects/:pid/sections', handle((req) => core.documentSections(req.actor, req.params.pid)));
  r.post('/contributions/:cid/replace-document', handle((req) => core.replaceDocument(req.actor, req.params.cid)));
  r.post('/contributions/:cid/add-to-document', handle((req) => core.addToDocument(req.actor, req.params.cid, { sectionIndex: req.body.section_index })));
  r.patch('/contributions/:cid', handle((req) => (req.body.kind !== undefined
    ? core.setContributionKind(req.actor, req.params.cid, req.body.kind, { about: req.body.about })
    : core.setContributionVisibility(req.actor, req.params.cid, req.body.visibility))));

  r.get('/projects/:pid/versions', handle((req) => core.listVersions(req.actor, req.params.pid)));
  r.post('/projects/:pid/versions', handle((req) => core.propose(req.actor, req.params.pid, {
    title: req.body.title, body: req.body.body, summary: req.body.summary,
    contributionIds: req.body.contribution_ids, counterTo: req.body.counter_to,
  })));
  r.get('/versions/:vid', handle((req) => core.getVersion(req.actor, req.params.vid)));
  r.post('/versions/:vid/review', handle((req) => core.review(req.actor, req.params.vid, req.body)));
  r.post('/versions/:vid/withdraw', handle((req) => core.withdraw(req.actor, req.params.vid)));
  r.post('/versions/:vid/restore', handle((req) => core.restore(req.actor, req.params.vid)));

  r.get('/comments', handle((req) => core.listComments(req.actor, req.query.target)));
  r.post('/comments', handle((req) => core.postComment(req.actor, {
    targetId: req.body.target_id, body: req.body.body, parentId: req.body.parent_id, quote: req.body.quote,
  })));

  r.get('/projects/:pid/next-steps', handle((req) => core.listNextSteps(req.actor, req.params.pid)));
  r.post('/projects/:pid/next-steps', handle((req) => core.saveNextSteps(req.actor, req.params.pid, req.body.body)));
  r.get('/projects/:pid/activity', handle((req) => core.listActivity(req.actor, req.params.pid)));
  return r;
}

// ---------- OAuth sign-in + consent (server-rendered, no JS needed) ----------

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Atelier</title><link rel="stylesheet" href="/styles.css"></head>
<body class="center-page"><main class="card narrow"><div class="brand">Atelier</div>${body}</main></body></html>`;
}

export function consentRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.get('/oauth/consent', (req, res) => {
    const pr = auth.pendingRequest(req.query.req);
    if (!pr) return res.status(400).send(page('Expired', '<h1>This sign-in link expired</h1><p>Go back to your AI app and connect Atelier again.</p>'));
    const user = currentUser(req);
    const clientName = pr.client?.client_name || 'An AI app';
    const err = req.query.error ? `<p class="error">${esc(req.query.error)}</p>` : '';
    if (!user) {
      const mode = req.query.mode === 'signup' ? 'signup' : 'login';
      const signup = mode === 'signup';
      return res.send(page('Sign in', `
        <h1>${signup ? 'Create your Atelier account' : 'Sign in to Atelier'}</h1>
        <p class="muted"><strong>${esc(clientName)}</strong> wants to connect to your Atelier projects.</p>${err}
        <form method="post" action="/oauth/${mode}" class="stack">
          <input type="hidden" name="req" value="${esc(pr.id)}"><input type="hidden" name="csrf" value="${esc(pr.csrf)}">
          ${signup ? '<label>Name<input name="name" required autocomplete="name"></label>' : ''}
          <label>Email<input name="email" type="email" required autocomplete="email"></label>
          <label>Password<input name="password" type="password" required minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
          ${signup && config.signupCode ? '<label>Sign-up code<input name="signupCode" required></label>' : ''}
          <button class="primary">${signup ? 'Create account' : 'Sign in'}</button>
        </form>
        <p class="muted small">${signup ? `Have an account? <a href="?req=${esc(pr.id)}">Sign in</a>` : `New here? <a href="?req=${esc(pr.id)}&mode=signup">Create an account</a>`}</p>`));
    }
    const guess = auth.guessAiLabel(clientName);
    res.send(page('Connect', `
      <h1>Connect ${esc(clientName)}?</h1>
      <p>Signed in as <strong>${esc(user.name)}</strong> (${esc(user.email)}). <a href="/oauth/switch?req=${esc(pr.id)}">Not you?</a></p>
      <p>This AI will be able to read the projects you belong to and, when you ask it to, post contributions, propose versions, review and comment <em>as you</em>. Atelier asks it to confirm with you before it writes.</p>
      <p class="muted small">When your AI reads a teammate's shared writing, that text is sent to your AI's provider.</p>${err}
      <form method="post" action="/oauth/consent" class="stack">
        <input type="hidden" name="req" value="${esc(pr.id)}"><input type="hidden" name="csrf" value="${esc(pr.csrf)}">
        <label>How should your work be credited?
          <input name="ai_label" value="${esc(guess)}" maxlength="40" required>
          <span class="muted small">Shown as "via ${esc(guess)}". For an open-source model, name it, e.g. "Qwen3 via LibreChat".</span>
        </label>
        <div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Cancel</button></div>
      </form>`));
  });

  const checkCsrf = (req) => {
    const pr = auth.pendingRequest(req.body.req);
    if (!pr || pr.csrf !== req.body.csrf) throw new core.AppError(400, 'This sign-in request expired. Start the connection again from your AI app.');
    return pr;
  };
  const back = (res, reqId, msg, mode = '') => res.redirect(`/oauth/consent?req=${encodeURIComponent(reqId)}${mode}&error=${encodeURIComponent(msg)}`);

  r.post('/oauth/login', (req, res) => {
    try {
      checkCsrf(req);
      const u = auth.logIn(req.body);
      res.cookie(COOKIE, auth.createSession(u.id), cookieOpts);
      res.redirect(`/oauth/consent?req=${encodeURIComponent(req.body.req)}`);
    } catch (e) { back(res, req.body.req, e.message); }
  });
  r.post('/oauth/signup', (req, res) => {
    try {
      checkCsrf(req);
      const u = auth.signUp(req.body);
      res.cookie(COOKIE, auth.createSession(u.id), cookieOpts);
      res.redirect(`/oauth/consent?req=${encodeURIComponent(req.body.req)}`);
    } catch (e) { back(res, req.body.req, e.message, '&mode=signup'); }
  });
  r.get('/oauth/switch', (req, res) => {
    auth.destroySession(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(`/oauth/consent?req=${encodeURIComponent(req.query.req || '')}`);
  });
  r.post('/oauth/consent', (req, res) => {
    try {
      checkCsrf(req);
      const user = currentUser(req);
      if (!user) return res.redirect(`/oauth/consent?req=${encodeURIComponent(req.body.req)}`);
      if (req.body.decision !== 'allow') return res.redirect(auth.denyRequest(req.body.req));
      const label = (req.body.ai_label || '').trim().slice(0, 40) || 'AI assistant';
      res.redirect(auth.approveRequest(req.body.req, user.id, label));
    } catch (e) { back(res, req.body.req, e.message); }
  });
  return r;
}
