// ── State ──────────────────────────────────────────────────────────────────────
const agentMap = new Map();   // id → AgentStatus
const taskSet  = new Set();   // id → seen, to detect new rows
const MAX_FEED_ROWS = 50;

let sseSource      = null;
let retryDelay     = 3000;    // ms — grows with backoff
const MAX_RETRY    = 30000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour12: false }); // HH:MM:SS
}

function statusRowClass(status) {
  if (status === 'in_progress') return 'running';
  if (status === 'completed')   return 'done';
  if (status === 'failed')      return 'error';
  return 'pending';
}

// ── SSE status indicator ───────────────────────────────────────────────────────

function setSSEStatus(state) {
  const dot   = document.getElementById('sse-dot');
  const label = document.getElementById('sse-label');
  dot.className = 'sse-dot ' + state;
  if (state === 'live')         label.textContent = '· LIVE';
  else if (state === 'reconnecting') label.textContent = '· RECONNECTING';
  else                          label.textContent = '· OFFLINE';
}

// ── Health bar ─────────────────────────────────────────────────────────────────

function updateHealth(health) {
  document.getElementById('health-online').textContent = health.agentsOnline ?? '—';
  document.getElementById('health-queue').textContent  = health.queueDepth  ?? '—';
  document.getElementById('health-today').textContent  = health.todayCount  ?? '—';
}

// ── Agent grid ─────────────────────────────────────────────────────────────────

function upsertAgentCard(agent) {
  const grid = document.getElementById('agent-grid');

  // Remove empty state on first agent
  const empty = grid.querySelector('.empty-state');
  if (empty) empty.remove();

  const cardId = 'agent-' + agent.id;
  let card = document.getElementById(cardId);

  const statusClass = ['idle', 'busy', 'offline'].includes(agent.status)
    ? agent.status
    : 'offline';

  if (!card) {
    // Create new card
    card = document.createElement('div');
    card.id = cardId;
    card.className = 'agent-card ' + statusClass;
    card.setAttribute('data-agent-id', agent.id);
    card.innerHTML = buildCardHTML(agent, statusClass);
    grid.appendChild(card);
  } else {
    // Update in-place — only mutate changed fields
    card.className = 'agent-card ' + statusClass;

    const nameEl = card.querySelector('.card-name');
    if (nameEl && nameEl.textContent !== agent.name) {
      nameEl.textContent = agent.name;
    }

    const roleEl = card.querySelector('.card-role');
    const roleText = agent.role.replace(/_/g, ' ');
    if (roleEl && roleEl.textContent !== roleText) {
      roleEl.textContent = roleText;
    }

    const dotEl = card.querySelector('.status-dot');
    if (dotEl) dotEl.className = 'status-dot ' + statusClass;

    const taskEl = card.querySelector('.card-task');
    const taskText = agent.currentTask || (statusClass === 'offline' ? 'Offline' : 'Waiting for task…');
    if (taskEl && taskEl.textContent !== taskText) {
      taskEl.textContent = taskText;
      taskEl.title = taskText;
    }

    const footerEl = card.querySelector('.card-footer');
    if (footerEl) footerEl.textContent = 'Updated ' + fmtTime(agent.updatedAt);
  }
}

function buildCardHTML(agent, statusClass) {
  const taskText = agent.currentTask || (statusClass === 'offline' ? 'Offline' : 'Waiting for task…');
  return `
    <div class="card-top">
      <div class="status-dot ${escHtml(statusClass)}"></div>
      <div class="card-meta">
        <div class="card-name">${escHtml(agent.name)}</div>
        <div class="card-role">${escHtml(agent.role.replace(/_/g, ' '))}</div>
      </div>
    </div>
    <div class="card-task" title="${escHtml(taskText)}">${escHtml(taskText)}</div>
    <div class="card-footer">Updated ${fmtTime(agent.updatedAt)}</div>
  `;
}

function handleAgents(agents) {
  const receivedIds = new Set(agents.map(a => a.id));

  // Upsert each received agent
  for (const agent of agents) {
    agentMap.set(agent.id, agent);
    upsertAgentCard(agent);
  }

  // Mark agents no longer in the list as offline (don't remove the card)
  for (const [id, agent] of agentMap) {
    if (!receivedIds.has(id)) {
      const offlineAgent = { ...agent, status: 'offline', currentTask: '' };
      agentMap.set(id, offlineAgent);
      upsertAgentCard(offlineAgent);
    }
  }
}

// ── Task feed ──────────────────────────────────────────────────────────────────

function handleTasks(tasks) {
  const feed = document.getElementById('task-feed');

  const newTasks = tasks.filter(t => !taskSet.has(t.id));
  const existingTasks = tasks.filter(t => taskSet.has(t.id));

  // Update status of already-rendered rows (e.g. in_progress → completed)
  for (const task of existingTasks) {
    const row = feed.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`);
    if (!row) continue;
    const rowClass = statusRowClass(task.status);
    row.className = 'feed-row ' + rowClass;
    const badge = row.querySelector('.feed-badge');
    if (badge) {
      const badgeClass = task.status === 'in_progress' ? 'running' : task.status;
      const badgeLabel = task.status === 'in_progress' ? 'running' : task.status;
      badge.className = 'feed-badge ' + badgeClass;
      badge.textContent = badgeLabel;
    }
    const tsEl = row.querySelector('.feed-ts');
    if (tsEl) tsEl.textContent = fmtTime(task.createdAt);
  }

  if (newTasks.length === 0) return;

  // Remove empty state placeholder
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  // Prepend newest tasks (tasks array is already DESC, so first = newest)
  for (const task of newTasks) {
    taskSet.add(task.id);
    prependTaskRow(task, feed);
  }

  // Cap DOM at MAX_FEED_ROWS
  while (feed.children.length > MAX_FEED_ROWS) {
    feed.removeChild(feed.lastChild);
  }
}

function prependTaskRow(task, feed) {
  const rowClass = statusRowClass(task.status);
  const badgeClass = task.status === 'in_progress' ? 'running' : task.status;
  const badgeLabel = task.status === 'in_progress' ? 'running' : task.status;

  const row = document.createElement('div');
  row.className = 'feed-row ' + rowClass;
  row.setAttribute('data-task-id', task.id);
  row.innerHTML = `
    <span class="feed-agent">${escHtml(task.agentName)}</span>
    <span class="feed-instruction" title="${escHtml(task.instruction)}">${escHtml(task.instruction)}</span>
    <span class="feed-badge ${escHtml(badgeClass)}">${escHtml(badgeLabel)}</span>
    <span class="feed-ts">${fmtTime(task.createdAt)}</span>
  `;

  feed.insertBefore(row, feed.firstChild);
}

// ── SSE connection ─────────────────────────────────────────────────────────────

function connectSSE() {
  taskSet.clear(); // reset so full re-render happens on reconnect

  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }

  setSSEStatus('reconnecting');

  const es = new EventSource('/api/events');
  sseSource = es;

  es.onopen = () => {
    setSSEStatus('live');
    retryDelay = 3000; // reset backoff on successful connect
  };

  es.addEventListener('agents', (e) => {
    try {
      const agents = JSON.parse(e.data);
      handleAgents(agents);
    } catch (err) {
      console.error('[dashboard] Failed to parse agents event:', err);
    }
  });

  es.addEventListener('tasks', (e) => {
    try {
      const tasks = JSON.parse(e.data);
      handleTasks(tasks);
    } catch (err) {
      console.error('[dashboard] Failed to parse tasks event:', err);
    }
  });

  es.addEventListener('health', (e) => {
    try {
      const health = JSON.parse(e.data);
      updateHealth(health);
    } catch (err) {
      console.error('[dashboard] Failed to parse health event:', err);
    }
  });

  es.onerror = () => {
    setSSEStatus('reconnecting');
    es.close();
    sseSource = null;

    console.warn('[dashboard] SSE error — reconnecting in', retryDelay, 'ms');
    setTimeout(() => {
      connectSSE();
      // Exponential backoff: 3s → 6s → 12s → 30s max
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
    }, retryDelay);
  };
}

// ── Boot ───────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  connectSSE();
});
