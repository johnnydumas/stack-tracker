const STORAGE_KEY = 'stack_passcode';

const gate = document.getElementById('gate');
const app = document.getElementById('app');
const passcodeInput = document.getElementById('passcode-input');
const gateError = document.getElementById('gate-error');
const unlockBtn = document.getElementById('unlock-btn');
const lockBtn = document.getElementById('lock-btn');
const notifBtn = document.getElementById('notif-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const remindersEnabledInput = document.getElementById('reminders-enabled-input');
const escalationHoursInput = document.getElementById('escalation-hours-input');
const taskEditModal = document.getElementById('task-edit-modal');
const taskEditForm = document.getElementById('task-edit-form');
const editTitleInput = document.getElementById('edit-title-input');
const editNotesInput = document.getElementById('edit-notes-input');
const editDueInput = document.getElementById('edit-due-input');
const editRecurInput = document.getElementById('edit-recur-input');
const editActivityInput = document.getElementById('edit-activity-input');
const editCancelBtn = document.getElementById('edit-cancel-btn');
const quickAddForm = document.getElementById('quick-add-form');
const titleInput = document.getElementById('title-input');
const dueInput = document.getElementById('due-input');
const recurInput = document.getElementById('recur-input');
const activityInput = document.getElementById('activity-input');
const tabs = document.querySelectorAll('.tab[data-view]');
const viewTitle = document.getElementById('view-title');
const taskList = document.getElementById('task-list');
const toast = document.getElementById('toast');
const countToday = document.getElementById('count-today');
const countAll = document.getElementById('count-all');
const countProjects = document.getElementById('count-projects');
const countStale = document.getElementById('count-stale');
const countDone = document.getElementById('count-done');

let currentView = 'today';
let activities = [];
let editingTaskId = null;

// ---------------- Auth ----------------

function getPasscode() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

async function verifyPasscode(code) {
  const res = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: code }),
  });
  return res.ok;
}

async function tryAutoUnlock() {
  const saved = getPasscode();
  if (!saved) return;
  const ok = await verifyPasscode(saved);
  if (ok) showApp();
}

unlockBtn.addEventListener('click', async () => {
  const code = passcodeInput.value.trim();
  if (!code) return;
  gateError.textContent = '';
  unlockBtn.disabled = true;
  const ok = await verifyPasscode(code);
  unlockBtn.disabled = false;
  if (ok) {
    localStorage.setItem(STORAGE_KEY, code);
    showApp();
  } else {
    gateError.textContent = 'wrong passcode';
  }
});

passcodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlockBtn.click();
});

lockBtn.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  app.hidden = true;
  gate.hidden = false;
  passcodeInput.value = '';
});

settingsBtn.addEventListener('click', () => {
  settingsModal.hidden = false;
  loadSettings();
});

settingsCloseBtn.addEventListener('click', () => {
  settingsModal.hidden = true;
});

async function loadSettings() {
  try {
    const { settings } = await api('/api/settings');
    remindersEnabledInput.checked = settings.reminders_enabled;
    escalationHoursInput.value = String(settings.escalation_hours);
    escalationHoursInput.disabled = !settings.reminders_enabled;
  } catch (err) {
    if (err.message !== 'unauthorized') showToast(err.message);
  }
}

remindersEnabledInput.addEventListener('change', async () => {
  escalationHoursInput.disabled = !remindersEnabledInput.checked;
  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ reminders_enabled: remindersEnabledInput.checked }),
    });
    showToast(remindersEnabledInput.checked ? 'Reminders on' : 'Reminders off');
  } catch (err) {
    showToast(err.message);
  }
});

escalationHoursInput.addEventListener('change', async () => {
  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ escalation_hours: Number(escalationHoursInput.value) }),
    });
    showToast('Reminder interval updated');
  } catch (err) {
    showToast(err.message);
  }
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    location.reload();
  } catch (err) {
    showToast(err.message || 'Could not clear cache');
    clearCacheBtn.disabled = false;
  }
});

function showApp() {
  gate.hidden = true;
  app.hidden = false;
  loadActivities().then(() => loadView(currentView));
  refreshCounts();
  checkNotifPermissionState();
}

// ---------------- API helper ----------------

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
    localStorage.removeItem(STORAGE_KEY);
    app.hidden = true;
    gate.hidden = false;
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

// ---------------- Activities (projects) ----------------

async function loadActivities() {
  try {
    const { activities: list } = await api('/api/activities');
    activities = list;
    populateActivitySelect();
  } catch (err) {
    if (err.message !== 'unauthorized') showToast(err.message);
  }
}

function populateActivitySelectEl(selectEl, currentValue) {
  selectEl.textContent = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'no project';
  selectEl.appendChild(noneOpt);
  for (const a of activities) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.title;
    selectEl.appendChild(opt);
  }
  selectEl.value = activities.some((a) => a.id === currentValue) ? currentValue : '';
}

function populateActivitySelect() {
  populateActivitySelectEl(activityInput, activityInput.value);
}

// ---------------- Quick add ----------------

// Scoped so the quick-add chips and the edit-modal chips (same CSS
// classes, reused markup) don't share selection state with each other.
function setupPriorityChips(container, initial) {
  const chips = container.querySelectorAll('.chip[data-priority]');
  let selected = initial;
  const applyActive = () => {
    chips.forEach((c) => {
      if (c.dataset.priority === selected) c.dataset.active = 'true';
      else c.removeAttribute('data-active');
    });
  };
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      selected = chip.dataset.priority;
      applyActive();
    });
  });
  applyActive();
  return {
    get: () => selected,
    set: (value) => {
      selected = value;
      applyActive();
    },
  };
}

const quickAddPriority = setupPriorityChips(quickAddForm, 'medium');
const editPriority = setupPriorityChips(taskEditForm, 'medium');

quickAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;

  const payload = { title, priority: quickAddPriority.get() };
  if (dueInput.value) payload.due_at = new Date(dueInput.value).getTime();
  if (recurInput.value) payload.recurrence = { type: recurInput.value };
  if (activityInput.value) payload.activity_id = activityInput.value;

  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    titleInput.value = '';
    dueInput.value = '';
    recurInput.value = '';
    showToast('Task added');
    loadView(currentView);
    refreshCounts();
  } catch (err) {
    showToast(err.message);
  }
});

// ---------------- Tabs ----------------

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.removeAttribute('data-active'));
    tab.dataset.active = 'true';
    currentView = tab.dataset.view;
    loadView(currentView);
  });
});

const VIEW_TITLES = {
  today: 'The Stack', all: 'Everything', projects: 'Projects',
  stale: "Hasn't moved in a week", done: 'Closed',
};
const VIEW_EMPTY = {
  today: { emoji: '✨', headline: 'Nothing on top', sub: 'Add a task above to get started.' },
  all: { emoji: '📭', headline: 'No tasks yet', sub: 'Whatever\u2019s on your mind — add it.' },
  projects: { emoji: '🗂️', headline: 'No projects yet', sub: 'Group related tasks together — add one below.' },
  stale: { emoji: '🧹', headline: 'Nothing stale', sub: 'Everything\u2019s been touched recently.' },
  done: { emoji: '✅', headline: 'Nothing closed yet', sub: 'Completed tasks show up here.' },
};

async function loadView(view) {
  viewTitle.textContent = VIEW_TITLES[view];
  taskList.innerHTML = '';
  try {
    if (view === 'projects') {
      const [{ activities: list }, { tasks }] = await Promise.all([
        api('/api/activities'),
        api('/api/tasks?view=all'),
      ]);
      activities = list;
      populateActivitySelect();
      renderProjects(list, tasks);
      return;
    }
    const { tasks } = await api(`/api/tasks?view=${view}`);
    renderTasks(tasks, view);
  } catch (err) {
    if (err.message !== 'unauthorized') showToast(err.message);
  }
}

async function refreshCounts() {
  try {
    const [today, all, stale, projects, done] = await Promise.all([
      api('/api/tasks?view=today'),
      api('/api/tasks?view=all'),
      api('/api/tasks?view=stale'),
      api('/api/activities'),
      api('/api/tasks?view=done'),
    ]);
    countToday.textContent = today.tasks.length || '';
    countAll.textContent = all.tasks.length || '';
    countStale.textContent = stale.tasks.length || '';
    countProjects.textContent = projects.activities.length || '';
    countDone.textContent = done.tasks.length || '';
  } catch {
    // silent — counts are a nicety, not critical
  }
}

// ---------------- Rendering ----------------

function renderEmptyState(empty) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  const emoji = document.createElement('div');
  emoji.className = 'emoji';
  emoji.textContent = empty.emoji;
  const headline = document.createElement('div');
  headline.className = 'headline';
  headline.textContent = empty.headline;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = empty.sub;
  div.append(emoji, headline, sub);
  return div;
}

function renderTasks(tasks, view) {
  taskList.innerHTML = '';
  if (tasks.length === 0) {
    taskList.appendChild(renderEmptyState(VIEW_EMPTY[view]));
    return;
  }

  const now = Date.now();
  for (const task of tasks) {
    taskList.appendChild(renderTaskCard(task, now));
  }
}

function renderTaskCard(task, now, opts = {}) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.status = task.status;
  card.style.setProperty('--spine', spineColor(task, now));

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.dataset.checked = task.status === 'done';
  check.setAttribute('aria-label', task.status === 'done' ? 'Mark as open' : 'Mark as done');
  check.textContent = task.status === 'done' ? '✓' : '';
  check.addEventListener('click', () => toggleDone(task));

  const body = document.createElement('div');
  body.className = 'task-body';

  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = task.title;
  body.appendChild(title);

  if (task.notes) {
    const notes = document.createElement('div');
    notes.className = 'task-notes';
    notes.textContent = task.notes;
    body.appendChild(notes);
  }

  const meta = document.createElement('div');
  meta.className = 'task-meta';

  if (task.status === 'done') {
    if (task.completed_at) {
      const closed = document.createElement('span');
      closed.className = 'closed';
      closed.textContent = `closed ${formatClosedDate(task.completed_at, now)}`;
      meta.appendChild(closed);
    }
  } else if (task.due_at) {
    const due = document.createElement('span');
    due.className = 'due';
    const overdue = task.due_at < now;
    const soon = !overdue && task.due_at - now < 24 * 60 * 60 * 1000;
    due.dataset.overdue = overdue;
    due.dataset.soon = soon;
    due.textContent = formatDue(task.due_at, now);
    meta.appendChild(due);
  }

  if (task.recurrence) {
    const recur = document.createElement('span');
    recur.className = 'recur';
    try {
      const r = JSON.parse(task.recurrence);
      recur.textContent = `↻ ${r.type.replace('_', ' ')}`;
    } catch {
      recur.textContent = '↻';
    }
    meta.appendChild(recur);
  }

  if (task.activity_title && !opts.hideActivity) {
    const project = document.createElement('span');
    project.className = 'project-tag';
    project.textContent = `▤ ${task.activity_title}`;
    meta.appendChild(project);
  }

  const priorityTag = document.createElement('span');
  priorityTag.textContent = task.priority;
  meta.appendChild(priorityTag);

  if (meta.children.length > 0) body.appendChild(meta);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'task-edit';
  edit.setAttribute('aria-label', 'Edit task');
  edit.textContent = '✎';
  edit.addEventListener('click', () => openEditModal(task));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-delete';
  del.setAttribute('aria-label', 'Delete task');
  del.textContent = '✕';
  del.addEventListener('click', () => deleteTask(task));

  card.append(check, body, edit, del);
  return card;
}

// ---------------- Projects view ----------------

function renderProjects(list, tasks) {
  taskList.innerHTML = '';
  taskList.appendChild(renderNewProjectRow());

  const now = Date.now();
  const openTasks = tasks.filter((t) => t.status === 'open');
  const unassigned = openTasks.filter((t) => !t.activity_id);

  if (list.length === 0 && unassigned.length === 0) {
    taskList.appendChild(renderEmptyState(VIEW_EMPTY.projects));
    return;
  }

  for (const activity of list) {
    const activityTasks = openTasks.filter((t) => t.activity_id === activity.id);
    taskList.appendChild(renderProjectGroup(activity, activityTasks, now));
  }

  if (unassigned.length > 0) {
    taskList.appendChild(renderProjectGroup(null, unassigned, now));
  }
}

function renderNewProjectRow() {
  const row = document.createElement('form');
  row.className = 'project-new';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'New project…';
  input.maxLength = 200;
  input.required = true;

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'project-new-submit';
  btn.textContent = '+';
  btn.setAttribute('aria-label', 'Add project');

  row.append(input, btn);

  row.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    try {
      await api('/api/activities', { method: 'POST', body: JSON.stringify({ title }) });
      showToast('Project added');
      loadView(currentView);
      refreshCounts();
    } catch (err) {
      showToast(err.message);
    }
  });

  return row;
}

function renderProjectGroup(activity, tasks, now) {
  const group = document.createElement('div');
  group.className = 'project-group';

  const header = document.createElement('div');
  header.className = 'project-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'project-title-wrap';

  const title = document.createElement('span');
  title.className = 'project-title';
  title.textContent = activity ? activity.title : 'Unassigned';
  titleWrap.appendChild(title);

  if (activity) {
    title.tabIndex = 0;
    title.title = 'Click to rename';
    title.addEventListener('click', () => startRenameActivity(activity, title));
  }

  const progress = document.createElement('span');
  progress.className = 'project-progress';
  progress.textContent = activity
    ? `${activity.open_count || 0} open · ${activity.done_count || 0} done`
    : `${tasks.length} loose`;
  titleWrap.appendChild(progress);

  header.appendChild(titleWrap);

  if (activity) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'project-delete';
    del.setAttribute('aria-label', 'Delete project');
    del.textContent = '✕';
    del.addEventListener('click', () => deleteProject(activity));
    header.appendChild(del);
  }

  group.appendChild(header);

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'project-empty';
    empty.textContent = 'Nothing open here.';
    group.appendChild(empty);
  } else {
    for (const task of tasks) {
      group.appendChild(renderTaskCard(task, now, { hideActivity: true }));
    }
  }

  return group;
}

function startRenameActivity(activity, titleEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'project-title-input';
  input.value = activity.title;
  input.maxLength = 200;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const value = input.value.trim();
    if (value && value !== activity.title) {
      try {
        await api(`/api/activities/${activity.id}`, { method: 'PATCH', body: JSON.stringify({ title: value }) });
      } catch (err) {
        showToast(err.message);
      }
    }
    loadView(currentView);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = activity.title;
      input.blur();
    }
  });
}

async function deleteProject(activity) {
  if (!confirm(`Delete "${activity.title}"? Its tasks stay — they'll just become unassigned.`)) return;
  try {
    await api(`/api/activities/${activity.id}`, { method: 'DELETE' });
    showToast('Project deleted');
    loadView(currentView);
    refreshCounts();
  } catch (err) {
    showToast(err.message);
  }
}

function spineColor(task, now) {
  if (task.status === 'done') return 'var(--accent-done)';
  if (task.due_at && task.due_at < now) return 'var(--accent-high)';
  if (task.due_at && task.due_at - now < 24 * 60 * 60 * 1000) return 'var(--accent-medium)';
  if (task.priority === 'high') return 'var(--accent-high)';
  if (task.priority === 'medium') return 'var(--accent-medium)';
  return 'var(--accent-low)';
}

function formatDue(dueAt, now) {
  const diff = dueAt - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  let text;
  if (mins < 60) text = `${mins}m`;
  else if (hours < 24) text = `${hours}h`;
  else text = `${days}d`;
  return diff < 0 ? `overdue ${text}` : `due in ${text}`;
}

function formatClosedDate(completedAt, now) {
  const diff = Math.max(0, now - completedAt);
  const mins = Math.round(diff / 60000);
  const hours = Math.round(diff / 3600000);
  const days = Math.round(diff / 86400000);
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ---------------- Task actions ----------------

async function toggleDone(task) {
  const nextStatus = task.status === 'done' ? 'open' : 'done';
  try {
    await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    loadView(currentView);
    refreshCounts();
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteTask(task) {
  try {
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    loadView(currentView);
    refreshCounts();
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------- Task editing ----------------

function toLocalDatetimeInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openEditModal(task) {
  editingTaskId = task.id;
  editTitleInput.value = task.title;
  editNotesInput.value = task.notes || '';
  editPriority.set(task.priority);
  editDueInput.value = task.due_at ? toLocalDatetimeInputValue(task.due_at) : '';
  editRecurInput.value = task.recurrence ? JSON.parse(task.recurrence).type : '';
  populateActivitySelectEl(editActivityInput, task.activity_id || '');
  taskEditModal.hidden = false;
}

function closeEditModal() {
  taskEditModal.hidden = true;
  editingTaskId = null;
}

editCancelBtn.addEventListener('click', closeEditModal);

taskEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = editTitleInput.value.trim();
  if (!title) return;

  const payload = {
    title,
    notes: editNotesInput.value.trim() || null,
    priority: editPriority.get(),
    due_at: editDueInput.value ? new Date(editDueInput.value).getTime() : null,
    recurrence: editRecurInput.value ? { type: editRecurInput.value } : null,
    activity_id: editActivityInput.value || null,
  };

  try {
    await api(`/api/tasks/${editingTaskId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    showToast('Task updated');
    closeEditModal();
    loadView(currentView);
    refreshCounts();
  } catch (err) {
    showToast(err.message);
  }
});

// ---------------- Toast ----------------

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.dataset.visible = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.dataset.visible = 'false';
  }, 2400);
}

// ---------------- Push notifications ----------------

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function checkNotifPermissionState() {
  if (!('Notification' in window)) {
    notifBtn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    notifBtn.classList.toggle('active', Boolean(sub));
  }
}

notifBtn.addEventListener('click', async () => {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      showToast('Push not supported on this browser');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
      notifBtn.classList.remove('active');
      showToast('Notifications off');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notifications blocked');
      return;
    }
    const { publicKey } = await api('/api/push/vapid-public-key');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    notifBtn.classList.add('active');
    showToast('Notifications on');
  } catch (err) {
    showToast(err.message || 'Could not enable notifications');
  }
});

// ---------------- Boot ----------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.error('sw register failed', err));
}

tryAutoUnlock();
