import { GhosttyTerminal } from './ghostty.js';
import { CanvasTerminal } from './terminal.js';

const elements = Object.fromEntries(['projects', 'tabs', 'surfaces', 'status', 'context-title', 'context-sub', 'split', 'restart', 'session-dialog', 'session-form', 'form-error', 'branch-field', 'target-note'].map(id => [id, document.getElementById(id)]));
// A workspace is a place code lives: the project checkout or one worktree.
// The sidebar lists workspaces; the tab bar lists the sessions inside the
// selected workspace. state.active is the focused session id.
const state = { projects: [], sessions: [], selected: '', active: '', split: false, surfaces: new Map() };
const saved = loadLayout();

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.text()).trim() || response.statusText);
  return response.status === 204 ? null : response.json();
}

const wsKey = (project, worktree) => `${project}\u0000${worktree || ''}`;

function workspaceList() {
  const list = [];
  for (const project of state.projects) {
    const sessions = state.sessions.filter(session => session.project === project.path);
    list.push({ key: wsKey(project.path), project, worktree: '', branch: '', sessions: sessions.filter(session => !session.worktree) });
    for (const worktree of new Set(sessions.filter(session => session.worktree).map(session => session.worktree))) {
      const members = sessions.filter(session => session.worktree === worktree);
      list.push({ key: wsKey(project.path, worktree), project, worktree, branch: members[0].branch, sessions: members });
    }
  }
  return list;
}

function findWorkspace(key) { return workspaceList().find(ws => ws.key === key); }
function currentWorkspace() { return findWorkspace(state.selected); }
function wsTitle(ws) { return ws.worktree ? (ws.branch || ws.worktree.split('/').pop()) : (ws.project.git ? 'main' : 'files'); }

async function refresh() {
  Object.assign(state, await request('/api/state'));
  for (const id of [...state.surfaces.keys()]) if (!state.sessions.some(session => session.id === id)) disposeSurface(id);
  const list = workspaceList();
  if (!list.some(ws => ws.key === state.selected)) state.selected = list[0]?.key ?? '';
  const ws = currentWorkspace();
  if (state.active && !ws?.sessions.some(session => session.id === state.active)) state.active = '';
  if (!state.active && ws?.sessions.length) {
    const remembered = saved.active?.[state.selected];
    return activate(ws.sessions.find(session => session.id === remembered)?.id ?? ws.sessions.at(-1).id);
  }
  renderAll();
}

function renderAll() {
  renderSidebar();
  renderTabs();
  updateToolbar();
}

function renderSidebar() {
  const byProject = new Map(state.projects.map(project => [project.path, []]));
  for (const ws of workspaceList()) byProject.get(ws.project.path)?.push(ws);
  elements.projects.replaceChildren(...state.projects.map(project => {
    const section = node('section', 'project');
    const title = node('div', 'project-title', project.name);
    title.title = project.path;
    if (!project.git) title.append(node('span', '', 'folder'));
    section.append(title);
    for (const ws of byProject.get(project.path)) {
      const button = node('button', `session${ws.key === state.selected ? ' active' : ''}`);
      const subtitle = ws.sessions.length ? ws.sessions.map(session => session.agent || 'shell').join(' · ') : 'no tabs';
      const titles = node('span', 'session-titles');
      titles.append(node('span', 'session-name', wsTitle(ws)), node('span', 'session-sub', subtitle));
      button.append(icon(ws.worktree ? 'branch' : 'terminal'), titles, node('span', `dot ${wsDot(ws)}`));
      if (ws.sessions.length || ws.worktree) {
        const close = node('span', 'ws-close', '✕');
        close.title = `Close ${wsTitle(ws)}`;
        close.setAttribute('role', 'button');
        close.onclick = event => { event.stopPropagation(); closeWorkspace(ws); };
        button.append(close);
      }
      button.title = ws.worktree || ws.project.path;
      button.onclick = () => selectWorkspace(ws.key);
      section.append(button);
    }
    return section;
  }));
}

function wsDot(ws) {
  const states = ws.sessions.map(session => session.activity || session.status);
  for (const level of ['awaiting_input', 'notification', 'busy', 'started', 'running', 'idle']) if (states.includes(level)) return level;
  return 'stopped';
}

function selectWorkspace(key) {
  state.selected = key;
  document.body.classList.remove('sidebar-open');
  const ws = currentWorkspace();
  const remembered = saved.active?.[key];
  const target = ws?.sessions.find(session => session.id === remembered) ?? ws?.sessions.at(-1);
  state.active = '';
  if (target) activate(target.id);
  else {
    renderAll();
    persistLayout();
  }
}

async function activate(id) {
  state.active = id;
  saved.active[state.selected] = id;
  persistLayout();
  if (!state.surfaces.has(id)) state.surfaces.set(id, await createSurface(id));
  renderAll();
}

function renderTabs() {
  const ws = currentWorkspace();
  const add = node('button', 'tab-new', '+');
  add.title = 'New tab in this workspace (⌘K)';
  add.onclick = () => showCreate();
  elements.tabs.replaceChildren(...(ws?.sessions ?? []).map(session => {
    const tab = node('div', `tab${session.id === state.active ? ' active' : ''}`);
    tab.setAttribute('role', 'tab');
    const close = node('button', 'tab-close', '✕');
    close.title = `Close ${session.name}`;
    close.onclick = event => { event.stopPropagation(); closeSession(session); };
    tab.append(node('span', `dot ${session.activity || session.status}`), node('span', 'tab-title', session.name), close);
    tab.onclick = () => activate(session.id);
    tab.onauxclick = event => { if (event.button === 1) closeSession(session); };
    return tab;
  }), ...(ws ? [add] : []));
  renderSurfaces();
}

async function closeWorkspace(ws) {
  const label = wsTitle(ws);
  const tabs = ws.sessions.length ? `Its ${ws.sessions.length === 1 ? 'tab stops' : ws.sessions.length + ' tabs stop'}.` : '';
  if (!confirm(`Close ${label}? ${tabs}`.trim())) return;
  for (const session of ws.sessions) {
    await request(`/api/sessions/${session.id}`, { method: 'DELETE' });
    disposeSurface(session.id);
  }
  if (ws.worktree && confirm(`Also remove the ${label} worktree directory? The branch is kept. Cancel keeps the files on disk.`)) {
    try {
      await request('/api/worktrees/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: ws.project.path, worktree: ws.worktree }) });
    } catch (error) {
      alert(`Worktree kept: ${error.message}`);
    }
  }
  if (state.selected === ws.key) state.active = '';
  await refresh();
}

async function closeSession(session) {
  if (!confirm(`Close ${session.name}? Its terminal and agent stop; a worktree is kept.`)) return;
  await request(`/api/sessions/${session.id}`, { method: 'DELETE' });
  disposeSurface(session.id);
  if (state.active === session.id) state.active = '';
  await refresh();
}

function disposeSurface(id) {
  const surface = state.surfaces.get(id);
  if (!surface) return;
  surface.disposed = true;
  clearTimeout(surface.retry);
  surface.socket?.close();
  state.surfaces.delete(id);
}

function renderSurfaces() {
  const ids = (currentWorkspace()?.sessions ?? []).map(session => session.id);
  const peer = ids.filter(id => id !== state.active && state.surfaces.has(id)).at(-1);
  const visible = state.split && peer && state.active ? [peer, state.active] : state.active ? [state.active] : [];
  elements.surfaces.classList.toggle('split', visible.length === 2);
  for (const [id, surface] of state.surfaces) {
    surface.element.hidden = !visible.includes(id);
    if (visible.includes(id)) requestAnimationFrame(() => surface.terminal.fit());
  }
  const children = visible.map(id => state.surfaces.get(id)?.element).filter(Boolean);
  if (children.length) elements.surfaces.replaceChildren(...children);
  else {
    elements.surfaces.innerHTML = '<div class="empty-state"><h1>Your agents, one workspace.</h1><p>Create a shell or coding agent from any mounted project.</p><button id="empty-new" class="primary">New agent</button></div>';
    document.getElementById('empty-new').onclick = showCreate;
  }
}

async function createSurface(id) {
  const element = node('section', 'surface');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', `${findSession(id)?.name ?? 'Agent'} terminal`);
  // ponytail: hidden textarea owns focus so copy/paste work natively in every
  // browser and over plain http — canvases never reliably receive clipboard events.
  const input = document.createElement('textarea');
  input.className = 'surface-input';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-hidden', 'true');
  const badge = node('span', 'surface-state', 'connecting');
  element.append(canvas, input, badge);
  const ghostty = await GhosttyTerminal.create('/ghostty-vt.wasm', 120, 40);
  const terminal = new CanvasTerminal(canvas, ghostty);
  const surface = { element, canvas, input, badge, ghostty, terminal, socket: null, retry: null, disposed: false };
  bindInput(surface);
  connectSurface(id, surface);
  new ResizeObserver(() => !element.hidden && terminal.fit()).observe(element);
  return surface;
}

function connectSurface(id, surface) {
  clearTimeout(surface.retry);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${id}/terminal`);
  surface.socket = socket;
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    surface.badge.textContent = 'connected';
    surface.terminal.onResize = size => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'resize', ...size }));
    surface.terminal.fit();
    surface.input.focus();
  };
  socket.onmessage = ({ data }) => {
    if (typeof data === 'string') return;
    try {
      surface.ghostty.write(new Uint8Array(data));
      surface.terminal.render();
    } catch (error) {
      surface.badge.textContent = error.message;
      console.error(error);
    }
  };
  socket.onclose = () => {
    if (surface.disposed) return;
    surface.badge.textContent = 'reconnecting';
    surface.retry = setTimeout(() => connectSurface(id, surface), 1000);
  };
}

function bindInput(surface) {
  const input = surface.input;
  const send = text => surface.socket?.readyState === WebSocket.OPEN && surface.socket.send(new TextEncoder().encode(text));
  // The native copy command is the one clipboard path that works everywhere,
  // including plain-http origins: we let the browser fire `copy` and supply
  // the terminal selection via clipboardData. execCommand('copy') alone can
  // return true without writing the clipboard in current Chrome.
  input.addEventListener('copy', event => {
    const text = surface.terminal.selectionText();
    input.value = '';
    if (!text) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    surface.terminal.clearSelection();
  });
  const copySelection = () => {
    const text = surface.terminal.selectionText();
    if (!text) return false;
    // Stage a dummy selection so browsers don't suppress the copy command,
    // then let the copy listener above replace the payload.
    input.value = ' ';
    input.select();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => { input.value = ''; surface.terminal.clearSelection(); })
        .catch(() => document.execCommand('copy'));
    } else document.execCommand('copy');
    return true;
  };
  surface.canvas.addEventListener('mousedown', event => {
    event.preventDefault();
    input.focus();
  });
  // Right-click pastes, PuTTY-style; with a selection it copies instead.
  surface.canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (copySelection()) return;
    navigator.clipboard?.readText().then(text => text && send(text)).catch(() => {});
  });
  input.addEventListener('keydown', event => {
    if (surface.socket?.readyState !== WebSocket.OPEN) return;
    const combo = event.metaKey || event.ctrlKey;
    // Windows Terminal semantics: Ctrl/Cmd+C copies when a selection exists,
    // otherwise falls through to the pty (SIGINT). Don't preventDefault —
    // returning lets the browser's native copy command fire, and the copy
    // listener fills in the selection text.
    if (event.key.toLowerCase() === 'c' && combo && surface.terminal.selectionText()) {
      input.value = ' ';
      input.select();
      return;
    }
    // Let the browser's native paste fire on the textarea (Cmd+V, Ctrl+V,
    // Ctrl+Shift+V). ponytail: plain Ctrl+V no longer sends ^V to the pty.
    if (event.key.toLowerCase() === 'v' && combo) return;
    // Cmd is not a terminal modifier: leave every other Cmd shortcut to the
    // browser instead of leaking bare letters into the pty.
    if (event.metaKey && !event.ctrlKey) return;
    const data = surface.ghostty.encodeKey(event);
    if (!data.length) return;
    surface.terminal.clearSelection();
    event.preventDefault();
    surface.socket.send(data);
  });
  input.addEventListener('paste', event => {
    event.preventDefault();
    input.value = '';
    const text = event.clipboardData?.getData('text');
    if (text) send(text);
  });
  input.addEventListener('input', () => { input.value = ''; });
}

function showCreate() {
  const ws = currentWorkspace();
  const project = ws?.project.path ?? state.projects[0]?.path;
  const select = elements['session-form'].elements.project;
  select.replaceChildren(...state.projects.map(item => new Option(item.name, item.path, false, item.path === project)));
  elements['session-form'].reset();
  if (project) select.value = project;
  elements['form-error'].textContent = '';
  elements['target-note'].textContent = ws?.worktree ? `Opens as a new tab in ${wsTitle(ws)}` : '';
  elements['session-dialog'].showModal();
}

elements['session-form'].onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const ws = currentWorkspace();
  const newWorktree = form.get('newWorktree') === 'on';
  const joinWorktree = !newWorktree && ws?.worktree && form.get('project') === ws.project.path ? ws.worktree : '';
  const body = { project: form.get('project'), name: form.get('name'), agent: form.get('agent'), newWorktree, branch: form.get('branch'), worktree: joinWorktree };
  try {
    elements.status.textContent = 'creating…';
    const session = await request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    elements['session-dialog'].close();
    state.selected = wsKey(session.project, session.worktree);
    state.active = '';
    await refresh();
    await activate(session.id);
    elements.status.textContent = 'ready';
  } catch (error) {
    elements['form-error'].textContent = error.message;
    elements.status.textContent = 'error';
  }
};

function updateToolbar() {
  const ws = currentWorkspace();
  const session = findSession(state.active);
  elements['context-title'].textContent = ws ? wsTitle(ws) : 'Agent workspace';
  elements['context-sub'].textContent = ws ? [ws.project.name, session?.name].filter(Boolean).join(' · ') : '';
  elements.split.disabled = !ws || ws.sessions.length < 2;
  elements.restart.disabled = !session;
}

elements.split.onclick = () => {
  state.split = !state.split;
  renderSurfaces();
  persistLayout();
};
elements.restart.onclick = async () => { if (state.active) await request(`/api/sessions/${state.active}/restart`, { method: 'POST' }), await refresh(); };

document.getElementById('new-session').onclick = () => showCreate();
document.getElementById('cancel').onclick = () => elements['session-dialog'].close();
document.getElementById('sidebar-toggle').onclick = () => document.body.classList.toggle('sidebar-open');
elements['session-form'].elements.newWorktree.onchange = event => elements['branch-field'].hidden = !event.target.checked;

const ICONS = {
  branch: '<circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="3.5" r="1.8"/><path d="M4.5 5.3v5.4M11.5 5.3c0 3.2-7 2.2-7 5.4"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="2.5"/><path d="M4.5 6.2l2.2 2-2.2 2M8.7 10.2h2.8"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

// ⌘K (or Ctrl+Shift+K) opens the new-agent palette even while a terminal has
// focus; capture phase beats the pty keydown handler.
window.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  if (!((event.metaKey && !event.ctrlKey && key === 'k') || (event.ctrlKey && event.shiftKey && key === 'k'))) return;
  event.preventDefault();
  event.stopPropagation();
  if (elements['session-dialog'].open) elements['session-dialog'].close();
  else showCreate();
}, true);

function findSession(id) { return state.sessions.find(session => session.id === id); }
function node(tag, className = '', text = '') { const element = document.createElement(tag); element.className = className; if (text) element.textContent = text; return element; }
function persistLayout() { localStorage.setItem('forjara.layout', JSON.stringify({ selected: state.selected, active: saved.active ?? {}, split: state.split })); }
function loadLayout() {
  try {
    const layout = JSON.parse(localStorage.getItem('forjara.layout') || '{}');
    // active was a session-id string in older layouts; it is now a map of
    // workspace key -> session id.
    if (typeof layout.active !== 'object' || !layout.active) layout.active = {};
    return layout;
  } catch { return {}; }
}

state.selected = saved.selected || '';
state.split = Boolean(saved.split);
await refresh();
const events = new EventSource('/api/events');
events.addEventListener('state', () => refresh().catch(error => elements.status.textContent = error.message));
