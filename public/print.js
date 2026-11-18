import { localParts, RECURRENCE_LABELS } from '/shared/time.js';

const PASSCODE_KEY = 'stack_passcode';
const STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting: 'Waiting for update',
  completed: 'Completed',
};
const PRIORITY_LABEL = { high: 'HIGH', medium: 'MED', low: 'LOW' };

const sheet = document.getElementById('sheet');
const frame = document.getElementById('sheet-frame');
const projectSelect = document.getElementById('project-select');
const printBtn = document.getElementById('print-btn');

let data = null;

function passcode() {
  try {
    return localStorage.getItem(PASSCODE_KEY) || '';
  } catch {
    return '';
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const fmtCache = new Map();
function fmt(ts, opts) {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: data.settings.timezone, ...opts });
    fmtCache.set(key, f);
  }
  return f.format(new Date(ts));
}

const dayKey = (ts) => {
  const p = localParts(ts, data.settings.timezone);
  return `${p.year}-${p.month}-${p.day}`;
};

function rangeTitle(start, lastDay) {
  const a = localParts(start, data.settings.timezone);
  const b = localParts(lastDay, data.settings.timezone);
  const left = fmt(start, { month: 'short', day: 'numeric' });
  const right = a.month === b.month ? String(b.day) : fmt(lastDay, { month: 'short', day: 'numeric' });
  return `To do · ${left} – ${right}`;
}

/** "Thu 9:00 AM" inside the window; "Nov 11" for older/later dates. */
function whenLabel(ts, overdue) {
  if (overdue) return `due ${fmt(ts, { month: 'short', day: 'numeric' })}`;
  const inWindow = data.window.days.some((d) => dayKey(d) === dayKey(ts));
  if (inWindow) return `${fmt(ts, { weekday: 'short' })} ${fmt(ts, { hour: 'numeric', minute: '2-digit' })}`;
  return fmt(ts, { month: 'short', day: 'numeric' });
}

function projectName(id) {
  return data.projects.find((p) => p.id === id)?.name || null;
}

function truncate(text, n) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function waitText(days) {
  if (days === 0) return 'since today';
  return `${days} work day${days === 1 ? '' : 's'}`;
}

function itemHTML(r, { overdue = false, showStatus = true, showDue = true } = {}) {
  const parts = [];
  const proj = projectName(r.project_id);
  if (proj) parts.push(esc(proj));
  if (r.recurrence) parts.push(`Repeats ${esc(RECURRENCE_LABELS[r.recurrence].toLowerCase())}`);
  if (showStatus) {
    parts.push(r.status === 'waiting' && r.waiting_days != null
      ? `Waiting for update · ${waitText(r.waiting_days)}`
      : STATUS_LABEL[r.status]);
  }

  let right = '';
  if (r.status === 'waiting' && !showStatus) {
    right = `<span class="wait">${waitText(r.waiting_days)}</span>`;
  } else if (showDue && r.due_at != null) {
    right = `<span class="when${overdue ? ' flag' : ''}">${esc(whenLabel(r.due_at, overdue))}</span>`;
  } else {
    right = '<span class="when"></span>';
  }

  const pri = r.priority === 'medium' ? '' : `<span class="pri ${r.priority}">${PRIORITY_LABEL[r.priority]}</span>`;
  const note = r.last_note && !r.occurrence
    ? `<span class="last">Last note: ${esc(truncate(r.last_note.body, 110))} (${esc(fmt(r.last_note.created_at, { month: 'short', day: 'numeric' }))})</span>`
    : '';
  const follow = r.status === 'waiting' && !showStatus ? '<span class="sub">Follow up: ______________________</span>' : '';

  return `
    <div class="item">
      <span class="box"></span>
      <span><span class="t">${esc(r.title)}${r.recurrence ? ' ↻' : ''}</span>${pri}</span>
      ${right}
      ${parts.length ? `<span class="sub">${parts.join(' · ')}</span>` : ''}
      ${follow}
      ${note}
    </div>`;
}

function groupHTML(label, rows, opts) {
  if (!rows.length) return '';
  return `
    <section class="b-group">
      <div class="label">${esc(label)} <span class="count">(${rows.length})</span></div>
      ${rows.map((r) => itemHTML(r, opts)).join('')}
    </section>`;
}

function render() {
  const { groups, window: win, per_day: perDay, now } = data;
  const lastDay = win.days[win.days.length - 1];
  const scope = data.project === 'all'
    ? 'All projects'
    : data.project === 'none' ? 'No project' : (projectName(data.project) || 'All projects');
  // Count activities, not rows: a repeating activity can be listed on several days.
  const total = new Set(Object.values(groups).flat().map((r) => r.id)).size;
  const printed = `${fmt(now, { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmt(now, { hour: 'numeric', minute: '2-digit' })}`;
  const span = `${fmt(win.days[0], { weekday: 'short' })} – ${fmt(lastDay, { weekday: 'short' })}, 5 working days`;
  const todayKey = dayKey(now);

  sheet.innerHTML = `
    <header class="p-head">
      <div>
        <div class="p-brand">Stack · ${esc(scope)}</div>
        <div class="p-title">${esc(rangeTitle(win.days[0], lastDay))}</div>
      </div>
      <div class="p-meta">Printed ${esc(printed)}<br>${esc(span)}</div>
    </header>

    <div class="b-body">
      <div class="b-list">
        ${groupHTML('Overdue', groups.overdue, { overdue: true })}
        ${groupHTML('Due this week', groups.due, {})}
        ${groupHTML('Waiting for update', groups.waiting, { showStatus: false })}
        ${groupHTML('In progress', groups.in_progress, { showStatus: false })}
        ${groupHTML('Not started · no date', groups.not_started, { showStatus: false, showDue: false })}
        ${total === 0 ? '<p class="empty-note">Nothing open for this range. Enjoy it, or add something below.</p>' : ''}
        <section class="b-group">
          <div class="label">Added by hand</div>
          <div class="write"></div>
          <div class="write"></div>
          <div class="write"></div>
        </section>
      </div>

      <aside class="b-side">
        <div class="b-top3">
          <div class="label">Top 3 today</div>
          <ol><li></li><li></li><li></li></ol>
        </div>
        <div class="b-mini" aria-label="Due per day">
          ${perDay.map((d) => `
            <div class="${dayKey(d.day) === todayKey ? 'on' : ''}">${esc(fmt(d.day, { weekday: 'short' }))} ${esc(String(localParts(d.day, data.settings.timezone).day))}<b>${d.count}</b></div>`).join('')}
        </div>
        <div class="label">Notes</div>
        <div class="lines"></div>
      </aside>
    </div>

    <footer class="p-foot"><span>Stack · printed ${esc(printed)}</span><span>${total} open activit${total === 1 ? 'y' : 'ies'}</span></footer>`;

  document.title = `Stack · ${rangeTitle(win.days[0], lastDay)}`;
  printBtn.disabled = false;
  fitToScreen();
}

function renderProjects() {
  const opts = [['all', 'All projects'], ...data.projects.map((p) => [p.id, p.name]), ['none', 'No project']];
  projectSelect.innerHTML = opts
    .map(([v, l]) => `<option value="${esc(v)}" ${v === data.project ? 'selected' : ''}>${esc(l)}</option>`)
    .join('');
}

/** Scales the real-size sheet down to fit narrow screens (printing is unaffected). */
function fitToScreen() {
  const available = document.getElementById('desk').clientWidth - 32;
  const natural = sheet.offsetWidth;
  const scale = Math.min(1, available / natural);
  frame.style.transform = scale < 1 ? `scale(${scale})` : '';
  frame.style.width = `${natural * scale}px`;
  frame.style.height = scale < 1 ? `${sheet.offsetHeight * scale}px` : '';
}

async function load(project) {
  const code = passcode();
  if (!code) {
    location.replace('/');
    return;
  }
  printBtn.disabled = true;
  try {
    const res = await fetch(`/api/print?project=${encodeURIComponent(project)}`, {
      headers: { Authorization: `Bearer ${code}` },
      cache: 'no-store',
    });
    if (res.status === 401) {
      location.replace('/');
      return;
    }
    if (!res.ok) throw new Error(`The server returned ${res.status}`);
    data = await res.json();
    renderProjects();
    render();
  } catch (err) {
    sheet.innerHTML = `<p class="error">Couldn’t build the sheet: ${esc(err.message)}.<br>Check your connection and reload this page.</p>`;
  }
}

projectSelect.addEventListener('change', () => {
  const url = new URL(location.href);
  url.searchParams.set('project', projectSelect.value);
  history.replaceState(null, '', url);
  load(projectSelect.value);
});

printBtn.addEventListener('click', () => window.print());
window.addEventListener('resize', () => data && fitToScreen());

load(new URLSearchParams(location.search).get('project') || 'all');
