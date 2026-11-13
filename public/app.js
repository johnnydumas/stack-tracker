import {
  localParts, workDaysBetween, toLocalInput, RECURRENCE_LABELS,
} from '/shared/time.js';

// =====================================================================
// Constants
// =====================================================================

const PASSCODE_KEY = 'stack_passcode';
const PREFS_KEY = 'stack_prefs_v1';

const STATUSES = [
  { id: 'not_started', label: 'Not started', short: 'To do' },
  { id: 'in_progress', label: 'In progress', short: 'Doing' },
  { id: 'waiting', label: 'Waiting for Update', short: 'Waiting' },
  { id: 'completed', label: 'Completed', short: 'Done' },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL = { high: 'High', medium: 'Med', low: 'Low' };

// Sticky-note colours for projects. Activities without a project are classic yellow.
const PROJECT_COLORS = {
  blue: '#a9d4ff',
  green: '#b9e4ad',
  pink: '#ffc4d6',
  purple: '#d3c5fb',
  orange: '#ffcf9e',
  teal: '#a3e4dc',
  red: '#ffb0a3',
  gray: '#d5d9e0',
};
const NO_PROJECT_COLOR = '#f7e48f';

const SORTS = {
  priority: 'Priority',
  due: 'Due date',
  longest: 'Longest in column',
  recent: 'Recently moved here',
  updated: 'Recently updated',
  title: 'Title (A–Z)',
  manual: 'Manual (drag to order)',
};
const DEFAULT_SORT = { not_started: 'priority', in_progress: 'due', waiting: 'longest', completed: 'recent' };

const DUE_FILTERS = {
  any: 'Any due date',
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due in the next 7 days',
  none: 'No due date',
};

const REMINDER_PRESETS = [
  { minutes: 0, label: 'At due time' },
  { minutes: 15, label: '15 min before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 10080, label: '1 week before' },
];

// =====================================================================
// State
// =====================================================================

const state = {
  settings: { timezone: 'America/Chicago' },
  projects: [],
  activities: [],
  unread: 0,
  search: '',
  searchIds: null,      // Set of matching board ids while searching
  searchArchived: [],   // archived matches while searching
  prefs: loadPrefs(),
  activeCol: 0,         // mobile: which column is in view
};

function loadPrefs() {
  const defaults = { project: 'all', columns: {} };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    // storage unavailable — prefs just won't persist
  }
}

function colPrefs(status) {
  const p = state.prefs.columns[status] || {};
  return {
    sort: SORTS[p.sort] ? p.sort : DEFAULT_SORT[status],
    priorities: Array.isArray(p.priorities) ? p.priorities : ['high', 'medium', 'low'],
    due: DUE_FILTERS[p.due] ? p.due : 'any',
  };
}

function setColPrefs(status, patch) {
  state.prefs.columns[status] = { ...colPrefs(status), ...patch };
  savePrefs();
}

function isFiltered(status) {
  const p = colPrefs(status);
  return p.priorities.length < 3 || p.due !== 'any';
}

const tz = () => state.settings.timezone || 'America/Chicago';

// =====================================================================
// DOM helpers
// =====================================================================

const $ = (sel, root = document) => root.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.visible = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.visible = 'false'; }, 2600);
}

function confirmAction(message, okLabel = 'Delete') {
  const dlg = $('#confirm-dialog');
  $('#confirm-message').textContent = message;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

// Close a <dialog> sheet when its backdrop is clicked.
for (const dlg of document.querySelectorAll('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

// =====================================================================
// Formatting
// =====================================================================

function fmt(ts, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz(), ...opts }).format(new Date(ts));
}

const fmtDateTime = (ts) => fmt(ts, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTime = (ts) => fmt(ts, { hour: 'numeric', minute: '2-digit' });

function dayIndex(ts) {
  const p = localParts(ts, tz());
  return Date.UTC(p.year, p.month - 1, p.day) / 86400000;
}

/** "Today 9:00 AM", "Tomorrow 2:00 PM", "Thu 9:00 AM", "Nov 28", "Jan 3, 2027". */
function formatDue(ts, now = Date.now()) {
  const diff = dayIndex(ts) - dayIndex(now);
  const time = fmtTime(ts);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  if (diff > 1 && diff < 7) return `${fmt(ts, { weekday: 'short' })} ${time}`;
  const sameYear = localParts(ts, tz()).year === localParts(now, tz()).year;
  return fmt(ts, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(ts, now = Date.now()) {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmt(ts, { month: 'short', day: 'numeric' });
}

function formatOffset(minutes) {
  const preset = REMINDER_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return `${plural(minutes / 1440, 'day')} before`;
  if (minutes % 60 === 0) return `${plural(minutes / 60, 'hour')} before`;
  return `${plural(minutes, 'minute')} before`;
}

const projectById = (id) => state.projects.find((p) => p.id === id) || null;
const noteColor = (a) => {
  const p = projectById(a.project_id);
  return p ? PROJECT_COLORS[p.color] || PROJECT_COLORS.gray : NO_PROJECT_COLOR;
};

// =====================================================================
// API
// =====================================================================

const getPasscode = () => {
  try {
    return localStorage.getItem(PASSCODE_KEY) || '';
  } catch {
    return '';
  }
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getPasscode()}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    lock();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
const del = (path) => api(path, { method: 'DELETE' });

function reportError(err) {
  if (err?.message !== 'unauthorized') toast(err?.message || 'Something went wrong');
}

// =====================================================================
// Auth
// =====================================================================

const gate = $('#gate');
const appEl = $('#app');

async function verifyPasscode(code) {
  const res = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: code }),
  });
  return res.ok;
}

$('#unlock-btn').addEventListener('click', async () => {
  const input = $('#passcode-input');
  const code = input.value.trim();
  if (!code) return;
  $('#gate-error').textContent = '';
  $('#unlock-btn').disabled = true;
  const ok = await verifyPasscode(code).catch(() => false);
  $('#unlock-btn').disabled = false;
  if (!ok) {
    $('#gate-error').textContent = 'wrong passcode';
    return;
  }
  try {
    localStorage.setItem(PASSCODE_KEY, code);
  } catch {
    // ignore
  }
  showApp();
});

$('#passcode-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#unlock-btn').click();
});

function lock() {
  try {
    localStorage.removeItem(PASSCODE_KEY);
  } catch {
    // ignore
  }
  appEl.hidden = true;
  gate.hidden = false;
  $('#passcode-input').value = '';
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
}

async function showApp() {
  gate.hidden = true;
  appEl.hidden = false;
  await loadBoard();
  const id = new URLSearchParams(location.search).get('activity');
  if (id) {
    history.replaceState(null, '', '/');
    openDetail(id);
  }
}

// =====================================================================
// Board data
// =====================================================================

async function loadBoard() {
  try {
    const data = await api('/api/board');
    state.settings = data.settings;
    state.projects = data.projects;
    state.activities = data.activities;
    state.unread = data.unread;
    if (state.prefs.project !== 'all' && state.prefs.project !== 'none' && !projectById(state.prefs.project)) {
      state.prefs.project = 'all';
      savePrefs();
    }
    render();
  } catch (err) {
    reportError(err);
  }
}

function upsertActivity(activity) {
  const i = state.activities.findIndex((a) => a.id === activity.id);
  if (i >= 0) state.activities[i] = activity;
  else state.activities.push(activity);
}

function matchesProject(a) {
  const p = state.prefs.project;
  if (p === 'all') return true;
  if (p === 'none') return !a.project_id;
  return a.project_id === p;
}

function matchesColumnFilters(a, prefs, now) {
  if (!prefs.priorities.includes(a.priority)) return false;
  switch (prefs.due) {
    case 'overdue': return a.due_at != null && a.due_at < now && a.status !== 'completed';
    case 'today': return a.due_at != null && dayIndex(a.due_at) === dayIndex(now);
    case 'week': return a.due_at != null && a.due_at <= now + 7 * 86400000 && dayIndex(a.due_at) >= dayIndex(now);
    case 'none': return a.due_at == null;
    default: return true;
  }
}

const byDue = (a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity);
const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];

const SORTERS = {
  priority: (a, b) => byPriority(a, b) || byDue(a, b) || a.created_at - b.created_at,
  due: (a, b) => byDue(a, b) || byPriority(a, b),
  longest: (a, b) => a.status_changed_at - b.status_changed_at,
  recent: (a, b) => b.status_changed_at - a.status_changed_at,
  updated: (a, b) => b.updated_at - a.updated_at,
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  manual: (a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at,
};

/** Activities visible in a column after project, search and column filters, sorted. */
function columnItems(status, now = Date.now()) {
  const prefs = colPrefs(status);
  return state.activities
    .filter((a) => a.status === status)
    .filter(matchesProject)
    .filter((a) => !state.searchIds || state.searchIds.has(a.id))
    .filter((a) => matchesColumnFilters(a, prefs, now))
    .sort(SORTERS[prefs.sort]);
}

// =====================================================================
// Rendering: nav
// =====================================================================

function renderNav() {
  const p = state.prefs.project;
  const project = projectById(p);
  $('#project-label').textContent = p === 'all' ? 'All projects' : p === 'none' ? 'No project' : project.name;
  const dot = $('#project-dot');
  dot.style.background = project ? PROJECT_COLORS[project.color] : p === 'none' ? NO_PROJECT_COLOR : 'transparent';
  dot.dataset.all = p === 'all';

  const badge = $('#bell-badge');
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
  $('#bell-btn').setAttribute('aria-label', state.unread ? `Notifications (${state.unread} unread)` : 'Notifications');

  const banner = $('#search-banner');
  if (state.search && state.searchIds) {
    const onBoard = state.activities.filter((a) => state.searchIds.has(a.id) && matchesProject(a)).length;
    const archived = state.searchArchived.length;
    banner.hidden = false;
    banner.innerHTML = `
      <span>${onBoard} match${onBoard === 1 ? '' : 'es'} on the board for “${esc(state.search)}”</span>
      ${archived ? `<button class="link-btn" data-action="open-archive-search">${archived} in the archive →</button>` : '<span class="muted">· none in the archive</span>'}
      <button class="link-btn" data-action="clear-search">Clear</button>`;
  } else {
    banner.hidden = true;
  }
}

$('#search-banner').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'clear-search') {
    $('#search-input').value = '';
    runSearch('');
  } else if (action === 'open-archive-search') {
    openArchive(state.search);
  }
});

// =====================================================================
// Rendering: board
// =====================================================================

const board = $('#board');
const colTabs = $('#col-tabs');

function render() {
  renderNav();
  renderBoard();
}

function renderBoard() {
  const now = Date.now();
  const scrollTops = {};
  for (const body of board.querySelectorAll('.column-body')) scrollTops[body.dataset.status] = body.scrollTop;
  // Keep whatever is being typed in quick-add through auto-refreshes.
  const qa = board.querySelector('.quick-add input');
  const qaDraft = qa ? { value: qa.value, focused: document.activeElement === qa, start: qa.selectionStart, end: qa.selectionEnd } : null;

  board.innerHTML = STATUSES.map((s) => {
    const items = columnItems(s.id, now);
    const prefs = colPrefs(s.id);
    const total = state.activities.filter((a) => a.status === s.id && matchesProject(a)).length;
    const countLabel = items.length === total ? `${total}` : `${items.length}/${total}`;
    return `
      <section class="column" data-status="${s.id}" aria-label="${esc(s.label)}">
        <header class="column-header">
          <h2>${esc(s.label)} <span class="count">${countLabel}</span></h2>
          <button class="col-tool" data-action="column-menu" data-status="${s.id}"
            aria-label="Sort and filter ${esc(s.label)}" data-filtered="${isFiltered(s.id)}">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3zm3 5h12v2H6zm3 5h6v2H9z"/></svg>
            <span class="col-tool-label">${esc(SORTS[prefs.sort].replace(' (drag to order)', ''))}</span>
          </button>
        </header>
        ${s.id === 'not_started' ? `
          <form class="quick-add" data-action="quick-add">
            <input type="text" name="title" placeholder="Quick add: type a title, press Enter" maxlength="200" autocomplete="off" aria-label="New activity title" />
            <button type="submit" aria-label="Add activity" title="Add (empty opens the full form)">+</button>
          </form>` : ''}
        <div class="column-body" data-status="${s.id}">
          ${items.length ? items.map((a) => renderNote(a, now)).join('') : renderEmpty(s.id, total)}
        </div>
      </section>`;
  }).join('');

  for (const body of board.querySelectorAll('.column-body')) {
    if (scrollTops[body.dataset.status]) body.scrollTop = scrollTops[body.dataset.status];
  }
  const qaNew = board.querySelector('.quick-add input');
  if (qaNew && qaDraft) {
    qaNew.value = qaDraft.value;
    if (qaDraft.focused) {
      qaNew.focus({ preventScroll: true });
      qaNew.setSelectionRange(qaDraft.start, qaDraft.end);
    }
  }

  colTabs.innerHTML = STATUSES.map((s, i) => {
    const n = columnItems(s.id, now).length;
    return `<button data-index="${i}" ${i === state.activeCol ? 'aria-current="true"' : ''}>
      ${esc(s.short)} <span class="count">${n}</span></button>`;
  }).join('');
}

function renderEmpty(status, total) {
  if (total > 0 || state.searchIds) return `<div class="empty">Nothing matches the current filters.</div>`;
  const text = {
    not_started: 'Nothing queued. Type a title above, or press + for the full form.',
    in_progress: 'Drag something here when you start it.',
    waiting: 'Things blocked on someone else go here.',
    completed: 'Finished work shows here for 14 days, then moves to the archive.',
  }[status];
  return `<div class="empty">${text}</div>`;
}

function renderNote(a, now) {
  const project = projectById(a.project_id);
  const overdue = a.due_at != null && a.due_at < now && a.status !== 'completed';
  const dueSoon = !overdue && a.due_at != null && a.status !== 'completed' && a.due_at - now < 86400000;
  const meta = [];

  if (a.due_at != null) {
    meta.push(`<span class="chip chip-due" data-overdue="${overdue}" data-soon="${dueSoon}" title="Due ${esc(fmtDateTime(a.due_at))}">
      ${overdue ? 'Overdue · ' : ''}${esc(formatDue(a.due_at, now))}</span>`);
  }
  if (a.status === 'waiting') {
    const days = workDaysBetween(a.status_changed_at, now, tz());
    meta.push(`<span class="chip chip-waiting" data-stale="${days >= 3}" title="Waiting since ${esc(fmtDateTime(a.status_changed_at))}">
      ⏳ ${days === 0 ? 'Waiting since today' : `Waiting ${days} work day${days === 1 ? '' : 's'}`}</span>`);
  }
  if (a.status === 'completed' && a.completed_at) {
    meta.push(`<span class="chip">✓ ${esc(formatDue(a.completed_at, now))}</span>`);
  }
  if (a.recurrence) meta.push(`<span class="chip" title="Repeats: ${esc(RECURRENCE_LABELS[a.recurrence])}">↻ ${esc(RECURRENCE_LABELS[a.recurrence])}</span>`);
  if (a.reminders_count) meta.push(`<span class="chip" title="${a.reminders_count} reminder(s)">🔔 ${a.reminders_count}</span>`);
  if (a.notes_count) meta.push(`<span class="chip" title="${a.notes_count} note(s)">✎ ${a.notes_count}</span>`);

  return `
    <article class="note" draggable="true" tabindex="0" data-id="${a.id}" data-priority="${a.priority}"
      style="--note:${noteColor(a)}" aria-label="${esc(a.title)}">
      <div class="note-top">
        ${project ? `<span class="note-project">${esc(project.name)}</span>` : '<span class="note-project note-project-none">No project</span>'}
        <span class="note-priority" data-priority="${a.priority}">${PRIORITY_LABEL[a.priority]}</span>
      </div>
      <div class="note-title">${esc(a.title)}</div>
      ${meta.length ? `<div class="note-meta">${meta.join('')}</div>` : ''}
      <button class="note-move" data-action="move-menu" aria-label="Move ${esc(a.title)}">Move ▸</button>
    </article>`;
}

// ---- Board interactions ----

board.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  const action = actionEl?.dataset.action;
  if (action === 'column-menu') {
    openColumnMenu(actionEl, actionEl.dataset.status);
    return;
  }
  if (action === 'move-menu') {
    e.stopPropagation();
    openMoveMenu(actionEl, actionEl.closest('.note').dataset.id);
    return;
  }
  const note = e.target.closest('.note');
  if (note) openDetail(note.dataset.id);
});

board.addEventListener('keydown', (e) => {
  const note = e.target.closest('.note');
  if (note && e.target === note && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDetail(note.dataset.id);
  }
});

board.addEventListener('submit', async (e) => {
  if (e.target.dataset.action !== 'quick-add') return;
  e.preventDefault();
  const input = e.target.elements.title;
  const title = input.value.trim();
  if (!title) {
    openCreate(); // empty quick-add: open the full form instead
    return;
  }
  const projectId = state.prefs.project !== 'all' && state.prefs.project !== 'none' ? state.prefs.project : null;
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const { activity } = await post('/api/activities', { title, project_id: projectId });
    upsertActivity(activity);
    input.value = '';
    renderBoard();
    $('.column[data-status="not_started"] .quick-add input')?.focus();
    if (!columnItems('not_started').some((a) => a.id === activity.id)) {
      toast('Added — but hidden by the current search or column filter');
    }
  } catch (err) {
    reportError(err);
  } finally {
    button.disabled = false;
  }
});

async function moveActivity(id, status, sortOrder) {
  const a = state.activities.find((x) => x.id === id);
  if (!a) return;
  const body = {};
  if (status !== a.status) body.status = status;
  if (sortOrder !== undefined) body.sort_order = sortOrder;
  if (Object.keys(body).length === 0) return;

  // Optimistic update so the note moves instantly.
  const prev = { ...a };
  Object.assign(a, body, status !== prev.status ? { status_changed_at: Date.now() } : {});
  renderBoard();
  try {
    const { activity } = await patch(`/api/activities/${id}`, body);
    upsertActivity(activity);
    if (status === 'completed' && activity.status === 'not_started') {
      toast(`Repeats — next due ${formatDue(activity.due_at)}`);
    }
    renderBoard();
  } catch (err) {
    Object.assign(a, prev);
    renderBoard();
    reportError(err);
  }
}

// ---- Drag and drop (desktop) ----

let dragId = null;

board.addEventListener('dragstart', (e) => {
  const note = e.target.closest('.note');
  if (!note) return;
  dragId = note.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  requestAnimationFrame(() => note.classList.add('dragging'));
});

board.addEventListener('dragend', () => {
  dragId = null;
  clearDropMarkers();
});

function clearDropMarkers() {
  for (const el of board.querySelectorAll('.dragging, .drop-target')) el.classList.remove('dragging', 'drop-target');
  board.querySelector('.drop-line')?.remove();
}

/** The note the dragged item would be inserted before, or null for the end. */
function noteAfterPointer(body, y) {
  const notes = [...body.querySelectorAll('.note:not(.dragging)')];
  return notes.find((n) => {
    const r = n.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) || null;
}

board.addEventListener('dragover', (e) => {
  if (!dragId) return;
  const column = e.target.closest('.column');
  if (!column) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  for (const c of board.querySelectorAll('.drop-target')) if (c !== column) c.classList.remove('drop-target');
  column.classList.add('drop-target');

  const status = column.dataset.status;
  if (colPrefs(status).sort !== 'manual') {
    board.querySelector('.drop-line')?.remove();
    return;
  }
  const body = column.querySelector('.column-body');
  const before = noteAfterPointer(body, e.clientY);
  let line = board.querySelector('.drop-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'drop-line';
  }
  if (before) body.insertBefore(line, before);
  else body.appendChild(line);
});

board.addEventListener('dragleave', (e) => {
  const column = e.target.closest('.column');
  if (column && !column.contains(e.relatedTarget)) column.classList.remove('drop-target');
});

board.addEventListener('drop', (e) => {
  const column = e.target.closest('.column');
  if (!dragId || !column) return;
  e.preventDefault();
  const id = dragId;
  const status = column.dataset.status;
  let sortOrder;

  if (colPrefs(status).sort === 'manual') {
    const body = column.querySelector('.column-body');
    const before = noteAfterPointer(body, e.clientY);
    const ids = [...body.querySelectorAll('.note:not(.dragging)')].map((n) => n.dataset.id);
    const idx = before ? ids.indexOf(before.dataset.id) : ids.length;
    const order = (nid) => state.activities.find((a) => a.id === nid)?.sort_order ?? 0;
    const prevOrder = idx > 0 ? order(ids[idx - 1]) : null;
    const nextOrder = idx < ids.length ? order(ids[idx]) : null;
    if (prevOrder == null && nextOrder == null) sortOrder = 0;
    else if (prevOrder == null) sortOrder = nextOrder - 1;
    else if (nextOrder == null) sortOrder = prevOrder + 1;
    else sortOrder = (prevOrder + nextOrder) / 2;
  } else {
    const a = state.activities.find((x) => x.id === id);
    if (a && a.status === status) {
      toast('Switch this column to “Manual” sort to reorder by dragging');
    }
  }
  clearDropMarkers();
  moveActivity(id, status, sortOrder);
});

// ---- Mobile column tabs (columns are a horizontal scroll-snap strip) ----

colTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-index]');
  if (!btn) return;
  const i = Number(btn.dataset.index);
  board.scrollTo({ left: i * board.clientWidth, behavior: 'smooth' });
  setActiveCol(i);
});

function setActiveCol(i) {
  if (state.activeCol === i) return;
  state.activeCol = i;
  for (const b of colTabs.querySelectorAll('button')) {
    if (Number(b.dataset.index) === i) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
}

let scrollRaf;
board.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    if (getComputedStyle(colTabs).display === 'none') return;
    setActiveCol(Math.round(board.scrollLeft / Math.max(1, board.clientWidth)));
  });
});

// =====================================================================
// Popover menus
// =====================================================================

const popover = $('#popover');
let popoverAnchor = null;

function openPopover(anchor, html, onClick) {
  if (popoverAnchor === anchor && !popover.hidden) {
    closePopover();
    return;
  }
  closePopover();
  popover.innerHTML = html;
  popover.hidden = false;
  popoverAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');

  const r = anchor.getBoundingClientRect();
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.onclick = onClick;
  popover.onchange = onClick;
  popover.querySelector('button, input, select')?.focus({ preventScroll: true });
}

function closePopover() {
  if (popover.hidden) return;
  popover.hidden = true;
  popover.onclick = null;
  popover.onchange = null;
  popoverAnchor?.setAttribute('aria-expanded', 'false');
  popoverAnchor = null;
}

document.addEventListener('pointerdown', (e) => {
  if (!popover.hidden && !popover.contains(e.target) && !popoverAnchor?.contains(e.target)) closePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !popover.hidden) {
    const anchor = popoverAnchor;
    closePopover();
    anchor?.focus();
  }
});
window.addEventListener('resize', closePopover);

// ---- Project dropdown ----

$('#project-btn').addEventListener('click', (e) => {
  const current = state.prefs.project;
  const item = (value, label, color) => `
    <button class="menu-item" role="menuitemradio" aria-checked="${current === value}" data-project="${esc(value)}">
      <span class="dot" style="background:${color || 'transparent'}" ${color ? '' : 'data-all="true"'}></span>
      <span class="menu-label">${esc(label)}</span>
      ${current === value ? '<span class="check">✓</span>' : ''}
    </button>`;
  const html = `
    <div class="menu" role="menu">
      ${item('all', 'All projects')}
      ${state.projects.map((p) => item(p.id, p.name, PROJECT_COLORS[p.color])).join('')}
      ${item('none', 'No project', NO_PROJECT_COLOR)}
      <div class="menu-sep"></div>
      <button class="menu-item" data-manage="1"><span class="menu-label">Manage projects…</span></button>
    </div>`;
  openPopover(e.currentTarget, html, (ev) => {
    if (ev.type !== 'click') return;
    const btn = ev.target.closest('button');
    if (!btn) return;
    closePopover();
    if (btn.dataset.manage) {
      openProjects();
      return;
    }
    state.prefs.project = btn.dataset.project;
    savePrefs();
    render();
  });
});

// ---- Column sort/filter ----

function openColumnMenu(anchor, status) {
  const prefs = colPrefs(status);
  const html = `
    <div class="menu menu-form">
      <div class="menu-title">Sort</div>
      ${Object.entries(SORTS).map(([id, label]) => `
        <label class="menu-check"><input type="radio" name="sort" value="${id}" ${prefs.sort === id ? 'checked' : ''} /> ${esc(label)}</label>`).join('')}
      <div class="menu-sep"></div>
      <div class="menu-title">Priority</div>
      <div class="menu-row">
        ${['high', 'medium', 'low'].map((p) => `
          <label class="menu-check"><input type="checkbox" name="priority" value="${p}" ${prefs.priorities.includes(p) ? 'checked' : ''} /> ${PRIORITY_LABEL[p]}</label>`).join('')}
      </div>
      <div class="menu-title">Due</div>
      <select name="due" aria-label="Due date filter">
        ${Object.entries(DUE_FILTERS).map(([id, label]) => `<option value="${id}" ${prefs.due === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <div class="menu-sep"></div>
      <button class="link-btn" data-reset="1">Reset to default</button>
    </div>`;
  openPopover(anchor, html, (ev) => {
    if (ev.type === 'click' && ev.target.closest('[data-reset]')) {
      delete state.prefs.columns[status];
      savePrefs();
      closePopover();
      renderBoard();
      return;
    }
    if (ev.type !== 'change') return;
    const t = ev.target;
    if (t.name === 'sort') setColPrefs(status, { sort: t.value });
    if (t.name === 'due') setColPrefs(status, { due: t.value });
    if (t.name === 'priority') {
      const checked = [...popover.querySelectorAll('input[name="priority"]:checked')].map((i) => i.value);
      setColPrefs(status, { priorities: checked });
    }
    renderBoard();
    // keep the popover anchored to the re-rendered button
    popoverAnchor = board.querySelector(`.col-tool[data-status="${status}"]`) || popoverAnchor;
  });
}

// ---- Move menu (works everywhere, essential on touch) ----

function openMoveMenu(anchor, id) {
  const a = state.activities.find((x) => x.id === id);
  if (!a) return;
  const html = `
    <div class="menu" role="menu">
      <div class="menu-title">Move to</div>
      ${STATUSES.filter((s) => s.id !== a.status).map((s) => `
        <button class="menu-item" data-status="${s.id}"><span class="status-dot" data-status="${s.id}"></span><span class="menu-label">${esc(s.label)}</span></button>`).join('')}
      <div class="menu-sep"></div>
      <button class="menu-item" data-open="1"><span class="menu-label">Open details</span></button>
    </div>`;
  openPopover(anchor, html, (ev) => {
    if (ev.type !== 'click') return;
    const btn = ev.target.closest('button');
    if (!btn) return;
    closePopover();
    if (btn.dataset.open) openDetail(id);
    else moveActivity(id, btn.dataset.status);
  });
}

// ---- Overflow menu ----

$('#menu-btn').addEventListener('click', async (e) => {
  const pushOn = await isPushSubscribed();
  const html = `
    <div class="menu" role="menu">
      <button class="menu-item" data-act="push"><span class="menu-label">Phone notifications</span><span class="pill" data-on="${pushOn}">${pushOn ? 'On' : 'Off'}</span></button>
      <button class="menu-item" data-act="projects"><span class="menu-label">Manage projects</span></button>
      <button class="menu-item" data-act="archive"><span class="menu-label">Archive</span></button>
      <button class="menu-item" data-act="settings"><span class="menu-label">Settings</span></button>
      <div class="menu-sep"></div>
      <button class="menu-item" data-act="lock"><span class="menu-label">Lock</span></button>
    </div>`;
  openPopover(e.currentTarget, html, (ev) => {
    if (ev.type !== 'click') return;
    const act = ev.target.closest('button')?.dataset.act;
    if (!act) return;
    closePopover();
    if (act === 'push') togglePush();
    if (act === 'projects') openProjects();
    if (act === 'archive') openArchive('');
    if (act === 'settings') openSettings();
    if (act === 'lock') lock();
  });
});

// =====================================================================
// Search
// =====================================================================

let searchTimer;
let searchSeq = 0;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 250);
});

async function runSearch(q) {
  state.search = q.trim();
  const seq = ++searchSeq;
  if (!state.search) {
    state.searchIds = null;
    state.searchArchived = [];
    render();
    return;
  }
  try {
    const { ids, archived } = await api(`/api/search?q=${encodeURIComponent(state.search)}`);
    if (seq !== searchSeq) return;
    state.searchIds = new Set(ids);
    state.searchArchived = archived;
    render();
  } catch (err) {
    reportError(err);
  }
}

// =====================================================================
// Detail sheet (view / edit / create)
// =====================================================================

const detail = $('#detail-sheet');
let detailState = null; // { mode: 'edit'|'create', activity, notes, reminders, draftReminders }

function blankActivity() {
  const p = state.prefs.project;
  return {
    id: null,
    title: '',
    description: '',
    status: 'not_started',
    priority: 'medium',
    project_id: p !== 'all' && p !== 'none' ? p : null,
    due_at: null,
    recurrence: null,
  };
}

$('#new-btn').addEventListener('click', () => openCreate());

function openCreate() {
  closePopover();
  detailState = { mode: 'create', activity: blankActivity(), notes: [], reminders: [], draftReminders: [] };
  renderDetail();
  detail.showModal();
  $('#d-title', detail)?.focus();
}

async function openDetail(id) {
  closePopover();
  try {
    const data = await api(`/api/activities/${id}`);
    detailState = { mode: 'edit', ...data };
    renderDetail();
    if (!detail.open) detail.showModal();
  } catch (err) {
    reportError(err);
  }
}

function renderDetail() {
  const { mode, activity: a, notes } = detailState;
  const creating = mode === 'create';
  // In create mode the due date only exists as the draft input string.
  const due = creating
    ? (a.dueInput ? { date: a.dueInput.slice(0, 10), time: a.dueInput.slice(11, 16) } : { date: '', time: '' })
    : (a.due_at != null ? toLocalInput(a.due_at, tz()) : { date: '', time: '' });
  const hasDue = Boolean(due.date);
  const offsets = creating ? detailState.draftReminders : detailState.reminders.map((r) => r.offset_minutes);
  const customOffsets = offsets.filter((m) => !REMINDER_PRESETS.some((p) => p.minutes === m));
  const archived = a.status === 'completed' && a.completed_at && Date.now() - a.completed_at > 14 * 86400000;

  detail.innerHTML = `
    <form class="detail" id="detail-form" novalidate>
      <header class="detail-header">
        <select id="d-status" class="status-select" data-status="${a.status}" aria-label="Column">
          ${STATUSES.map((s) => `<option value="${s.id}" ${a.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>
        ${archived ? '<span class="pill">Archived</span>' : ''}
        <button type="button" class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </header>

      <textarea id="d-title" class="detail-title" rows="1" maxlength="200" placeholder="What needs doing?" aria-label="Title">${esc(a.title)}</textarea>

      <div class="fields">
        <label class="field">
          <span class="field-label">Project</span>
          <select id="d-project">
            <option value="">No project</option>
            ${state.projects.map((p) => `<option value="${p.id}" ${a.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>

        <div class="field">
          <span class="field-label" id="d-priority-label">Priority</span>
          <div class="segmented" role="radiogroup" aria-labelledby="d-priority-label">
            ${['low', 'medium', 'high'].map((p) => `
              <label data-priority="${p}"><input type="radio" name="d-priority" value="${p}" ${a.priority === p ? 'checked' : ''} /><span>${p[0].toUpperCase() + p.slice(1)}</span></label>`).join('')}
          </div>
        </div>

        <div class="field field-wide">
          <span class="field-label">Due <span class="muted">(${esc(shortZone())})</span></span>
          <div class="due-row">
            <input type="date" id="d-due-date" value="${due.date}" aria-label="Due date" />
            <input type="time" id="d-due-time" value="${due.date ? due.time : ''}" aria-label="Due time" placeholder="09:00" />
            <button type="button" class="link-btn" data-action="clear-due" ${hasDue ? '' : 'hidden'}>Clear</button>
          </div>
          <span class="hint">No time picked means 9:00 AM. Overdue reminders go out every 24h on weekdays.</span>
        </div>

        <label class="field">
          <span class="field-label">Repeats</span>
          <select id="d-recurrence">
            <option value="">Doesn’t repeat</option>
            ${Object.entries(RECURRENCE_LABELS).map(([id, label]) => `<option value="${id}" ${a.recurrence === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
        </label>
      </div>

      <section class="detail-section">
        <h3>Reminders before due</h3>
        ${hasDue ? '' : '<p class="hint">Set a due date to use these.</p>'}
        <div class="reminder-chips">
          ${REMINDER_PRESETS.map((p) => `
            <button type="button" class="toggle-chip" data-action="toggle-reminder" data-minutes="${p.minutes}"
              aria-pressed="${offsets.includes(p.minutes)}">${esc(p.label)}</button>`).join('')}
          ${customOffsets.map((m) => `
            <button type="button" class="toggle-chip" data-action="toggle-reminder" data-minutes="${m}" aria-pressed="true"
              title="Remove">${esc(formatOffset(m))} ✕</button>`).join('')}
        </div>
        <div class="custom-reminder">
          <input type="number" id="d-rem-n" min="1" max="999" value="2" aria-label="Custom reminder amount" />
          <select id="d-rem-unit" aria-label="Custom reminder unit">
            <option value="1">minutes</option>
            <option value="60" selected>hours</option>
            <option value="1440">days</option>
          </select>
          <span class="muted">before</span>
          <button type="button" class="btn-ghost btn-small" data-action="add-reminder">Add</button>
        </div>
      </section>

      <label class="detail-section">
        <h3>Description</h3>
        <textarea id="d-description" rows="3" maxlength="5000" placeholder="Details, links, context…">${esc(a.description || '')}</textarea>
      </label>

      ${creating ? `
        <footer class="detail-footer">
          <button type="button" class="btn-ghost" data-action="close">Cancel</button>
          <button type="submit" class="btn-primary">Create activity</button>
        </footer>` : `
        <section class="detail-section">
          <h3>Work log</h3>
          <div class="note-compose">
            <textarea id="d-new-note" rows="2" maxlength="5000" placeholder="What happened? (Ctrl/⌘+Enter to add)"></textarea>
            <button type="button" class="btn-primary btn-small" data-action="add-note">Add note</button>
          </div>
          <ol class="log">
            ${notes.map(renderLogEntry).join('') || '<li class="hint">No entries yet.</li>'}
          </ol>
        </section>
        <footer class="detail-footer">
          <span class="muted small">Created ${esc(fmtDateTime(a.created_at))}</span>
          <span class="spacer"></span>
          ${archived ? '<button type="button" class="btn-ghost" data-action="restore">Restore to board</button>' : ''}
          <button type="button" class="btn-danger-ghost" data-action="delete">Delete</button>
        </footer>`}
    </form>`;

  autosize($('#d-title', detail));
}

function renderLogEntry(n) {
  if (n.kind === 'system') {
    return `<li class="log-entry log-system"><span class="log-time">${esc(fmtDateTime(n.created_at))}</span><span class="log-body">${esc(n.body)}</span></li>`;
  }
  return `
    <li class="log-entry" data-note-id="${n.id}">
      <span class="log-time">${esc(fmtDateTime(n.created_at))}${n.edited_at ? ` · <span title="Edited ${esc(fmtDateTime(n.edited_at))}">edited</span>` : ''}</span>
      <div class="log-body">${esc(n.body)}</div>
      <div class="log-actions">
        <button type="button" class="link-btn" data-action="edit-note">Edit</button>
        <button type="button" class="link-btn danger" data-action="delete-note">Delete</button>
      </div>
    </li>`;
}

function shortZone() {
  return fmt(Date.now(), { timeZoneName: 'short' }).split(' ').pop();
}

function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function dueValue() {
  const date = $('#d-due-date', detail).value;
  if (!date) return null;
  const time = $('#d-due-time', detail).value || '09:00';
  return `${date}T${time}`;
}

/** Saves one change in edit mode; in create mode just updates the draft. */
async function saveField(body) {
  const { mode, activity } = detailState;
  if (mode === 'create') {
    if ('due' in body) {
      const prevHadDue = Boolean(activity.dueInput);
      activity.dueInput = body.due;
      if (prevHadDue !== Boolean(body.due)) renderDetail();
    } else {
      Object.assign(activity, body);
    }
    return;
  }
  try {
    const { activity: updated } = await patch(`/api/activities/${activity.id}`, body);
    upsertActivity(updated);
    renderBoard();
    const needsRerender = 'due' in body || 'status' in body || 'recurrence' in body;
    if (needsRerender) {
      // refresh to pick up log entries and recurring roll-over
      await openDetail(updated.id);
      if (body.status === 'completed' && updated.status === 'not_started') {
        toast(`Repeats — next due ${formatDue(updated.due_at)}`);
      }
    } else {
      detailState.activity = updated;
    }
  } catch (err) {
    reportError(err);
    openDetail(activity.id);
  }
}

async function saveReminders(offsets) {
  if (detailState.mode === 'create') {
    detailState.draftReminders = offsets;
    renderDetail();
    return;
  }
  try {
    const { reminders } = await put(`/api/activities/${detailState.activity.id}/reminders`, { offsets });
    detailState.reminders = reminders;
    const a = state.activities.find((x) => x.id === detailState.activity.id);
    if (a) a.reminders_count = reminders.length;
    renderDetail();
    renderBoard();
  } catch (err) {
    reportError(err);
  }
}

detail.addEventListener('input', (e) => {
  if (e.target.id === 'd-title') autosize(e.target);
});

detail.addEventListener('change', (e) => {
  const t = e.target;
  switch (t.id) {
    case 'd-title': {
      const title = t.value.trim();
      if (!title) {
        if (detailState.mode === 'edit') {
          t.value = detailState.activity.title;
          toast('Title can’t be empty');
        }
        return;
      }
      saveField({ title });
      return;
    }
    case 'd-description': saveField({ description: t.value }); return;
    case 'd-status':
      t.dataset.status = t.value;
      saveField({ status: t.value });
      return;
    case 'd-project': saveField({ project_id: t.value || null }); return;
    case 'd-recurrence': saveField({ recurrence: t.value || null }); return;
    case 'd-due-date':
    case 'd-due-time':
      if (t.id === 'd-due-date' && t.value && !$('#d-due-time', detail).value) $('#d-due-time', detail).value = '09:00';
      saveField({ due: dueValue() });
      return;
    default:
      if (t.name === 'd-priority') saveField({ priority: t.value });
  }
});

detail.addEventListener('keydown', (e) => {
  if (e.target.id === 'd-new-note' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    addNoteFromCompose();
  }
  if (e.target.id === 'd-title' && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});

detail.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (detailState?.mode !== 'create') return;
  const title = $('#d-title', detail).value.trim();
  if (!title) {
    toast('Give it a title first');
    $('#d-title', detail).focus();
    return;
  }
  try {
    const { activity } = await post('/api/activities', {
      title,
      description: $('#d-description', detail).value,
      status: $('#d-status', detail).value,
      priority: detail.querySelector('input[name="d-priority"]:checked')?.value || 'medium',
      project_id: $('#d-project', detail).value || null,
      due: dueValue(),
      recurrence: $('#d-recurrence', detail).value || null,
      reminders: detailState.draftReminders,
    });
    upsertActivity(activity);
    detail.close();
    renderBoard();
    toast('Activity created');
  } catch (err) {
    reportError(err);
  }
});

detail.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !detailState) return;
  const { activity } = detailState;
  const offsets = detailState.mode === 'create'
    ? [...detailState.draftReminders]
    : detailState.reminders.map((r) => r.offset_minutes);

  switch (el.dataset.action) {
    case 'close':
      detail.close();
      break;
    case 'clear-due':
      $('#d-due-date', detail).value = '';
      $('#d-due-time', detail).value = '';
      saveField({ due: null });
      break;
    case 'toggle-reminder': {
      const m = Number(el.dataset.minutes);
      saveReminders(offsets.includes(m) ? offsets.filter((x) => x !== m) : [...offsets, m]);
      break;
    }
    case 'add-reminder': {
      const n = Number($('#d-rem-n', detail).value);
      const unit = Number($('#d-rem-unit', detail).value);
      if (!Number.isInteger(n) || n < 1) {
        toast('Enter a whole number');
        return;
      }
      const m = n * unit;
      if (!offsets.includes(m)) saveReminders([...offsets, m]);
      break;
    }
    case 'add-note':
      addNoteFromCompose();
      break;
    case 'edit-note':
      startEditNote(el.closest('.log-entry'));
      break;
    case 'save-note':
      saveEditedNote(el.closest('.log-entry'));
      break;
    case 'cancel-note':
      renderDetail();
      break;
    case 'delete-note': {
      const id = el.closest('.log-entry').dataset.noteId;
      if (!(await confirmAction('Delete this note? This can’t be undone.'))) return;
      try {
        await del(`/api/notes/${id}`);
        detailState.notes = detailState.notes.filter((n) => n.id !== id);
        bumpNotesCount(activity.id, -1);
        renderDetail();
      } catch (err) {
        reportError(err);
      }
      break;
    }
    case 'restore':
      try {
        const { activity: restored } = await post(`/api/activities/${activity.id}/restore`);
        upsertActivity(restored);
        renderBoard();
        openDetail(restored.id);
        toast('Restored to Not started');
      } catch (err) {
        reportError(err);
      }
      break;
    case 'delete':
      if (!(await confirmAction(`Delete “${activity.title}” and its whole work log? This can’t be undone.`))) return;
      try {
        await del(`/api/activities/${activity.id}`);
        state.activities = state.activities.filter((x) => x.id !== activity.id);
        detail.close();
        renderBoard();
        toast('Activity deleted');
        if (!$('#archive-sheet').open) return;
        refreshArchive();
      } catch (err) {
        reportError(err);
      }
      break;
    default:
  }
});

function bumpNotesCount(id, delta) {
  const a = state.activities.find((x) => x.id === id);
  if (a) {
    a.notes_count = Math.max(0, (a.notes_count || 0) + delta);
    renderBoard();
  }
}

async function addNoteFromCompose() {
  const box = $('#d-new-note', detail);
  const text = box.value.trim();
  if (!text) return;
  try {
    const { note } = await post(`/api/activities/${detailState.activity.id}/notes`, { body: text });
    detailState.notes.unshift(note);
    bumpNotesCount(detailState.activity.id, 1);
    renderDetail();
    $('#d-new-note', detail)?.focus();
  } catch (err) {
    reportError(err);
  }
}

function startEditNote(li) {
  const note = detailState.notes.find((n) => n.id === li.dataset.noteId);
  if (!note) return;
  li.querySelector('.log-body').innerHTML = `<textarea class="log-edit" rows="3" maxlength="5000">${esc(note.body)}</textarea>`;
  li.querySelector('.log-actions').innerHTML = `
    <button type="button" class="link-btn" data-action="save-note">Save</button>
    <button type="button" class="link-btn" data-action="cancel-note">Cancel</button>`;
  const ta = li.querySelector('textarea');
  autosize(ta);
  ta.focus();
}

async function saveEditedNote(li) {
  const text = li.querySelector('textarea').value.trim();
  if (!text) {
    toast('A note can’t be empty — delete it instead');
    return;
  }
  try {
    const { note } = await patch(`/api/notes/${li.dataset.noteId}`, { body: text });
    const i = detailState.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) detailState.notes[i] = note;
    renderDetail();
  } catch (err) {
    reportError(err);
  }
}

detail.addEventListener('close', () => {
  detailState = null;
});

// =====================================================================
// Projects sheet
// =====================================================================

const projectsSheet = $('#projects-sheet');

function openProjects() {
  renderProjects();
  projectsSheet.showModal();
}

function colorPicker(name, selected) {
  return `<div class="swatches" role="radiogroup" aria-label="Colour">
    ${Object.entries(PROJECT_COLORS).map(([id, hex]) => `
      <label class="swatch" style="--swatch:${hex}" title="${id}">
        <input type="radio" name="${name}" value="${id}" ${selected === id ? 'checked' : ''} aria-label="${id}" />
      </label>`).join('')}
  </div>`;
}

function renderProjects() {
  const counts = {};
  for (const a of state.activities) if (a.project_id) counts[a.project_id] = (counts[a.project_id] || 0) + 1;
  const used = new Set(state.projects.map((p) => p.color));
  const nextColor = Object.keys(PROJECT_COLORS).find((c) => !used.has(c)) || 'blue';

  projectsSheet.innerHTML = `
    <div class="sheet-inner">
      <header class="sheet-header">
        <h2>Projects</h2>
        <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </header>
      <p class="hint">Projects are optional tags. Each activity can have one, and its sticky note takes the project’s colour.</p>
      <ul class="project-list">
        ${state.projects.map((p) => `
          <li class="project-row" data-id="${p.id}">
            <input class="project-name" value="${esc(p.name)}" maxlength="60" aria-label="Project name" />
            ${colorPicker(`color-${p.id}`, p.color)}
            <span class="muted small">${counts[p.id] || 0} on board</span>
            <button class="link-btn danger" data-action="delete-project">Delete</button>
          </li>`).join('') || '<li class="hint">No projects yet.</li>'}
      </ul>
      <form class="project-new" id="project-new">
        <h3>New project</h3>
        <input name="name" placeholder="Project name" maxlength="60" required aria-label="New project name" />
        ${colorPicker('new-color', nextColor)}
        <button type="submit" class="btn-primary">Add project</button>
      </form>
    </div>`;
}

projectsSheet.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') projectsSheet.close();
  if (action === 'delete-project') {
    const id = e.target.closest('.project-row').dataset.id;
    const p = projectById(id);
    if (!(await confirmAction(`Delete project “${p.name}”? Its activities stay on the board without a project.`))) return;
    try {
      await del(`/api/projects/${id}`);
      state.projects = state.projects.filter((x) => x.id !== id);
      for (const a of state.activities) if (a.project_id === id) a.project_id = null;
      if (state.prefs.project === id) {
        state.prefs.project = 'all';
        savePrefs();
      }
      renderProjects();
      render();
    } catch (err) {
      reportError(err);
    }
  }
});

projectsSheet.addEventListener('change', async (e) => {
  const row = e.target.closest('.project-row');
  if (!row) return;
  const body = e.target.classList.contains('project-name') ? { name: e.target.value } : { color: e.target.value };
  try {
    const { project } = await patch(`/api/projects/${row.dataset.id}`, body);
    const i = state.projects.findIndex((p) => p.id === project.id);
    state.projects[i] = project;
    state.projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    render();
  } catch (err) {
    reportError(err);
    renderProjects();
  }
});

projectsSheet.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.elements.name.value.trim();
  if (!name) return;
  try {
    const { project } = await post('/api/projects', { name, color: form.elements['new-color'].value });
    state.projects.push(project);
    state.projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    renderProjects();
    render();
    projectsSheet.querySelector('.project-new input[name="name"]')?.focus();
  } catch (err) {
    reportError(err);
  }
});

// =====================================================================
// Archive sheet
// =====================================================================

const archiveSheet = $('#archive-sheet');
let archiveQuery = '';

function openArchive(q) {
  archiveQuery = q || '';
  archiveSheet.innerHTML = `
    <div class="sheet-inner">
      <header class="sheet-header">
        <h2>Archive</h2>
        <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </header>
      <p class="hint">Completed activities move here 14 days after completion.</p>
      <div class="search search-inline">
        <span class="search-icon" aria-hidden="true">⌕</span>
        <input type="search" id="archive-search" placeholder="Search the archive" value="${esc(archiveQuery)}" />
      </div>
      <ul class="archive-list" id="archive-list"><li class="hint">Loading…</li></ul>
    </div>`;
  if (!archiveSheet.open) archiveSheet.showModal();
  refreshArchive();
}

async function refreshArchive() {
  const list = $('#archive-list', archiveSheet);
  if (!list) return;
  try {
    const { activities } = await api(`/api/archive?q=${encodeURIComponent(archiveQuery)}`);
    list.innerHTML = activities.map((a) => {
      const project = projectById(a.project_id);
      return `
        <li class="archive-row" data-id="${a.id}">
          <span class="dot" style="background:${noteColor(a)}"></span>
          <button class="archive-title link-btn" data-action="open">${esc(a.title)}</button>
          <span class="muted small">${project ? `${esc(project.name)} · ` : ''}done ${esc(fmt(a.completed_at, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
          <button class="btn-ghost btn-small" data-action="restore">Restore</button>
        </li>`;
    }).join('') || `<li class="hint">${archiveQuery ? 'No archived matches.' : 'Nothing archived yet.'}</li>`;
  } catch (err) {
    reportError(err);
  }
}

let archiveTimer;
archiveSheet.addEventListener('input', (e) => {
  if (e.target.id !== 'archive-search') return;
  clearTimeout(archiveTimer);
  archiveTimer = setTimeout(() => {
    archiveQuery = e.target.value.trim();
    refreshArchive();
  }, 250);
});

archiveSheet.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') {
    archiveSheet.close();
    return;
  }
  const id = e.target.closest('.archive-row')?.dataset.id;
  if (!id) return;
  if (action === 'open') openDetail(id);
  if (action === 'restore') {
    try {
      const { activity } = await post(`/api/activities/${id}/restore`);
      upsertActivity(activity);
      renderBoard();
      refreshArchive();
      toast('Restored to Not started');
    } catch (err) {
      reportError(err);
    }
  }
});

// =====================================================================
// Settings sheet
// =====================================================================

const settingsSheet = $('#settings-sheet');

function openSettings() {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [tz()];
  if (!zones.includes(tz())) zones.unshift(tz());
  settingsSheet.innerHTML = `
    <div class="sheet-inner">
      <header class="sheet-header">
        <h2>Settings</h2>
        <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </header>
      <label class="field">
        <span class="field-label">Time zone</span>
        <select id="s-timezone">${zones.map((z) => `<option ${z === tz() ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
        <span class="hint">Due times, weekends and the 24-hour overdue reminders follow this zone.</span>
      </label>
      <div class="field">
        <span class="field-label">Phone notifications</span>
        <div class="row">
          <button class="btn-ghost" data-action="push">Turn on / off</button>
          <button class="btn-ghost" data-action="test-push">Send a test</button>
        </div>
        <span class="hint">Install the app to your home screen first on iPhone, then turn notifications on from inside the app.</span>
      </div>
    </div>`;
  settingsSheet.showModal();
}

settingsSheet.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') settingsSheet.close();
  if (action === 'push') togglePush();
  if (action === 'test-push') {
    try {
      const r = await post('/api/push/test');
      toast(r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}` : 'No devices subscribed yet');
    } catch (err) {
      reportError(err);
    }
  }
});

settingsSheet.addEventListener('change', async (e) => {
  if (e.target.id !== 's-timezone') return;
  try {
    const { settings } = await put('/api/settings', { timezone: e.target.value });
    state.settings = settings;
    render();
    toast(`Time zone set to ${settings.timezone}`);
  } catch (err) {
    reportError(err);
  }
});

// =====================================================================
// In-app notifications
// =====================================================================

const notifSheet = $('#notif-sheet');

$('#bell-btn').addEventListener('click', openNotifications);

async function openNotifications() {
  notifSheet.innerHTML = `<div class="sheet-inner"><p class="hint">Loading…</p></div>`;
  if (!notifSheet.open) notifSheet.showModal();
  try {
    const { notifications, unread } = await api('/api/notifications');
    state.unread = unread;
    renderNav();
    const icon = { overdue: '⚠️', reminder: '🔔', waiting: '⏳' };
    notifSheet.innerHTML = `
      <div class="sheet-inner">
        <header class="sheet-header">
          <h2>Notifications</h2>
          ${unread ? '<button class="link-btn" data-action="read-all">Mark all read</button>' : ''}
          <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
        </header>
        <ul class="notif-list">
          ${notifications.map((n) => `
            <li>
              <button class="notif" data-id="${n.id}" data-activity="${n.activity_id || ''}" data-unread="${!n.read_at}">
                <span class="notif-icon" aria-hidden="true">${icon[n.kind] || '•'}</span>
                <span class="notif-text">
                  <strong>${esc(n.title)}</strong>
                  <span>${esc(n.body)}</span>
                  <span class="muted small">${esc(timeAgo(n.created_at))}</span>
                </span>
              </button>
            </li>`).join('') || '<li class="hint">No notifications yet. Overdue items, reminders and long waits show up here.</li>'}
        </ul>
      </div>`;
  } catch (err) {
    reportError(err);
  }
}

notifSheet.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') {
    notifSheet.close();
    return;
  }
  if (action === 'read-all') {
    await post('/api/notifications/read-all').catch(reportError);
    openNotifications();
    return;
  }
  const item = e.target.closest('.notif');
  if (!item) return;
  if (item.dataset.unread === 'true') {
    post(`/api/notifications/${item.dataset.id}/read`).catch(() => {});
    state.unread = Math.max(0, state.unread - 1);
    renderNav();
  }
  if (item.dataset.activity) {
    notifSheet.close();
    openDetail(item.dataset.activity);
  }
});

// =====================================================================
// Push subscription
// =====================================================================

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from([...atob(base64)].map((c) => c.charCodeAt(0)));
}

async function isPushSubscribed() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return Boolean(sub);
}

async function togglePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast('Push isn’t supported here. On iPhone, install the app to your home screen first.');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
      toast('Phone notifications off');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notifications are blocked in your browser settings');
      return;
    }
    const { publicKey } = await api('/api/push/vapid-public-key');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await post('/api/push/subscribe', sub.toJSON());
    toast('Phone notifications on');
  } catch (err) {
    reportError(err);
  }
}

// =====================================================================
// Refresh & boot
// =====================================================================

// Keep counters (waiting days, overdue) and the bell fresh.
setInterval(() => {
  if (!appEl.hidden && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) loadBoard();
}, 2 * 60 * 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !appEl.hidden) loadBoard();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.error('sw register failed', err));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-activity' && e.data.activityId) {
      loadBoard();
      openDetail(e.data.activityId);
    }
  });
}

(async function boot() {
  const saved = getPasscode();
  if (saved && (await verifyPasscode(saved).catch(() => false))) showApp();
})();
