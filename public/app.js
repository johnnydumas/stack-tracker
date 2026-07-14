const STORAGE_KEY = 'stack_passcode';

const gate = document.getElementById('gate');
const app = document.getElementById('app');
const passcodeInput = document.getElementById('passcode-input');
const gateError = document.getElementById('gate-error');
const unlockBtn = document.getElementById('unlock-btn');
const lockBtn = document.getElementById('lock-btn');
const notifBtn = document.getElementById('notif-btn');
const quickAddForm = document.getElementById('quick-add-form');
const titleInput = document.getElementById('title-input');
const dueInput = document.getElementById('due-input');
const recurInput = document.getElementById('recur-input');
const priorityChips = document.querySelectorAll('.chip[data-priority]');
const tabs = document.querySelectorAll('.tab[data-view]');
const viewTitle = document.getElementById('view-title');
const taskList = document.getElementById('task-list');
const toast = document.getElementById('toast');
const countToday = document.getElementById('count-today');
const countAll = document.getElementById('count-all');
const countStale = document.getElementById('count-stale');

let selectedPriority = 'medium';
let currentView = 'today';

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

function showApp() {
  gate.hidden = true;
  app.hidden = false;
  loadView(currentView);
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

// ---------------- Quick add ----------------

priorityChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    selectedPriority = chip.dataset.priority;
    priorityChips.forEach((c) => c.removeAttribute('data-active'));
    chip.dataset.active = 'true';
  });
});

quickAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;

  const payload = { title, priority: selectedPriority };
  if (dueInput.value) payload.due_at = new Date(dueInput.value).getTime();
  if (recurInput.value) payload.recurrence = { type: recurInput.value };

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

const VIEW_TITLES = { today: 'The Stack', all: 'Everything', stale: "Hasn't moved in a week" };
const VIEW_EMPTY = {
  today: { emoji: '✨', headline: 'Nothing on top', sub: 'Add a task above to get started.' },
  all: { emoji: '📭', headline: 'No tasks yet', sub: 'Whatever\u2019s on your mind — add it.' },
  stale: { emoji: '🧹', headline: 'Nothing stale', sub: 'Everything\u2019s been touched recently.' },
};

async function loadView(view) {
  viewTitle.textContent = VIEW_TITLES[view];
  taskList.innerHTML = '';
  try {
    const { tasks } = await api(`/api/tasks?view=${view}`);
    renderTasks(tasks, view);
  } catch (err) {
    if (err.message !== 'unauthorized') showToast(err.message);
  }
}

async function refreshCounts() {
  try {
    const [today, all, stale] = await Promise.all([
      api('/api/tasks?view=today'),
      api('/api/tasks?view=all'),
      api('/api/tasks?view=stale'),
    ]);
    countToday.textContent = today.tasks.length || '';
    countAll.textContent = all.tasks.filter((t) => t.status === 'open').length || '';
    countStale.textContent = stale.tasks.length || '';
  } catch {
    // silent — counts are a nicety, not critical
  }
}

// ---------------- Rendering ----------------

function renderTasks(tasks, view) {
  if (tasks.length === 0) {
    const empty = VIEW_EMPTY[view];
    taskList.innerHTML = `
      <div class="empty-state">
        <div class="emoji">${empty.emoji}</div>
        <div class="headline">${empty.headline}</div>
        <div class="sub">${empty.sub}</div>
      </div>`;
    return;
  }

  const now = Date.now();
  taskList.innerHTML = '';
  for (const task of tasks) {
    taskList.appendChild(renderTaskCard(task, now));
  }
}

function renderTaskCard(task, now) {
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

  if (task.due_at) {
    const due = document.createElement('span');
    due.className = 'due';
    const overdue = task.status === 'open' && task.due_at < now;
    const soon = task.status === 'open' && !overdue && task.due_at - now < 24 * 60 * 60 * 1000;
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

  const priorityTag = document.createElement('span');
  priorityTag.textContent = task.priority;
  meta.appendChild(priorityTag);

  if (meta.children.length > 0) body.appendChild(meta);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-delete';
  del.setAttribute('aria-label', 'Delete task');
  del.textContent = '✕';
  del.addEventListener('click', () => deleteTask(task));

  card.append(check, body, del);
  return card;
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
