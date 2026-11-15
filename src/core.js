// Domain logic shared by the web workspace and the MCP tools.
// Every function takes an `actor` ({ userId, via }) and checks permissions itself,
// so the two front doors can never disagree about who may do what.
import { one, all, run, tx, id, now } from './db.js';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const notFound = (what) => new AppError(404, `${what} not found, or you do not have access to it.`);
const forbidden = (msg) => new AppError(403, msg);
const bad = (msg) => new AppError(400, msg);

const ROLES = ['owner', 'editor', 'commenter', 'viewer'];
const CAN = {
  write: ['owner', 'editor'],                    // post contributions, propose versions, restore
  review: ['owner', 'editor', 'commenter'],      // approve / request changes
  comment: ['owner', 'editor', 'commenter'],
  manage: ['owner'],                             // invite, roles, settings
};

export const userName = (userId) => one('SELECT name FROM users WHERE id = ?', userId)?.name ?? 'Unknown';

export function roleOf(projectId, userId) {
  return one('SELECT role FROM members WHERE project_id = ? AND user_id = ?', projectId, userId)?.role ?? null;
}

function requireRole(projectId, actor, ability) {
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  const role = project && roleOf(projectId, actor.userId);
  if (!role) throw notFound('Project');
  if (ability && !CAN[ability].includes(role)) {
    const what = { write: 'post or edit', review: 'review proposals', comment: 'comment', manage: 'manage this project' }[ability];
    throw forbidden(`Your role in this project is "${role}", which cannot ${what}.`);
  }
  return { project, role };
}

function log(projectId, actor, action, targetId, detail = '') {
  run('INSERT INTO activity (project_id, actor_id, via, action, target_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
    projectId, actor.userId, actor.via, action, targetId ?? null, detail, now());
}

// ---------- Projects & members ----------

export function listProjects(actor) {
  return all(`SELECT p.id, p.name, p.goal, p.created_at, m.role,
      (SELECT COUNT(*) FROM members WHERE project_id = p.id) AS member_count,
      (SELECT COUNT(*) FROM versions WHERE project_id = p.id AND status = 'proposed') AS open_proposals,
      (SELECT MAX(created_at) FROM activity WHERE project_id = p.id) AS last_activity
    FROM projects p JOIN members m ON m.project_id = p.id AND m.user_id = ?
    ORDER BY COALESCE(last_activity, p.created_at) DESC`, actor.userId);
}

export function createProject(actor, { name, goal = '' }) {
  name = (name || '').trim();
  if (!name) throw bad('A project needs a name.');
  const pid = id('p');
  tx(() => {
    run('INSERT INTO projects (id, name, goal, owner_id, created_at) VALUES (?,?,?,?,?)', pid, name, goal.trim(), actor.userId, now());
    run('INSERT INTO members (project_id, user_id, role, joined_at) VALUES (?,?,?,?)', pid, actor.userId, 'owner', now());
    log(pid, actor, 'created_project', pid, name);
  });
  return getProject(actor, pid);
}

export function getProject(actor, projectId) {
  const { project, role } = requireRole(projectId, actor);
  const members = all(`SELECT u.id, u.name, u.email, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END, u.name`, projectId);
  const current = project.current_version_id ? versionRow(project.current_version_id) : null;
  const proposals = all(`SELECT id FROM versions WHERE project_id = ? AND status = 'proposed' ORDER BY number DESC`, projectId)
    .map((v) => versionSummary(versionRow(v.id), project));
  return { ...project, my_role: role, members, current_version: current && decorateVersion(current, project), open_proposals: proposals };
}

export function updateProject(actor, projectId, { name, goal, approval_rule }) {
  requireRole(projectId, actor, 'manage');
  if (approval_rule && !['all', 'owner'].includes(approval_rule)) throw bad('approval_rule must be "all" or "owner".');
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  run('UPDATE projects SET name = ?, goal = ?, approval_rule = ? WHERE id = ?',
    (name ?? p.name).trim() || p.name, (goal ?? p.goal).trim(), approval_rule ?? p.approval_rule, projectId);
  log(projectId, actor, 'updated_project', projectId, [name && 'name', goal !== undefined && 'goal', approval_rule && `approval rule: ${approval_rule}`].filter(Boolean).join(', '));
  return getProject(actor, projectId);
}

export function createInvite(actor, projectId, { email, role = 'editor' }) {
  requireRole(projectId, actor, 'manage');
  email = (email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('Enter a valid email address.');
  if (!ROLES.includes(role) || role === 'owner') throw bad('Role must be editor, commenter or viewer.');
  const existing = one(`SELECT u.id FROM users u JOIN members m ON m.user_id = u.id AND m.project_id = ? WHERE u.email = ?`, projectId, email);
  if (existing) throw bad(`${email} is already a member of this project.`);
  const inv = { id: id('i'), token: id('inv', 18) };
  run('INSERT INTO invites (id, project_id, email, role, token, invited_by, created_at) VALUES (?,?,?,?,?,?,?)',
    inv.id, projectId, email, role, inv.token, actor.userId, now());
  log(projectId, actor, 'invited', inv.id, `${email} as ${role}`);
  return one('SELECT * FROM invites WHERE id = ?', inv.id);
}

export function listInvites(actor, projectId) {
  requireRole(projectId, actor, 'manage');
  return all('SELECT * FROM invites WHERE project_id = ? AND accepted_at IS NULL ORDER BY created_at DESC', projectId);
}

export function revokeInvite(actor, inviteId) {
  const inv = one('SELECT * FROM invites WHERE id = ?', inviteId);
  if (!inv) throw notFound('Invite');
  requireRole(inv.project_id, actor, 'manage');
  run('DELETE FROM invites WHERE id = ?', inviteId);
}

export function getInvite(token) {
  const inv = one(`SELECT i.*, p.name AS project_name, u.name AS invited_by_name FROM invites i
    JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.invited_by WHERE i.token = ?`, token);
  if (!inv) throw notFound('Invite');
  return inv;
}

export function acceptInvite(actor, token) {
  const inv = getInvite(token);
  if (inv.accepted_at) {
    if (roleOf(inv.project_id, actor.userId)) return inv.project_id;
    throw bad('This invite has already been used.');
  }
  tx(() => {
    if (!roleOf(inv.project_id, actor.userId)) {
      run('INSERT INTO members (project_id, user_id, role, joined_at) VALUES (?,?,?,?)', inv.project_id, actor.userId, inv.role, now());
    }
    run('UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ?', actor.userId, now(), inv.id);
    log(inv.project_id, actor, 'joined', actor.userId, `as ${inv.role}`);
  });
  return inv.project_id;
}

export function setMemberRole(actor, projectId, userId, role) {
  requireRole(projectId, actor, 'manage');
  if (!ROLES.includes(role) || role === 'owner') throw bad('Role must be editor, commenter or viewer.');
  const target = roleOf(projectId, userId);
  if (!target) throw notFound('Member');
  if (target === 'owner') throw bad('The owner\'s role cannot be changed.');
  run('UPDATE members SET role = ? WHERE project_id = ? AND user_id = ?', role, projectId, userId);
  log(projectId, actor, 'changed_role', userId, `${userName(userId)}: ${target} → ${role}`);
  reevaluateOpenProposals(projectId, actor);
}

export function removeMember(actor, projectId, userId) {
  const isSelf = userId === actor.userId;
  if (!isSelf) requireRole(projectId, actor, 'manage');
  const target = roleOf(projectId, userId);
  if (!target) throw notFound('Member');
  if (target === 'owner') throw bad('The owner cannot leave or be removed.');
  run('DELETE FROM members WHERE project_id = ? AND user_id = ?', projectId, userId);
  log(projectId, actor, isSelf ? 'left' : 'removed_member', userId, userName(userId));
  reevaluateOpenProposals(projectId, actor);
}

// ---------- Contributions ----------

// Contribution types. Each one changes what Atelier does with the contribution, not just its label.
export const KINDS = {
  draft: 'Text meant for the document. Offered for adding to the document and for merging.',
  feedback: 'A critique of the document or of a draft. Says which version or contribution it is about.',
  reference: 'Background to read first: research, a spec, context. Never offered for the document.',
  status: 'A dated report: test results, what was done. Kept out of document and planning suggestions.',
  decision: 'A choice the group has made, stated in one line as the title.',
  transcript: 'A saved chat or summary. Never offered for the document.',
};
const normKind = (k) => (k === 'note' ? 'reference' : k);   // "note" was the old name

const contribSelect = `SELECT c.*, u.name AS author_name,
  (SELECT r.id FROM contributions r WHERE r.replaces_id = c.id ORDER BY r.created_at LIMIT 1) AS replaced_by_id,
  (SELECT r.title FROM contributions r WHERE r.replaces_id = c.id ORDER BY r.created_at LIMIT 1) AS replaced_by_title
  FROM contributions c JOIN users u ON u.id = c.author_id`;

// Adds what the lists and pages show: what it replaces, what it is about, and where a draft stands.
function decorateContribution(c, project) {
  const out = { ...c };
  if (c.replaces_id) out.replaces_title = one('SELECT title FROM contributions WHERE id = ?', c.replaces_id)?.title ?? null;
  if (c.about_id) {
    out.about_label = c.about_id.startsWith('v_')
      ? `v${one('SELECT number FROM versions WHERE id = ?', c.about_id)?.number ?? '?'}`
      : one('SELECT title FROM contributions WHERE id = ?', c.about_id)?.title ?? 'a contribution';
  }
  if (c.kind === 'draft') {
    project ||= one('SELECT * FROM projects WHERE id = ?', c.project_id);
    const inCurrent = project.current_version_id && one('SELECT 1 AS x FROM version_sources WHERE version_id = ? AND contribution_id = ?', project.current_version_id, c.id);
    if (inCurrent) {
      const since = one(`SELECT MIN(v.number) AS n FROM version_sources s JOIN versions v ON v.id = s.version_id
        WHERE s.contribution_id = ? AND v.status IN ('approved','replaced')`, c.id).n;
      out.standing = { state: 'in_document', since_number: since };
    } else {
      const open = one(`SELECT v.* FROM version_sources s JOIN versions v ON v.id = s.version_id
        WHERE s.contribution_id = ? AND v.status = 'proposed' ORDER BY v.number DESC LIMIT 1`, c.id);
      out.standing = open
        ? { state: 'proposed', version_id: open.id, number: open.number, waiting_on: approvalState(project, open).waiting_on }
        : { state: 'unused' };
    }
  }
  return out;
}

function visibleContribution(actor, contributionId) {
  const c = one(`${contribSelect} WHERE c.id = ?`, contributionId);
  if (!c || !roleOf(c.project_id, actor.userId)) throw notFound('Contribution');
  if (c.visibility === 'private' && c.author_id !== actor.userId) throw notFound('Contribution');
  return c;
}

// Type-specific rules, shared by posting and by changing a contribution's type.
function checkKind(actor, projectId, kind, { title, about }) {
  if (!Object.hasOwn(KINDS, kind)) throw bad(`Choose a type: ${Object.keys(KINDS).join(', ')}.`);
  if (kind === 'feedback') {
    if (!about) throw bad('Feedback needs to say what it is about: give the id of a version (v_...) or a contribution (c_...).');
    if (targetProject(actor, about) !== projectId) throw bad('Feedback can only be about a version or contribution in the same project.');
  }
  if (kind === 'decision') {
    if (!title) throw bad('A decision needs a title that states, in one line, what was decided.');
    if (title.length > 200) throw bad('State the decision in one line (200 characters or fewer) as the title. Put the reasoning in the text.');
  }
}

export function postContribution(actor, projectId, { title, body, visibility = 'shared', kind = 'draft', about, replaces }) {
  const { role } = requireRole(projectId, actor, 'write');
  body = (body || '').trim();
  if (!body) throw bad('The contribution is empty.');
  if (!['private', 'shared'].includes(visibility)) throw bad('visibility must be "private" or "shared".');
  kind = normKind(kind);
  title = (title || '').trim();
  about = (about || '').trim() || null;
  replaces = (replaces || '').trim() || null;
  checkKind(actor, projectId, kind, { title, about });
  title ||= body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'Untitled';
  // A status is a dated report, so its title always starts with the day it was posted.
  if (kind === 'status' && !/^\d{4}-\d{2}-\d{2}\b/.test(title)) title = `${now().slice(0, 10)}: ${title}`;
  if (replaces) {
    const old = visibleContribution(actor, replaces);
    if (old.project_id !== projectId) throw bad('A contribution can only replace one in the same project.');
    if (old.author_id !== actor.userId && role !== 'owner') throw forbidden('Only its author or the project owner can replace a contribution.');
    if (old.replaced_by_id) throw bad(`"${old.title}" has already been replaced by "${old.replaced_by_title}". Replace that one instead.`);
    if (old.visibility === 'shared' && visibility !== 'shared') throw bad('A shared contribution can only be replaced by a shared one, so members can see what replaced it.');
  }
  const cid = id('c');
  run('INSERT INTO contributions (id, project_id, author_id, title, body, kind, visibility, via, created_at, about_id, replaces_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    cid, projectId, actor.userId, title, body, kind, visibility, actor.via, now(), kind === 'feedback' ? about : null, replaces);
  log(projectId, actor, 'posted_contribution', cid, `${title} (${kind}, ${visibility})`);
  return getContribution(actor, cid);
}

// The author or the project owner can refile a contribution under another type. Its text never changes.
export function setContributionKind(actor, contributionId, kind, { about } = {}) {
  const c = visibleContribution(actor, contributionId);
  const { role } = requireRole(c.project_id, actor);
  if (c.author_id !== actor.userId && role !== 'owner') throw forbidden('Only its author or the project owner can change a contribution\'s type.');
  kind = normKind(kind);
  about = (about || '').trim() || c.about_id || null;
  checkKind(actor, c.project_id, kind, { title: c.title, about });
  if (kind === c.kind) return getContribution(actor, contributionId);
  run('UPDATE contributions SET kind = ?, about_id = ? WHERE id = ?', kind, kind === 'feedback' ? about : null, contributionId);
  log(c.project_id, actor, 'changed_type', contributionId, `${c.title} (${c.kind} to ${kind})`);
  return getContribution(actor, contributionId);
}

export function listContributions(actor, projectId, { member, includeMine = true, limit = 100 } = {}) {
  requireRole(projectId, actor);
  let rows = all(`${contribSelect} WHERE c.project_id = ? AND (c.visibility = 'shared' OR c.author_id = ?) ORDER BY c.created_at DESC LIMIT ?`,
    projectId, actor.userId, Math.min(Number(limit) || 100, 500));
  if (member) {
    const m = String(member).toLowerCase();
    rows = rows.filter((r) => r.author_id === member || r.author_name.toLowerCase().includes(m) ||
      one('SELECT email FROM users WHERE id = ?', r.author_id).email.toLowerCase() === m);
  }
  if (!includeMine) rows = rows.filter((r) => r.author_id !== actor.userId);
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  return rows.map((r) => decorateContribution(r, project));
}

export function getContribution(actor, contributionId) {
  return decorateContribution(visibleContribution(actor, contributionId));
}

export function setContributionVisibility(actor, contributionId, visibility) {
  const c = visibleContribution(actor, contributionId);
  if (c.author_id !== actor.userId) throw forbidden('Only the author can change who sees a contribution.');
  if (!['private', 'shared'].includes(visibility)) throw bad('visibility must be "private" or "shared".');
  if (visibility === 'private') {
    const used = one(`SELECT v.number FROM version_sources s JOIN versions v ON v.id = s.version_id
      WHERE s.contribution_id = ? AND v.author_id != ?`, contributionId, actor.userId);
    if (used) throw bad(`This contribution was used in v${used.number} by another member, so it stays shared.`);
  }
  run('UPDATE contributions SET visibility = ? WHERE id = ?', visibility, contributionId);
  log(c.project_id, actor, visibility === 'shared' ? 'shared_contribution' : 'made_private', contributionId, c.title);
  return getContribution(actor, contributionId);
}

// ---------- Versions, proposals and review ----------

const versionRow = (vid) => one(`SELECT v.*, u.name AS author_name FROM versions v JOIN users u ON u.id = v.author_id WHERE v.id = ?`, vid);

function requiredApprovers(project, version) {
  const voters = all(`SELECT m.user_id, m.role, u.name FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? AND m.role IN ('owner','editor','commenter') AND m.user_id != ?`, project.id, version.author_id);
  return voters;
}

function latestReviews(versionId) {
  const rows = all(`SELECT r.*, u.name AS reviewer_name FROM reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.version_id = ? ORDER BY r.created_at`, versionId);
  const latest = new Map();
  for (const r of rows) latest.set(r.reviewer_id, r);
  return { history: rows, latest };
}

function approvalState(project, version) {
  const voters = requiredApprovers(project, version);
  const { history, latest } = latestReviews(version.id);
  const approvedBy = voters.filter((v) => latest.get(v.user_id)?.decision === 'approve');
  const changesBy = voters.filter((v) => latest.get(v.user_id)?.decision === 'request_changes');
  const waitingOn = voters.filter((v) => !latest.has(v.user_id));
  let rule, satisfied;
  if (project.approval_rule === 'owner' && version.author_id !== project.owner_id) {
    rule = 'The project owner\'s approval makes it current.';
    satisfied = latest.get(project.owner_id)?.decision === 'approve';
  } else if (project.approval_rule === 'owner') {
    rule = 'Proposed by the owner: one other member\'s approval makes it current.';
    satisfied = voters.length === 0 || approvedBy.length > 0;
  } else {
    rule = 'Every other member who can review must approve.';
    satisfied = approvedBy.length === voters.length;
  }
  return {
    rule, satisfied,
    approved_by: approvedBy.map((v) => v.name),
    changes_requested_by: changesBy.map((v) => v.name),
    waiting_on: waitingOn.map((v) => v.name),
    reviews: history.map((r) => ({ reviewer: r.reviewer_name, decision: r.decision, via: r.via, at: r.created_at, comment_id: r.comment_id })),
  };
}

function sourcesFor(actor, versionId) {
  return all(`SELECT c.id, c.title, c.visibility, c.author_id, c.via, c.created_at, u.name AS author_name
    FROM version_sources s JOIN contributions c ON c.id = s.contribution_id JOIN users u ON u.id = c.author_id
    WHERE s.version_id = ? ORDER BY c.created_at`, versionId)
    .map((c) => (c.visibility === 'private' && c.author_id !== actor?.userId)
      ? { id: c.id, title: '(private contribution)', author_name: c.author_name, private: true }
      : c);
}

function decorateVersion(v, project, actor) {
  const base = v.base_version_id ? one('SELECT number FROM versions WHERE id = ?', v.base_version_id) : null;
  const current = project.current_version_id ? one('SELECT number FROM versions WHERE id = ?', project.current_version_id) : null;
  const out = { ...v, base_number: base?.number ?? null, sources: sourcesFor(actor, v.id) };
  if (v.counter_to_id) out.counter_to_number = one('SELECT number FROM versions WHERE id = ?', v.counter_to_id)?.number;
  if (v.restored_from_id) out.restored_from_number = one('SELECT number FROM versions WHERE id = ?', v.restored_from_id)?.number;
  out.reviews = latestReviews(v.id).history.map((r) => ({ reviewer: r.reviewer_name, decision: r.decision, via: r.via, at: r.created_at }));
  if (v.status === 'proposed') {
    out.approval = approvalState(project, v);
    out.stale = Boolean(current && base?.number !== current.number);
  }
  return out;
}

function versionSummary(v, project) {
  const d = decorateVersion(v, project);
  delete d.body;
  return d;
}

export function listVersions(actor, projectId) {
  const { project } = requireRole(projectId, actor);
  return all(`SELECT id FROM versions WHERE project_id = ? ORDER BY number DESC`, projectId)
    .map((r) => { const v = decorateVersion(versionRow(r.id), project, actor); delete v.body; return v; });
}

export function getVersion(actor, versionId) {
  const v = versionRow(versionId);
  if (!v) throw notFound('Version');
  const { project, role } = requireRole(v.project_id, actor);
  return { ...decorateVersion(v, project, actor), my_role: role, is_current: project.current_version_id === v.id };
}

export function propose(actor, projectId, { title, body, summary = '', contributionIds = [], counterTo, origin, restoredFrom }) {
  const { project } = requireRole(projectId, actor, 'write');
  body = (body || '').trim();
  if (!body) throw bad('The proposed document is empty.');
  const ids = [...new Set(contributionIds || [])];
  for (const cid of ids) {
    const c = one('SELECT * FROM contributions WHERE id = ?', cid);
    if (!c || c.project_id !== projectId || (c.visibility === 'private' && c.author_id !== actor.userId)) {
      throw bad(`Contribution ${cid} is not a shared contribution in this project.`);
    }
  }
  if (counterTo) {
    const ct = one('SELECT * FROM versions WHERE id = ? AND project_id = ?', counterTo, projectId);
    if (!ct) throw bad(`Version ${counterTo} is not in this project.`);
  }
  origin = origin || (counterTo ? 'counter' : ids.length > 1 ? 'merge' : 'edit');
  const vid = id('v');
  tx(() => {
    const number = (one('SELECT MAX(number) AS n FROM versions WHERE project_id = ?', projectId).n || 0) + 1;
    title = (title || '').trim() || (project.current_version_id ? versionRow(project.current_version_id).title : project.name);
    run(`INSERT INTO versions (id, project_id, number, title, body, summary, author_id, via, origin, status, base_version_id, counter_to_id, restored_from_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?)`,
      vid, projectId, number, title, body, (summary || '').trim(), actor.userId, actor.via, origin,
      project.current_version_id, counterTo || null, restoredFrom || null, now());
    for (const cid of ids) run('INSERT INTO version_sources (version_id, contribution_id) VALUES (?,?)', vid, cid);
    const label = { edit: 'an edit', merge: `a combined version of ${ids.length} contributions`, counter: 'a counter-proposal', restore: 'a restore of an earlier version', add: 'adding one contribution to the document' }[origin];
    log(projectId, actor, 'proposed', vid, `v${number}, ${label}`);
    maybeApprove(project, vid, actor);
  });
  return getVersion(actor, vid);
}

function maybeApprove(project, versionId, actor) {
  project = one('SELECT * FROM projects WHERE id = ?', project.id);
  const v = versionRow(versionId);
  if (v.status !== 'proposed') return false;
  if (!approvalState(project, v).satisfied) return false;
  if (project.current_version_id) {
    run(`UPDATE versions SET status = 'replaced', decided_at = ? WHERE id = ?`, now(), project.current_version_id);
  }
  run(`UPDATE versions SET status = 'approved', decided_at = ? WHERE id = ?`, now(), versionId);
  if (v.counter_to_id) {
    // The proposal this answered is settled by the counter-proposal being approved.
    run(`UPDATE versions SET status = 'replaced', decided_at = ? WHERE id = ? AND status = 'proposed'`, now(), v.counter_to_id);
  }
  run('UPDATE projects SET current_version_id = ? WHERE id = ?', versionId, project.id);
  log(project.id, actor, 'became_current', versionId, `v${v.number} is now the current version`);
  return true;
}

function reevaluateOpenProposals(projectId, actor) {
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  for (const v of all(`SELECT id FROM versions WHERE project_id = ? AND status = 'proposed' ORDER BY number`, projectId)) {
    tx(() => maybeApprove(project, v.id, actor));
  }
}

export function review(actor, versionId, { decision, comment = '' }) {
  const v = versionRow(versionId);
  if (!v) throw notFound('Version');
  const { project } = requireRole(v.project_id, actor, 'review');
  if (!['approve', 'request_changes'].includes(decision)) throw bad('decision must be "approve" or "request_changes".');
  if (v.status !== 'proposed') throw bad(`v${v.number} is ${v.status}, not an open proposal.`);
  if (v.author_id === actor.userId) throw bad('You cannot review your own proposal. Other members review it.');
  if (decision === 'request_changes' && !comment.trim()) throw bad('Say what should change when requesting changes.');
  let became = false;
  tx(() => {
    let commentId = null;
    if (comment.trim()) {
      commentId = id('m');
      run('INSERT INTO comments (id, project_id, target_id, parent_id, author_id, body, quote, via, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        commentId, v.project_id, versionId, null, actor.userId,
        `${decision === 'approve' ? 'Approved' : 'Requested changes'}: ${comment.trim()}`, null, actor.via, now());
    }
    run('INSERT INTO reviews (id, version_id, reviewer_id, decision, comment_id, via, created_at) VALUES (?,?,?,?,?,?,?)',
      id('r'), versionId, actor.userId, decision, commentId, actor.via, now());
    log(v.project_id, actor, decision === 'approve' ? 'approved' : 'requested_changes', versionId, `v${v.number}`);
    became = maybeApprove(project, versionId, actor);
  });
  return { ...getVersion(actor, versionId), became_current: became };
}

export function withdraw(actor, versionId) {
  const v = versionRow(versionId);
  if (!v) throw notFound('Version');
  requireRole(v.project_id, actor);
  if (v.author_id !== actor.userId) throw forbidden('Only the author can withdraw a proposal.');
  if (v.status !== 'proposed') throw bad('Only open proposals can be withdrawn.');
  run(`UPDATE versions SET status = 'withdrawn', decided_at = ? WHERE id = ?`, now(), versionId);
  log(v.project_id, actor, 'withdrew', versionId, `v${v.number}`);
  return getVersion(actor, versionId);
}

export function restore(actor, versionId) {
  const v = versionRow(versionId);
  if (!v) throw notFound('Version');
  return propose(actor, v.project_id, {
    title: v.title, body: v.body, summary: `Restore v${v.number}`, origin: 'restore', restoredFrom: v.id,
    contributionIds: all('SELECT contribution_id FROM version_sources WHERE version_id = ?', v.id).map((r) => r.contribution_id)
      .filter((cid) => { const c = one('SELECT * FROM contributions WHERE id = ?', cid); return c.visibility === 'shared' || c.author_id === actor.userId; }),
  });
}

// ---------- Add a contribution to the document ----------
// Atelier runs no AI, so placement is mechanical: the contribution goes in whole, at the end of the
// section the person picks (or the end of the document), and nothing else changes. The result is an
// ordinary proposal, so it goes through the same approval as any other change.

// Markdown headings outside code fences, with their line numbers.
function headings(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence) return;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ line: i, level: m[1].length, title: m[2] });
  });
  return out;
}

// The contribution's text with its headings moved to sit at `level` in the document's outline.
// If it does not open with a heading of its own, its title becomes one.
function fitUnder(title, body, level) {
  const hs = headings(body), lines = body.split('\n');
  const opensWithHeading = hs.length > 0 && lines.slice(0, hs[0].line).every((l) => !l.trim());
  const top = opensWithHeading ? level : Math.min(level + 1, 6);
  const by = hs.length ? top - Math.min(...hs.map((x) => x.level)) : 0;
  for (const x of hs) lines[x.line] = '#'.repeat(Math.max(1, Math.min(6, x.level + by))) + lines[x.line].replace(/^#{1,6}/, '');
  return (opensWithHeading ? '' : `${'#'.repeat(level)} ${title}\n\n`) + lines.join('\n').trim();
}

export function documentSections(actor, projectId) {
  const { project } = requireRole(projectId, actor);
  if (!project.current_version_id) return [];
  return headings(versionRow(project.current_version_id).body).map((x, index) => ({ index, level: x.level, title: x.title }));
}

// `sectionIndex` (from documentSections, used by the web app) or `section` (a heading's text, used by AIs).
// With neither, the contribution goes at the end of the document.
export function addToDocument(actor, contributionId, { section, sectionIndex } = {}) {
  const c = visibleContribution(actor, contributionId);
  const { project } = requireRole(c.project_id, actor, 'write');
  if (c.kind !== 'draft') throw bad(`Only drafts can be added to the document, and "${c.title}" is filed as ${c.kind}. Its author or the project owner can change its type to draft.`);
  if (c.replaced_by_id) throw bad(`"${c.title}" has been replaced by "${c.replaced_by_title}". Add that one instead.`);
  if (c.visibility !== 'shared') throw bad('Share this contribution with the project before adding it to the document.');
  const current = project.current_version_id ? versionRow(project.current_version_id) : null;
  if (!current) {
    return propose(actor, c.project_id, { title: c.title, body: c.body, origin: 'add', contributionIds: [c.id],
      summary: `Starts the document from "${c.title}" by ${c.author_name}.` });
  }
  const sources = all('SELECT contribution_id FROM version_sources WHERE version_id = ?', current.id).map((r) => r.contribution_id);
  if (sources.includes(c.id)) throw bad(`"${c.title}" is already one of the contributions the current version (v${current.number}) was built from.`);

  const hs = headings(current.body), lines = current.body.split('\n');
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
  let target = null;
  if (sectionIndex !== undefined && sectionIndex !== null && sectionIndex !== '') {
    target = hs[Number(sectionIndex)];
    if (!target) throw bad('That section is not in the current version any more. Reload and pick again.');
  } else if (section && norm(section)) {
    target = hs.find((x) => norm(x.title) === norm(section));
    if (!target) throw bad(`The current version has no section titled "${section}". Its sections: ${hs.map((x) => `"${x.title}"`).join(', ') || '(none)'}. Leave section out to add at the end.`);
  }

  let at = lines.length, level = 2;
  if (target) {
    const next = hs.find((x) => x.line > target.line && x.level <= target.level);
    at = next ? next.line : lines.length;
    level = Math.min(target.level + 1, 6);
    // Stay above a divider line that closes the section, so it keeps separating the sections.
    const rule = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
    while (at > target.line + 1 && (!lines[at - 1].trim() || (rule.test(lines[at - 1]) && !(lines[at - 2] || '').trim()))) at--;
  }
  const body = [lines.slice(0, at).join('\n').trimEnd(), fitUnder(c.title, c.body, level), lines.slice(at).join('\n').trimStart()]
    .filter(Boolean).join('\n\n');
  const kept = sources.filter((cid) => { const s = one('SELECT * FROM contributions WHERE id = ?', cid); return s.visibility === 'shared' || s.author_id === actor.userId; });
  return propose(actor, c.project_id, { title: current.title, body, origin: 'add', contributionIds: [...kept, c.id],
    summary: `Adds "${c.title}" by ${c.author_name} ${target ? `under "${target.title}"` : 'at the end'}. Nothing else changes.` });
}

// ---------- Comments ----------

function targetProject(actor, targetId) {
  if (targetId?.startsWith('c_')) return visibleContribution(actor, targetId).project_id;
  if (targetId?.startsWith('v_')) {
    const v = one('SELECT project_id FROM versions WHERE id = ?', targetId);
    if (!v || !roleOf(v.project_id, actor.userId)) throw notFound('Version');
    return v.project_id;
  }
  throw bad('target_id must be a contribution id (c_...) or a version id (v_...).');
}

const commentSelect = `SELECT m.*, u.name AS author_name FROM comments m JOIN users u ON u.id = m.author_id`;

export function listComments(actor, targetId) {
  targetProject(actor, targetId);
  return all(`${commentSelect} WHERE m.target_id = ? ORDER BY m.created_at`, targetId);
}

export function recentComments(actor, projectId, limit = 30) {
  requireRole(projectId, actor);
  return all(`${commentSelect} WHERE m.project_id = ? ORDER BY m.created_at DESC LIMIT ?`, projectId, limit)
    .filter((m) => { try { targetProject(actor, m.target_id); return true; } catch { return false; } });
}

export function postComment(actor, { targetId, body, parentId, quote }) {
  const projectId = targetProject(actor, targetId);
  requireRole(projectId, actor, 'comment');
  body = (body || '').trim();
  if (!body) throw bad('The comment is empty.');
  if (parentId) {
    const parent = one('SELECT * FROM comments WHERE id = ?', parentId);
    if (!parent || parent.target_id !== targetId) throw bad('The comment you are replying to is not on this item.');
  }
  const mid = id('m');
  run('INSERT INTO comments (id, project_id, target_id, parent_id, author_id, body, quote, via, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    mid, projectId, targetId, parentId || null, actor.userId, body, (quote || '').trim() || null, actor.via, now());
  log(projectId, actor, parentId ? 'replied' : 'commented', targetId, body.slice(0, 120));
  return one(`${commentSelect} WHERE m.id = ?`, mid);
}

// ---------- Next steps ----------
// A short plan of what should happen next in the project. Each save replaces the one before it and the
// old ones are kept as history. Atelier runs no AI: a member's own AI writes them (the MCP write tools
// ask it to after every change), or a member writes them by hand.

const NEXT_STEPS_ACTION = 'updated_next_steps';

export function listNextSteps(actor, projectId, limit = 50) {
  requireRole(projectId, actor);
  const rows = all(`SELECT n.id, n.project_id, n.author_id, n.body, n.via, n.activity_mark, n.created_at, u.name AS author_name
    FROM next_steps n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.project_id = ? ORDER BY n.activity_mark DESC, n.created_at DESC LIMIT ?`, projectId, limit);
  const current = rows[0] ?? null;
  // What has happened in the project since they were written (already filtered for privacy).
  const changes = listActivity(actor, projectId, 100)
    .filter((a) => a.action !== NEXT_STEPS_ACTION && a.id > (current ? current.activity_mark : 0))
    // The viewer's own private notes count as changes for them, but are flagged so they stay out of shared plans.
    .map((a) => ({ ...a, private: Boolean(a.target_id?.startsWith('c_') && one('SELECT visibility FROM contributions WHERE id = ?', a.target_id)?.visibility === 'private') }));
  return { current, history: rows.slice(1), changes_since: current ? changes : [] };
}

export function saveNextSteps(actor, projectId, body) {
  requireRole(projectId, actor, 'comment');
  body = (body || '').trim();
  if (!body) throw bad('The next steps are empty.');
  if (body.length > 20000) throw bad('Next steps should be a short list. Keep them under 20,000 characters.');
  const nid = id('n');
  const mark = one('SELECT COALESCE(MAX(id), 0) AS m FROM activity WHERE project_id = ?', projectId).m;
  run('INSERT INTO next_steps (id, project_id, author_id, body, via, activity_mark, created_at) VALUES (?,?,?,?,?,?,?)',
    nid, projectId, actor.userId, body, actor.via, mark, now());
  log(projectId, actor, NEXT_STEPS_ACTION, nid);
  return listNextSteps(actor, projectId).current;
}

// Shared drafts that the current version was not built from: candidates for "add this" steps.
// Other types, and drafts that have been replaced, are never suggested for the document.
export function unusedContributions(actor, projectId) {
  const { project } = requireRole(projectId, actor);
  const used = new Set(project.current_version_id
    ? all('SELECT contribution_id FROM version_sources WHERE version_id = ?', project.current_version_id).map((r) => r.contribution_id) : []);
  return listContributions(actor, projectId).filter((c) => c.kind === 'draft' && !c.replaced_by_id && c.visibility === 'shared' && !used.has(c.id));
}

// ---------- Activity ----------

export function listActivity(actor, projectId, limit = 200) {
  requireRole(projectId, actor);
  return all(`SELECT a.*, u.name AS actor_name FROM activity a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.project_id = ? ORDER BY a.id DESC LIMIT ?`, projectId, limit)
    .filter((a) => {
      // Never leak the existence/title of someone else's private contribution.
      if (a.target_id?.startsWith('c_') && a.actor_id !== actor.userId) {
        const c = one('SELECT visibility FROM contributions WHERE id = ?', a.target_id);
        return c?.visibility === 'shared';
      }
      return true;
    });
}
