// Atelier web workspace: a small dependency-free single-page app.
(function () {
  'use strict';

  // ---------- helpers ----------
  const $app = document.getElementById('app');
  const state = { me: null, config: null };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only ever used with sanitized markdown
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      // Inside flex rows, wrap bare text so the gap spaces it like the other items.
      el.append(kid instanceof Node ? kid : /\b(meta|row)\b/.test(el.className) ? h('span', {}, String(kid)) : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login' && path !== '/me') { state.me = null; route(); throw new Error(data.error || 'Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
  }
  const fail = (e) => toast(e.message, true);

  // Show a document's title only when its body does not already open with that heading.
  function docTitle(tag, title, body, style) {
    const first = (body || '').trimStart().split('\n')[0];
    if (/^#\s/.test(first)) return null;
    return h(tag, { style }, title);
  }
  function md(text) {
    const html = window.DOMPurify.sanitize(window.marked.parse(text || '', { gfm: true, breaks: false }));
    return h('div', { class: 'doc', html });
  }
  function when(iso) {
    const d = new Date(iso), s = (Date.now() - d) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const whenEl = (iso) => h('time', { datetime: iso, title: new Date(iso).toLocaleString() }, when(iso));
  const viaPill = (via) => via === 'hand' ? h('span', { class: 'pill hand', title: 'Written directly in Atelier' }, 'by hand') : h('span', { class: 'pill via', title: 'Made through this AI' }, 'via ' + via);
  const statusPill = (v, isCurrent) => isCurrent ? h('span', { class: 'pill current' }, 'current') : h('span', { class: 'pill ' + v.status }, v.status);
  const byline = (name, via, iso) => h('span', { class: 'meta' }, name, viaPill(via), '·', whenEl(iso));
  const canWrite = (role) => role === 'owner' || role === 'editor';
  const canReview = (role) => role !== 'viewer';
  const originLabel = (v) => ({ merge: 'combined version', counter: `counter-proposal to v${v.counter_to_number}`, restore: `restore of v${v.restored_from_number}`, add: 'added contribution', edit: 'edit' }[v.origin] || 'edit');

  function setCrumbs(...parts) {
    const c = document.getElementById('crumbs');
    c.replaceChildren(...parts.flatMap((p, i) => [i ? h('span', {}, '/') : null, p]).filter(Boolean));
  }
  function render(...nodes) { $app.replaceChildren(...nodes); window.scrollTo(0, 0); }
  function copyBtn(text, label = 'Copy') {
    return h('button', { onclick: async (e) => { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = label), 1500); } }, label);
  }
  function parseHash() {
    const [path, query] = location.hash.replace(/^#/, '').split('?');
    return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query || '') };
  }

  // ---------- routing ----------
  async function route() {
    const inviteMatch = location.pathname.match(/^\/invite\/([\w-]+)/);
    if (inviteMatch) return inviteView(inviteMatch[1]);
    if (!state.me) {
      try { const r = await api('GET', '/me'); state.me = r.user; } catch { state.me = null; }
    }
    const top = document.getElementById('topbar');
    if (!state.me) { top.hidden = true; return authView(parseHash().parts[0] === 'signup' ? 'signup' : 'login'); }
    top.hidden = false;
    document.getElementById('me-link').textContent = state.me.name;
    const { parts, params } = parseHash();
    try {
      if (parts[0] === 'p' && parts[2] === 'new') return await editorView(parts[1], params);
      if (parts[0] === 'p') return await projectView(parts[1], parts[2] || 'document', params);
      if (parts[0] === 'v') return await versionView(parts[1], params);
      if (parts[0] === 'c') return await contributionView(parts[1]);
      if (parts[0] === 'account') return await accountView();
      return await dashboardView();
    } catch (e) {
      render(h('div', { class: 'card' }, h('h2', {}, 'Could not open this page'), h('p', { class: 'muted' }, e.message), h('a', { href: '#/' }, 'Back to projects')));
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- auth ----------
  function authView(mode) {
    const signup = mode === 'signup';
    const err = h('p', { class: 'error' });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      try {
        const r = await api('POST', signup ? '/signup' : '/login', f);
        state.me = r.user;
        const pending = sessionStorage.getItem('atelier_invite');
        if (pending) { sessionStorage.removeItem('atelier_invite'); location.href = '/invite/' + pending; return; }
        location.hash = '#/'; route();
      } catch (ex) { err.textContent = ex.message; }
    } },
      signup ? h('label', {}, 'Name', h('input', { name: 'name', required: true, autocomplete: 'name' })) : null,
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h('label', {}, 'Password', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: signup ? 'new-password' : 'current-password' })),
      signup && state.config?.signupCodeRequired ? h('label', {}, 'Sign-up code', h('input', { name: 'signupCode', required: true })) : null,
      err,
      h('button', { class: 'primary' }, signup ? 'Create account' : 'Sign in'));
    render(h('div', { class: 'center-page', style: 'min-height:80vh' }, h('div', { class: 'card narrow' },
      h('div', { class: 'brand' }, 'Atelier'),
      h('h1', {}, signup ? 'Create your account' : 'Sign in'),
      h('p', { class: 'muted' }, 'A shared project workspace. Write by hand here, or through the AI you already use.'),
      form,
      h('p', { class: 'muted small' }, signup ? h('span', {}, 'Have an account? ', h('a', { href: '#/login', onclick: () => setTimeout(route) }, 'Sign in'))
        : h('span', {}, 'New here? ', h('a', { href: '#/signup', onclick: () => setTimeout(route) }, 'Create an account'))))));
  }

  async function inviteView(token) {
    document.getElementById('topbar').hidden = true;
    let inv;
    try { inv = await api('GET', '/invites/' + token); } catch (e) {
      return render(h('div', { class: 'card narrow' }, h('h1', {}, 'Invite not found'), h('p', {}, e.message), h('a', { href: '/' }, 'Go to Atelier')));
    }
    try { const r = await api('GET', '/me'); state.me = r.user; } catch { state.me = null; }
    const body = [h('div', { class: 'brand' }, 'Atelier'), h('h1', {}, `Join “${inv.project_name}”`),
      h('p', {}, `${inv.invited_by} invited ${inv.email} as ${inv.role === 'commenter' ? 'a commenter' : 'an ' + inv.role}.`)];
    if (inv.used) body.push(h('p', { class: 'muted' }, 'This invite has already been used. If it was you, open Atelier to find the project.'), h('a', { class: 'btn', href: '/' }, 'Open Atelier'));
    else if (!state.me) {
      sessionStorage.setItem('atelier_invite', token);
      body.push(h('p', { class: 'muted' }, 'Sign in or create an account to accept.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/#/signup' }, 'Create account'), h('a', { class: 'btn', href: '/#/login' }, 'Sign in')));
    } else {
      if (state.me.email !== inv.email) body.push(h('p', { class: 'banner warn' }, `You are signed in as ${state.me.email}. The invite was sent to ${inv.email}, but you can still accept it with this account.`));
      body.push(h('button', { class: 'primary', onclick: async () => {
        try { const r = await api('POST', `/invites/${token}/accept`); location.href = '/#/p/' + r.project_id; } catch (e) { fail(e); }
      } }, 'Accept and open project'));
    }
    render(h('div', { class: 'center-page', style: 'min-height:80vh' }, h('div', { class: 'card narrow stack' }, ...body)));
  }

  // ---------- dashboard ----------
  async function dashboardView() {
    setCrumbs();
    const projects = await api('GET', '/projects');
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try { const p = await api('POST', '/projects', Object.fromEntries(new FormData(form))); location.hash = '#/p/' + p.id + '/members'; } catch (ex) { fail(ex); }
    } },
      h('label', {}, 'Project name', h('input', { name: 'name', required: true, placeholder: 'e.g. Studio pitch deck' })),
      h('label', {}, 'Goal', h('textarea', { name: 'goal', rows: 2, placeholder: 'What should the finished document do?' })),
      h('button', { class: 'primary' }, 'Create project'));
    render(h('div', { class: 'grid2' },
      h('section', {},
        h('h1', {}, 'Your projects'),
        projects.length ? h('div', { class: 'list' }, projects.map((p) => h('a', { class: 'item', href: '#/p/' + p.id },
          h('div', { class: 'row between' }, h('span', { class: 'title' }, p.name), h('span', { class: 'pill' }, p.role)),
          p.goal ? h('div', { class: 'muted small' }, p.goal) : null,
          h('div', { class: 'meta' }, `${p.member_count} member${p.member_count === 1 ? '' : 's'}`,
            p.open_proposals ? h('span', { class: 'pill proposed' }, `${p.open_proposals} to review`) : null,
            p.last_activity ? h('span', {}, '· active ', whenEl(p.last_activity)) : null))))
          : h('div', { class: 'card empty' }, 'No projects yet. Create one, or open an invite link someone sent you.')),
      h('aside', {}, h('div', { class: 'card' }, h('h2', {}, 'New project'), form), connectCard())));
  }

  function connectCard() {
    const url = state.config?.mcpUrl || '';
    return h('div', { class: 'card' },
      h('h2', {}, 'Use your own AI'),
      h('p', { class: 'muted small' }, 'Add this connector URL to Claude, ChatGPT or an open-source chat app, then sign in. Your AI can then read and post to your projects.'),
      h('div', { class: 'row' }, h('span', { class: 'code' }, url), copyBtn(url)),
      h('p', { class: 'small' }, h('a', { href: '#/account' }, 'Setup steps and connected apps →')));
  }

  // ---------- project ----------
  async function projectView(pid, tab, params) {
    const p = await api('GET', '/projects/' + pid);
    setCrumbs(h('a', { href: '#/' }, 'Projects'), h('a', { href: '#/p/' + pid }, p.name));
    const tabs = [['document', 'Document'], ['contributions', 'Contributions'], ['history', 'History'], ['activity', 'Activity'], ['next', 'Next steps'], ['members', 'Members'], ['connect', 'Connect AI']];
    const header = h('div', {},
      h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, p.name),
        canWrite(p.my_role) ? h('div', { class: 'row' },
          h('a', { class: 'btn', href: `#/p/${pid}/new?mode=contribution` }, 'New contribution'),
          h('a', { class: 'btn primary', href: `#/p/${pid}/new?mode=proposal${p.current_version ? '&from=' + p.current_version.id : ''}` }, p.current_version ? 'Edit document' : 'Write first version'))
          : h('span', { class: 'pill' }, 'You are a ' + p.my_role)),
      p.goal ? h('p', { class: 'muted', style: 'margin-top:6px' }, p.goal) : null,
      h('nav', { class: 'tabs' }, tabs.map(([k, label]) => h('a', { href: `#/p/${pid}/${k}`, class: tab === k ? 'active' : '' }, label,
        k === 'document' && p.open_proposals.length ? h('span', { class: 'count' }, p.open_proposals.length) : null))));
    const body = await ({ document: docTab, contributions: contribTab, history: historyTab, activity: activityTab, next: nextStepsTab, members: membersTab, connect: connectTab }[tab] || docTab)(p, params);
    render(header, body);
  }

  function proposalItem(v, role, meId) {
    const a = v.approval;
    const mine = v.author_id === meId;
    const needsMe = !mine && canReview(role) && a && a.waiting_on.includes(state.me.name);
    return h('a', { class: 'item', href: '#/v/' + v.id },
      h('div', { class: 'row between' }, h('span', { class: 'title' }, `v${v.number} · ${v.title}`),
        h('span', { class: 'row' }, needsMe ? h('span', { class: 'pill proposed' }, 'needs your review') : null, statusPill(v))),
      h('div', { class: 'meta' }, originLabel(v), '·', byline(v.author_name, v.via, v.created_at)),
      v.summary ? h('div', { class: 'small' }, v.summary) : null,
      a ? h('div', { class: 'meta' }, a.approved_by.length ? `Approved by ${a.approved_by.join(', ')}` : 'No approvals yet',
        a.changes_requested_by.length ? h('span', { class: 'error' }, `· Changes requested by ${a.changes_requested_by.join(', ')}`) : null,
        a.waiting_on.length ? `· Waiting on ${a.waiting_on.join(', ')}` : null,
        v.stale ? h('span', { class: 'pill' }, `based on v${v.base_number}`) : null) : null);
  }

  function docTab(p) {
    const v = p.current_version;
    const out = h('div', { class: 'grid2' });
    const main = h('section', {});
    if (v) {
      main.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'meta' }, h('span', { class: 'pill current' }, `current · v${v.number}`), byline(v.author_name, v.via, v.created_at)),
          h('a', { href: '#/v/' + v.id, class: 'small' }, 'Comments & details →')),
        docTitle('h2', v.title, v.body, 'margin-top:12px'),
        h('div', { style: 'margin-top:12px' }, md(v.body))));
    } else {
      main.append(h('div', { class: 'card empty' },
        h('h2', {}, 'No current version yet'),
        h('p', {}, 'Each person posts a draft as a contribution (by hand or through their AI). Then anyone combines them into a proposal, and the others approve it.'),
        canWrite(p.my_role) ? h('div', { class: 'row', style: 'justify-content:center' },
          h('a', { class: 'btn', href: `#/p/${p.id}/new?mode=contribution` }, 'Post a contribution'),
          h('a', { class: 'btn primary', href: `#/p/${p.id}/new?mode=proposal` }, 'Write first version')) : null));
    }
    const side = h('aside', {},
      h('div', { class: 'card' }, h('h2', {}, 'Open proposals'),
        p.open_proposals.length ? h('div', { class: 'list' }, p.open_proposals.map((x) => proposalItem(x, p.my_role, state.me.id)))
          : h('p', { class: 'muted small' }, 'Nothing waiting for review.')),
      h('div', { class: 'card' }, h('h3', {}, 'Members'), p.members.map((m) => h('div', { class: 'row between small' }, m.name, h('span', { class: 'muted' }, m.role)))));
    out.append(main, side);
    return out;
  }

  async function contribTab(p, params) {
    const member = params.get('member') || '';
    const list = await api('GET', `/projects/${p.id}/contributions${member ? '?member=' + encodeURIComponent(member) : ''}`);
    const filter = h('select', { onchange: (e) => { location.hash = `#/p/${p.id}/contributions${e.target.value ? '?member=' + e.target.value : ''}`; } },
      h('option', { value: '' }, 'Everyone'), p.members.map((m) => h('option', { value: m.id, selected: m.id === member }, m.name)));
    return h('section', {},
      h('div', { class: 'row between', style: 'margin-bottom:12px' }, h('div', { class: 'row' }, h('span', { class: 'muted' }, 'From'), filter),
        h('span', { class: 'muted small' }, 'Contributions are never edited after posting. Private ones are visible only to their author.')),
      list.length ? h('div', { class: 'list' }, list.map((c) => h('a', { class: 'item', href: '#/c/' + c.id },
        h('div', { class: 'row between' }, h('span', { class: 'title' }, c.title), h('span', { class: 'row' }, c.kind !== 'draft' ? h('span', { class: 'pill' }, c.kind) : null, h('span', { class: 'pill ' + c.visibility }, c.visibility))),
        byline(c.author_name, c.via, c.created_at),
        h('div', { class: 'muted small' }, c.body.slice(0, 220).replace(/[#*_>`]/g, '') + (c.body.length > 220 ? '…' : '')))))
        : h('div', { class: 'card empty' }, 'No contributions yet.'));
  }

  async function historyTab(p) {
    const versions = await api('GET', `/projects/${p.id}/versions`);
    if (!versions.length) return h('div', { class: 'card empty' }, 'No versions yet.');
    return h('div', { class: 'list' }, versions.map((v) => h('a', { class: 'item', href: '#/v/' + v.id },
      h('div', { class: 'row between' }, h('span', { class: 'title' }, `v${v.number} · ${v.title}`), statusPill(v, v.id === p.current_version_id)),
      h('div', { class: 'meta' }, originLabel(v), '·', byline(v.author_name, v.via, v.created_at),
        v.sources.length ? `· from ${v.sources.map((s) => s.author_name).join(', ')}` : null),
      v.summary ? h('div', { class: 'small' }, v.summary) : null)));
  }

  const ACTIONS = {
    created_project: 'created the project', invited: 'invited', joined: 'joined', posted_contribution: 'posted a contribution',
    shared_contribution: 'shared a contribution', made_private: 'made a contribution private', proposed: 'proposed', approved: 'approved',
    requested_changes: 'requested changes on', became_current: '', withdrew: 'withdrew', commented: 'commented on', replied: 'replied on',
    changed_role: 'changed a role', removed_member: 'removed', left: 'left the project', updated_project: 'updated the project', updated_next_steps: 'updated the next steps',
  };
  function targetLink(id, text) {
    if (!id) return null;
    if (id.startsWith('v_')) return h('a', { href: '#/v/' + id }, text);
    if (id.startsWith('c_')) return h('a', { href: '#/c/' + id }, text);
    return text;
  }
  async function nextStepsTab(p) {
    const ns = await api('GET', `/projects/${p.id}/next-steps`);
    const cur = ns.current;
    const out = h('div', { class: 'stack' });
    const card = h('div', { class: 'card' });
    if (cur) {
      card.append(h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Next steps'), byline(cur.author_name, cur.via, cur.created_at)));
      if (ns.changes_since.length) {
        const n = ns.changes_since.length;
        card.append(h('p', { class: 'muted small', style: 'margin:8px 0 0' },
          h('span', { class: 'pill' }, 'May be out of date'), ` ${n} change${n === 1 ? '' : 's'} to the project since these were written. Ask your AI to refresh the next steps, or update them by hand below.`));
      }
      card.append(h('div', { style: 'margin-top:12px' }, md(cur.body)));
    } else {
      card.append(h('h2', { style: 'margin:0' }, 'Next steps'),
        h('p', { class: 'muted', style: 'margin:8px 0 0' }, 'None yet. A connected AI writes them after it changes the project, and refreshes them each time. You can also write them by hand.'));
    }
    out.append(card);
    if (canReview(p.my_role)) {
      const box = h('textarea', { rows: 8, placeholder: '1. What to do, who does it, and why it matters…', value: cur ? cur.body : '' });
      out.append(h('details', { class: 'card' }, h('summary', {}, cur ? 'Update by hand' : 'Write by hand'),
        h('div', { class: 'stack', style: 'margin-top:12px' }, box,
          h('p', { class: 'muted small', style: 'margin:0' }, 'Saving replaces the list above. The old one moves to the history.'),
          h('div', {}, h('button', { class: 'primary', onclick: async () => {
            try { await api('POST', `/projects/${p.id}/next-steps`, { body: box.value }); toast('Next steps saved'); route(); } catch (e) { fail(e); }
          } }, 'Save next steps')))));
    }
    if (ns.history.length) {
      out.append(h('div', { class: 'card' }, h('h2', { style: 'margin:0 0 4px' }, 'History'),
        ns.history.map((n) => h('details', { style: 'padding:8px 0;border-top:1px solid var(--border)' },
          h('summary', {}, byline(n.author_name, n.via, n.created_at)), h('div', { style: 'margin-top:8px' }, md(n.body))))));
    }
    return out;
  }
  async function activityTab(p) {
    const rows = await api('GET', `/projects/${p.id}/activity`);
    return h('div', { class: 'card' }, h('ul', { class: 'activity' }, rows.map((a) => h('li', {},
      h('div', {}, a.action === 'became_current' ? targetLink(a.target_id, a.detail) : h('span', {}, h('strong', {}, a.actor_name), ' ', ACTIONS[a.action] || a.action, ' ', targetLink(a.target_id, a.detail) || a.detail)),
      h('div', { class: 'meta' }, a.action === 'became_current' ? 'after approval by ' + a.actor_name : viaPill(a.via), '·', whenEl(a.created_at))))));
  }

  async function membersTab(p) {
    const owner = p.my_role === 'owner';
    const wrap = h('div', { class: 'grid2' });
    const members = h('div', { class: 'card' }, h('h2', {}, 'Members'),
      h('p', { class: 'muted small' }, 'Editors write contributions and propose versions. Commenters read, comment and approve or request changes (the usual role for an outside client). Viewers only read.'),
      p.members.map((m) => h('div', { class: 'row between', style: 'padding:8px 0;border-top:1px solid var(--border)' },
        h('div', {}, h('div', {}, m.name, m.id === state.me.id ? h('span', { class: 'muted' }, ' (you)') : null), h('div', { class: 'muted small' }, m.email)),
        owner && m.role !== 'owner' ? h('div', { class: 'row' },
          h('select', { onchange: async (e) => { try { await api('PATCH', `/projects/${p.id}/members/${m.id}`, { role: e.target.value }); toast('Role updated'); } catch (ex) { fail(ex); } } },
            ['editor', 'commenter', 'viewer'].map((r) => h('option', { value: r, selected: r === m.role }, r))),
          h('button', { class: 'danger', onclick: async () => { if (!confirm(`Remove ${m.name} from the project?`)) return; try { await api('DELETE', `/projects/${p.id}/members/${m.id}`); route(); } catch (ex) { fail(ex); } } }, 'Remove'))
          : h('span', { class: 'pill' }, m.role))),
      !owner && p.my_role !== 'owner' ? h('button', { class: 'danger', style: 'margin-top:12px', onclick: async () => { if (!confirm('Leave this project?')) return; try { await api('DELETE', `/projects/${p.id}/members/${state.me.id}`); location.hash = '#/'; } catch (ex) { fail(ex); } } }, 'Leave project') : null);
    const side = h('aside', {});
    if (owner) {
      const invites = await api('GET', `/projects/${p.id}/invites`);
      const inviteLink = (i) => `${location.origin}/invite/${i.token}`;
      const form = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        try { const i = await api('POST', `/projects/${p.id}/invites`, Object.fromEntries(new FormData(form))); await navigator.clipboard?.writeText(inviteLink(i)).catch(() => {}); toast('Invite link created and copied'); route(); } catch (ex) { fail(ex); }
      } },
        h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true })),
        h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'commenter' }, 'Commenter'), h('option', { value: 'viewer' }, 'Viewer'))),
        h('button', { class: 'primary' }, 'Create invite link'));
      side.append(h('div', { class: 'card' }, h('h2', {}, 'Invite someone'), h('p', { class: 'muted small' }, 'Atelier makes a link for you to send them (email delivery is not set up in this prototype).'), form,
        invites.length ? h('div', { style: 'margin-top:16px' }, h('h3', {}, 'Pending invites'), invites.map((i) => h('div', { class: 'stack', style: 'padding:8px 0;border-top:1px solid var(--border);gap:6px' },
          h('div', { class: 'row between' }, h('span', {}, i.email, h('span', { class: 'muted' }, ' · ' + i.role)), h('button', { class: 'link danger', onclick: async () => { await api('DELETE', '/invites/' + i.id); route(); } }, 'Revoke')),
          h('div', { class: 'row' }, h('span', { class: 'code small' }, inviteLink(i)), copyBtn(inviteLink(i)))))) : null));
      const settings = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('PATCH', `/projects/${p.id}`, Object.fromEntries(new FormData(settings))); toast('Saved'); route(); } catch (ex) { fail(ex); }
      } },
        h('label', {}, 'Name', h('input', { name: 'name', value: p.name })),
        h('label', {}, 'Goal', h('textarea', { name: 'goal', rows: 3, value: p.goal })),
        h('label', {}, 'When does a proposal become current?', h('select', { name: 'approval_rule' },
          h('option', { value: 'all', selected: p.approval_rule === 'all' }, 'Every other member approves (default)'),
          h('option', { value: 'owner', selected: p.approval_rule === 'owner' }, 'The owner approves (larger projects)'))),
        h('button', {}, 'Save settings'));
      side.append(h('div', { class: 'card' }, h('h2', {}, 'Project settings'), settings));
    }
    wrap.append(members, side);
    return wrap;
  }

  function connectSteps() {
    const url = state.config?.mcpUrl || '';
    return h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('span', { class: 'code' }, url), copyBtn(url)),
      !url.startsWith('https://') ? h('p', { class: 'banner warn small' }, 'This server is running on a non-HTTPS address. Claude and ChatGPT can only connect to an HTTPS URL; see the README for a one-command tunnel.') : null,
      h('h3', {}, 'Claude (claude.ai or desktop app)'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open Settings → Connectors → Add custom connector.'),
        h('li', {}, 'Name it “Atelier”, paste the URL above, and click Add.'),
        h('li', {}, 'Click Connect, sign in to Atelier, and click Allow.'),
        h('li', {}, 'In a chat, turn on Atelier in the tools menu and try: “What projects do I have in Atelier?”')),
      h('p', { class: 'muted small' }, 'Works on Free, Pro, Max, Team and Enterprise. Free allows one custom connector. On Team/Enterprise an owner may need to add it first.'),
      h('h3', {}, 'ChatGPT (web, paid plan)'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Settings → Apps & Connectors → Advanced settings → turn on Developer mode.'),
        h('li', {}, 'Back in Apps & Connectors, click Create. Name it “Atelier”, paste the URL, choose OAuth, and confirm you trust it.'),
        h('li', {}, 'Sign in to Atelier and click Allow.'),
        h('li', {}, 'In a new chat, pick Developer mode from the + menu, enable Atelier, and ask: “List my Atelier projects.”')),
      h('p', { class: 'muted small' }, 'Not available on the Free plan or mobile. If ChatGPT can read but not post on your plan, post your draft on the Contributions tab here instead.'),
      h('h3', {}, 'Open-source model (LibreChat, Open WebUI, LM Studio)'),
      h('p', { class: 'small' }, 'Add Atelier as a remote MCP server using the “Streamable HTTP” transport and the URL above, with OAuth. On the sign-in screen, name your model (e.g. “Qwen3 via LibreChat”) so your work is credited correctly. Smaller models are less reliable at calling tools; check results in the Activity tab.'),
      h('h3', {}, 'Good to know'),
      h('ul', { class: 'small' },
        h('li', {}, 'Your AI acts as you, and every post is labeled with the AI that made it.'),
        h('li', {}, 'When your AI reads a teammate\'s shared writing, that text is sent to your AI\'s provider.'),
        h('li', {}, 'Atelier runs no AI of its own. Merges happen in your AI, as proposals the others approve.')));
  }
  function connectTab() { return h('div', { class: 'card' }, h('h2', {}, 'Connect your AI to this project'), connectSteps()); }

  // ---------- editor ----------
  async function editorView(pid, params) {
    const p = await api('GET', '/projects/' + pid);
    setCrumbs(h('a', { href: '#/' }, 'Projects'), h('a', { href: '#/p/' + pid }, p.name), h('span', {}, 'Write'));
    if (!canWrite(p.my_role)) throw new Error(`Your role is ${p.my_role}, which cannot write here.`);
    let mode = params.get('mode') === 'contribution' ? 'contribution' : 'proposal';
    const fromId = params.get('from'), counterId = params.get('counter');
    const contribs = await api('GET', `/projects/${pid}/contributions`);
    let base = null;
    if (counterId || fromId) base = await api('GET', '/versions/' + (counterId || fromId));
    const preselect = new Set((params.get('sources') || '').split(',').filter(Boolean));
    if (counterId && base) base.sources.forEach((s) => !s.private && preselect.add(s.id));

    const title = h('input', { name: 'title', required: true, value: base ? base.title : (mode === 'contribution' ? `${state.me.name}'s draft` : p.name), placeholder: 'Title' });
    const draftKey = `atelier_draft_${pid}_${mode}_${fromId || counterId || ''}`;
    let saved = null; try { saved = localStorage.getItem(draftKey); } catch { /* storage unavailable */ }
    const body = h('textarea', { name: 'body', placeholder: 'Write in Markdown…', value: saved ?? (base ? base.body : '') });
    const preview = h('div', { class: 'preview' });
    const update = () => { preview.replaceChildren(md(body.value || '*Preview*')); try { localStorage.setItem(draftKey, body.value); } catch { /* ignore */ } };
    body.addEventListener('input', update); update();

    const contribFields = h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('strong', {}, 'Who can see it?'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'visibility', value: 'shared', checked: true }), 'Shared with the project'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'visibility', value: 'private' }), 'Private (only me)')),
      h('p', { class: 'muted small' }, 'Shared contributions can be read by members and their AIs, which sends the text to those AI providers.'),
      h('label', {}, 'Kind', h('select', { name: 'kind' }, h('option', { value: 'draft' }, 'Draft'), h('option', { value: 'note' }, 'Note'), h('option', { value: 'transcript' }, 'Chat transcript or summary'))));
    const proposalFields = h('div', { class: 'stack' },
      counterId ? h('p', { class: 'banner' }, `This is a counter-proposal to v${base.number}.`) : null,
      p.current_version && !counterId && fromId !== p.current_version.id ? h('p', { class: 'banner warn small' }, `Heads up: the current version is v${p.current_version.number}.`) : null,
      h('label', {}, 'What changed? (shown to reviewers)', h('input', { name: 'summary', placeholder: 'e.g. Merged Nick\'s budget section into my outline' })),
      contribs.length ? h('fieldset', { style: 'border:1px solid var(--border);border-radius:8px;padding:10px' },
        h('legend', { class: 'small muted' }, 'Built from these contributions'),
        contribs.map((c) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', name: 'sources', value: c.id, checked: preselect.has(c.id) }),
          `${c.title} — ${c.author_name}`, viaPill(c.via), c.visibility === 'private' ? h('span', { class: 'pill private' }, 'private') : null,
          h('button', { type: 'button', class: 'link small', onclick: () => { body.value += (body.value ? '\n\n' : '') + c.body; update(); } }, 'insert text')))) : null,
      h('p', { class: 'muted small' }, 'A proposal becomes the current version after the other members approve it.'));

    const modeSel = h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', value: 'proposal', checked: mode === 'proposal', onchange: () => { mode = 'proposal'; sync(); } }), 'Propose as the next version'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', value: 'contribution', checked: mode === 'contribution', onchange: () => { mode = 'contribution'; sync(); } }), 'Save as my contribution'));
    const submit = h('button', { class: 'primary' });
    function sync() { contribFields.classList.toggle('hidden', mode !== 'contribution'); proposalFields.classList.toggle('hidden', mode !== 'proposal'); submit.textContent = mode === 'proposal' ? 'Submit for approval' : 'Save contribution'; }
    sync();

    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        if (mode === 'contribution') {
          const c = await api('POST', `/projects/${pid}/contributions`, { title: fd.get('title'), body: fd.get('body'), visibility: fd.get('visibility'), kind: fd.get('kind') });
          try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
          location.hash = '#/c/' + c.id;
        } else {
          const v = await api('POST', `/projects/${pid}/versions`, { title: fd.get('title'), body: fd.get('body'), summary: fd.get('summary'), contribution_ids: fd.getAll('sources'), counter_to: counterId || undefined });
          try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
          toast(v.status === 'approved' ? 'Saved as the current version' : 'Proposal submitted for approval');
          location.hash = '#/v/' + v.id;
        }
      } catch (ex) { fail(ex); }
    } },
      counterId ? null : modeSel, title,
      h('div', { class: 'editor' }, body, preview),
      contribFields, proposalFields,
      h('div', { class: 'row' }, submit, h('a', { class: 'btn', href: '#/p/' + pid, onclick: () => { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } } }, 'Cancel')));
    render(h('div', { class: 'card' }, form));
  }

  // ---------- diff view ----------
  function diffTable(oldText, newText, leftLabel, rightLabel) {
    const rows = window.AtelierDiff.rows(oldText, newText);
    const tbody = h('tbody');
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const wordHtml = (l, r) => {
      const ops = window.AtelierDiff.words(l, r);
      let L = '', R = '';
      for (const [op, a, b] of ops) {
        if (op === '=') { L += esc(a); R += esc(b); } else if (op === '-') L += `<del>${esc(a)}</del>`; else R += `<ins>${esc(b)}</ins>`;
      }
      return [L, R];
    };
    let sameRun = [];
    const flushSame = () => {
      const show = (r) => tbody.append(h('tr', {}, h('td', {}, r.left), h('td', {}, r.right)));
      if (sameRun.length > 8) {
        sameRun.slice(0, 3).forEach(show);
        const hidden = sameRun.slice(3, -3);
        const fold = h('tr', { class: 'fold' }, h('td', { colspan: 2 }, h('button', { class: 'link', onclick: () => { const frag = hidden.map((r) => h('tr', {}, h('td', {}, r.left), h('td', {}, r.right))); fold.replaceWith(...frag); } }, `${hidden.length} unchanged lines`)));
        tbody.append(fold);
        sameRun.slice(-3).forEach(show);
      } else sameRun.forEach(show);
      sameRun = [];
    };
    let changes = 0;
    for (const r of rows) {
      if (r.type === 'same') { sameRun.push(r); continue; }
      flushSame(); changes++;
      if (r.left !== null && r.right !== null) {
        const [L, R] = wordHtml(r.left, r.right);
        tbody.append(h('tr', {}, h('td', { class: 'del', html: L }), h('td', { class: 'add', html: R })));
      } else {
        tbody.append(h('tr', {}, h('td', { class: r.left !== null ? 'del' : 'blank' }, r.left ?? ''), h('td', { class: r.right !== null ? 'add' : 'blank' }, r.right ?? '')));
      }
    }
    flushSame();
    return h('div', {},
      !changes ? h('p', { class: 'muted small' }, 'No differences.') : null,
      h('div', { class: 'diff-wrap' }, h('table', { class: 'diff' }, h('thead', {}, h('tr', {}, h('th', {}, leftLabel), h('th', {}, rightLabel))), tbody)));
  }

  async function compareSection(v) {
    const options = [];
    if (v.base_version_id && v.base_version_id !== v.id) options.push({ key: 'v:' + v.base_version_id, label: `Previous current version (v${v.base_number})` });
    if (v.counter_to_id) options.push({ key: 'v:' + v.counter_to_id, label: `The proposal it answers (v${v.counter_to_number})` });
    for (const s of v.sources) if (!s.private) options.push({ key: 'c:' + s.id, label: `${s.author_id === state.me.id ? 'My' : s.author_name + '’s'} contribution: ${s.title}` });
    if (!options.length) return null;
    const mineIdx = options.findIndex((o) => o.label.startsWith('My '));
    const sel = h('select', {}, options.map((o, i) => h('option', { value: o.key, selected: i === (mineIdx >= 0 ? mineIdx : 0) }, o.label)));
    const out = h('div');
    const load = async () => {
      const [kind, id] = sel.value.split(':');
      const other = kind === 'v' ? await api('GET', '/versions/' + id) : await api('GET', '/contributions/' + id);
      const label = kind === 'v' ? `v${other.number} · ${other.author_name}` : `${other.title} · ${other.author_name}`;
      out.replaceChildren(diffTable(other.body, v.body, label, `v${v.number} · ${v.author_name}`));
    };
    sel.addEventListener('change', () => load().catch(fail));
    await load();
    return h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'What changed'), h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Compare with'), sel)), h('div', { style: 'margin-top:12px' }, out));
  }

  // ---------- comments ----------
  async function commentsPanel(targetId, canComment, docEl) {
    const comments = await api('GET', '/comments?target=' + encodeURIComponent(targetId));
    const panel = h('div', { class: 'card comments' });
    let quote = '';
    const quoteEl = h('div', { class: 'quote hidden' });
    const text = h('textarea', { rows: 3, placeholder: 'Add a comment…' });
    const setQuote = (q) => { quote = q; quoteEl.textContent = q ? `“${q}”` : ''; quoteEl.classList.toggle('hidden', !q); };
    const post = async (body, parentId, q) => {
      await api('POST', '/comments', { target_id: targetId, body, parent_id: parentId, quote: q || undefined });
      toast('Comment posted');
      route();
    };
    const byParent = new Map();
    for (const c of comments) { const k = c.parent_id || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(c); }
    const renderComment = (c, depth) => {
      const replyBox = h('div', { class: 'hidden stack', style: 'margin-top:6px' });
      const replyText = h('textarea', { rows: 2, placeholder: 'Reply…' });
      replyBox.append(replyText, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => replyText.value.trim() && post(replyText.value, c.id).catch(fail) }, 'Reply')));
      return h('div', { class: 'comment' + (depth ? ' reply' : '') },
        byline(c.author_name, c.via, c.created_at),
        c.quote ? h('div', { class: 'quote' }, `“${c.quote}”`) : null,
        h('div', { class: 'comment-body' }, c.body),
        canComment && !depth ? h('button', { class: 'link small', onclick: () => replyBox.classList.toggle('hidden') }, 'Reply') : null,
        replyBox,
        (byParent.get(c.id) || []).map((r) => renderComment(r, depth + 1)));
    };
    panel.append(h('h2', {}, 'Comments', comments.length ? h('span', { class: 'count' }, comments.length) : null),
      (byParent.get('') || []).map((c) => renderComment(c, 0)),
      !comments.length ? h('p', { class: 'muted small' }, 'No comments yet.') : null);
    if (canComment) {
      panel.append(h('div', { class: 'stack', style: 'margin-top:12px' },
        h('p', { class: 'muted small', style: 'margin:0' }, 'Tip: select text in the document to comment on that passage.'),
        quoteEl, text,
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => text.value.trim() && post(text.value, null, quote).catch(fail) }, 'Comment'),
          h('button', { class: 'link small', onclick: () => setQuote('') }, 'clear passage'))));
      if (docEl) attachSelectionComment(docEl, (q) => { setQuote(q); text.focus(); });
    }
    return panel;
  }

  function attachSelectionComment(docEl, onPick) {
    let btn = null;
    const clear = () => { btn?.remove(); btn = null; };
    docEl.addEventListener('mouseup', () => setTimeout(() => {
      clear();
      const sel = window.getSelection();
      const q = sel?.toString().trim();
      if (!q || !docEl.contains(sel.anchorNode)) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      btn = h('button', { class: 'sel-btn primary small', style: `top:${window.scrollY + rect.bottom + 6}px;left:${window.scrollX + rect.left}px`, onmousedown: (e) => { e.preventDefault(); onPick(q.slice(0, 500)); clear(); } }, 'Comment on selection');
      document.body.append(btn);
    }));
    document.addEventListener('mousedown', (e) => { if (btn && e.target !== btn) clear(); });
    window.addEventListener('hashchange', clear, { once: true });
  }

  // ---------- version ----------
  async function versionView(vid) {
    const v = await api('GET', '/versions/' + vid);
    const p = await api('GET', '/projects/' + v.project_id);
    setCrumbs(h('a', { href: '#/' }, 'Projects'), h('a', { href: '#/p/' + p.id }, p.name), h('a', { href: `#/p/${p.id}/history` }, 'History'), h('span', {}, 'v' + v.number));
    const role = v.my_role;
    const mine = v.author_id === state.me.id;
    const doc = md(v.body);
    const main = h('section', {},
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'meta' }, statusPill(v, v.is_current), `v${v.number}`, '·', originLabel(v), '·', byline(v.author_name, v.via, v.created_at)),
          v.stale ? h('span', { class: 'pill', title: 'The current version changed after this was proposed' }, `based on v${v.base_number}`) : null),
        v.summary ? h('p', { class: 'banner small', style: 'margin-top:12px' }, v.summary) : null,
        docTitle('h1', v.title, v.body, 'margin-top:12px'), h('div', { style: 'margin-top:12px' }, doc),
        v.sources.length ? h('div', { class: 'meta', style: 'margin-top:16px;border-top:1px solid var(--border);padding-top:10px' }, 'Built from:',
          v.sources.map((s) => s.private ? h('span', { class: 'pill' }, `${s.author_name} (private)`) : h('a', { class: 'pill', href: '#/c/' + s.id }, `${s.title} · ${s.author_name}`))) : null));
    const cmp = await compareSection(v);
    if (cmp) main.append(cmp);

    const side = h('aside', {});
    if (v.status === 'proposed') {
      const a = v.approval;
      const panel = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Review'), h('p', { class: 'muted small', style: 'margin:0' }, a.rule),
        h('div', { class: 'approval' },
          a.approved_by.map((n) => h('div', { class: 'who' }, h('span', { class: 'dot ok' }), n, h('span', { class: 'muted small' }, 'approved'))),
          a.changes_requested_by.map((n) => h('div', { class: 'who' }, h('span', { class: 'dot bad' }), n, h('span', { class: 'muted small' }, 'requested changes'))),
          a.waiting_on.map((n) => h('div', { class: 'who' }, h('span', { class: 'dot wait' }), n, h('span', { class: 'muted small' }, 'waiting')))));
      if (!mine && canReview(role)) {
        const note = h('textarea', { rows: 3, placeholder: 'Optional note (required to request changes)' });
        const doReview = async (decision) => {
          try {
            const r = await api('POST', `/versions/${vid}/review`, { decision, comment: note.value });
            toast(r.became_current ? `v${r.number} is now the current version` : decision === 'approve' ? 'Approved' : 'Changes requested');
            route();
          } catch (e) { fail(e); }
        };
        panel.append(note, h('div', { class: 'row' }, h('button', { class: 'ok', onclick: () => doReview('approve') }, 'Approve'), h('button', { onclick: () => doReview('request_changes') }, 'Request changes')));
      } else if (mine) panel.append(h('p', { class: 'muted small' }, 'This is your proposal. The other members review it.'));
      const acts = h('div', { class: 'row' });
      if (canWrite(role) && !mine) acts.append(h('a', { class: 'btn', href: `#/p/${p.id}/new?mode=proposal&counter=${v.id}` }, 'Counter-propose'));
      if (mine) acts.append(h('a', { class: 'btn', href: `#/p/${p.id}/new?mode=proposal&counter=${v.id}` }, 'Revise'),
        h('button', { class: 'danger', onclick: async () => { if (!confirm('Withdraw this proposal?')) return; try { await api('POST', `/versions/${vid}/withdraw`); route(); } catch (e) { fail(e); } } }, 'Withdraw'));
      panel.append(acts);
      side.append(panel);
    } else {
      const acts = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, v.is_current ? 'Current version' : `This version is ${v.status}`));
      if (v.decided_at) acts.append(h('p', { class: 'muted small', style: 'margin:0' }, `${v.status === 'withdrawn' ? 'Withdrawn' : 'Approved'} ${new Date(v.decided_at).toLocaleString()}`));
      if (v.reviews.length) acts.append(h('div', { class: 'approval' }, v.reviews.map((r) => h('div', { class: 'who small' },
        h('span', { class: 'dot ' + (r.decision === 'approve' ? 'ok' : 'bad') }), r.reviewer, r.decision === 'approve' ? 'approved' : 'requested changes', viaPill(r.via), h('span', { class: 'muted' }, when(r.at))))));
      if (canWrite(role) && v.is_current) acts.append(h('a', { class: 'btn primary', href: `#/p/${p.id}/new?mode=proposal&from=${v.id}` }, 'Edit and propose changes'));
      if (canWrite(role) && !v.is_current) acts.append(h('button', { onclick: async () => {
        if (!confirm(`Propose restoring v${v.number}? The other members will need to approve it.`)) return;
        try { const r = await api('POST', `/versions/${vid}/restore`); location.hash = '#/v/' + r.id; } catch (e) { fail(e); }
      } }, `Restore v${v.number}`));
      side.append(acts);
    }
    side.append(await commentsPanel(v.id, canReview(role), doc));
    render(h('div', { class: 'grid2' }, main, side));
  }

  // ---------- contribution ----------
  async function contributionView(cid) {
    const c = await api('GET', '/contributions/' + cid);
    const p = await api('GET', '/projects/' + c.project_id);
    setCrumbs(h('a', { href: '#/' }, 'Projects'), h('a', { href: '#/p/' + p.id }, p.name), h('a', { href: `#/p/${p.id}/contributions` }, 'Contributions'), h('span', {}, c.title));
    const mine = c.author_id === state.me.id;
    const doc = md(c.body);
    const main = h('div', { class: 'card' },
      h('div', { class: 'row between' }, byline(c.author_name, c.via, c.created_at), h('span', { class: 'row' }, c.kind !== 'draft' ? h('span', { class: 'pill' }, c.kind) : null, h('span', { class: 'pill ' + c.visibility }, c.visibility))),
      docTitle('h1', c.title, c.body, 'margin-top:12px'), h('div', { style: 'margin-top:12px' }, doc));
    const side = h('aside', {});
    const acts = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Contribution'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Contributions are never edited, by anyone. To change it, post a new one.'));
    if (mine) {
      const next = c.visibility === 'shared' ? 'private' : 'shared';
      acts.append(h('button', { onclick: async () => {
        if (next === 'shared' && !confirm('Share with the project? Members, and the AIs they use, will be able to read it. When their AI reads it, the text goes to that AI\'s provider.')) return;
        try { await api('PATCH', '/contributions/' + cid, { visibility: next }); toast(`Now ${next}`); route(); } catch (e) { fail(e); }
      } }, next === 'shared' ? 'Share with project' : 'Make private'));
    }
    if (canWrite(p.my_role) && c.visibility === 'shared') acts.append(h('a', { class: 'btn', href: `#/p/${p.id}/new?mode=proposal&sources=${c.id}${p.current_version ? '&from=' + p.current_version.id : ''}` }, 'Use in a proposal'));
    if (canWrite(p.my_role) && c.visibility === 'shared') {
      // Mechanical add: the whole contribution goes in under the chosen heading, as a normal proposal.
      const sections = p.current_version ? await api('GET', `/projects/${p.id}/sections`) : [];
      const where = h('select', {}, h('option', { value: '' }, 'End of document'),
        sections.map((s) => h('option', { value: String(s.index) }, '  '.repeat(s.level - 1) + s.title)));
      acts.append(h('hr', { style: 'width:100%;border:0;border-top:1px solid var(--border);margin:4px 0' }),
        p.current_version ? h('label', {}, 'Add to the document under', where) : null,
        h('button', { class: 'primary', onclick: async () => {
          try {
            const v = await api('POST', `/contributions/${cid}/add-to-document`, { section_index: where.value === '' ? null : Number(where.value) });
            toast(v.status === 'approved' ? `Added. v${v.number} is now the current version.` : `Proposed as v${v.number}. It needs approval.`);
            location.hash = '#/v/' + v.id;
          } catch (e) { fail(e); }
        } }, p.current_version ? 'Propose adding to document' : 'Start the document from this'),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Adds this contribution as written. Nothing else in the document changes, and the other members approve it like any proposal.'));
    }
    side.append(acts, await commentsPanel(c.id, canReview(p.my_role), doc));
    render(h('div', { class: 'grid2' }, main, side));
  }

  // ---------- account ----------
  async function accountView() {
    setCrumbs(h('span', {}, 'Account'));
    const r = await api('GET', '/me');
    render(h('div', { class: 'grid2' },
      h('section', {}, h('div', { class: 'card' }, h('h2', {}, 'Connect your AI'), connectSteps())),
      h('aside', {},
        h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, r.user.name), h('div', { class: 'muted' }, r.user.email),
          h('button', { onclick: async () => { await api('POST', '/logout', {}); state.me = null; location.hash = '#/'; route(); } }, 'Sign out')),
        h('div', { class: 'card' }, h('h2', {}, 'Connected AI apps'),
          r.connections.length ? r.connections.map((c) => h('div', { class: 'row between', style: 'padding:6px 0;border-top:1px solid var(--border)' },
            h('div', {}, viaPill(c.ai_label), h('div', { class: 'muted small' }, `${c.client_name || 'Unnamed app'} · since ${new Date(c.connected_at).toLocaleDateString()}`)),
            h('button', { class: 'danger', onclick: async () => { if (!confirm('Disconnect this app? It will need to sign in again.')) return; await api('DELETE', '/me/connections/' + encodeURIComponent(c.client_id)); route(); } }, 'Disconnect')))
            : h('p', { class: 'muted small' }, 'No AI apps connected yet.')))));
  }

  // Refresh when coming back to the tab, so a teammate's new posts show up.
  let lastFocusRefresh = Date.now();
  window.addEventListener('focus', () => {
    const editing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
    if (state.me && !editing && !location.hash.includes('/new') && Date.now() - lastFocusRefresh > 10000) { lastFocusRefresh = Date.now(); route(); }
  });

  api('GET', '/config').then((c) => { state.config = c; }).catch(() => {}).finally(route);
})();
