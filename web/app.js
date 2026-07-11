import { GhosttyTerminal } from './ghostty.js';
import { CanvasTerminal } from './terminal.js';

const elements = Object.fromEntries(['projects', 'tabs', 'surfaces', 'status', 'context', 'split', 'restart', 'close-session', 'session-dialog', 'session-form', 'form-error', 'branch-field'].map(id => [id, document.getElementById(id)]));
const state = { projects: [], sessions: [], tabs: [], active: '', split: false, surfaces: new Map() };

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.text()).trim() || response.statusText);
  return response.status === 204 ? null : response.json();
}

async function refresh() {
  Object.assign(state, await request('/api/state'));
  renderSidebar();
  renderTabs();
  updateToolbar();
}

function renderSidebar() {
  elements.projects.replaceChildren(...state.projects.map(project => {
    const section = node('section', 'project');
    const title = node('div', 'project-title', project.name);
    title.title = project.path;
    if (!project.git) title.append(node('span', '', 'folder'));
    section.append(title);
    const sessions = state.sessions.filter(session => session.project === project.path);
    if (!sessions.length) section.append(node('div', 'no-sessions', 'No sessions'));
    for (const session of sessions) {
      const button = node('button', `session${session.id === state.active ? ' active' : ''}`);
      button.append(node('span', `dot ${session.status}`), node('span', 'session-name', session.name), node('span', 'agent', session.agent || 'shell'));
      button.title = `${session.cwd}\n${session.status}`;
      button.onclick = () => openSession(session.id);
      section.append(button);
    }
    return section;
  }));
}

function renderTabs() {
  elements.tabs.replaceChildren(...state.tabs.map(id => {
    const session = findSession(id);
    if (!session) return node('span');
    const tab = node('button', `tab${id === state.active ? ' active' : ''}`, session.name);
    tab.onclick = () => activate(id);
    return tab;
  }));
  renderSurfaces();
}

function renderSurfaces() {
  const peer = state.tabs.findLast(id => id !== state.active);
  const visible = state.split && peer ? [peer, state.active] : state.active ? [state.active] : [];
  elements.surfaces.classList.toggle('split', visible.length === 2);
  for (const [id, surface] of state.surfaces) {
    surface.element.hidden = !visible.includes(id);
    if (visible.includes(id)) requestAnimationFrame(() => surface.terminal.fit());
  }
  const children = visible.map(id => state.surfaces.get(id)?.element).filter(Boolean);
  if (children.length) elements.surfaces.replaceChildren(...children);
  else {
    elements.surfaces.innerHTML = '<div class="empty-state"><h1>Your agents, one workspace.</h1><p>Create a shell or coding agent from any mounted project.</p><button id="empty-new">New agent</button></div>';
    document.getElementById('empty-new').onclick = showCreate;
  }
}

async function openSession(id) {
  if (!state.tabs.includes(id)) state.tabs.push(id);
  if (!state.surfaces.has(id)) state.surfaces.set(id, await createSurface(id));
  activate(id);
}

function activate(id) {
  state.active = id;
  renderSidebar();
  renderTabs();
  updateToolbar();
  document.body.classList.remove('sidebar-open');
}

async function createSurface(id) {
  const element = node('section', 'surface');
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', `${findSession(id)?.name ?? 'Agent'} terminal`);
  const badge = node('span', 'surface-state', 'connecting');
  element.append(canvas, badge);
  const ghostty = await GhosttyTerminal.create('/ghostty-vt.wasm', 120, 40);
  const terminal = new CanvasTerminal(canvas, ghostty);
  const surface = { element, canvas, badge, ghostty, terminal, socket: null, retry: null, disposed: false };
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
    surface.canvas.focus();
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
  surface.canvas.addEventListener('keydown', event => {
    if (surface.socket?.readyState !== WebSocket.OPEN) return;
    if ((event.metaKey || event.ctrlKey) && ['c', 'v'].includes(event.key.toLowerCase()) && event.shiftKey) return;
    const data = surface.ghostty.encodeKey(event);
    if (!data.length) return;
    event.preventDefault();
    surface.socket.send(data);
  });
  surface.canvas.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text');
    if (!text || surface.socket?.readyState !== WebSocket.OPEN) return;
    event.preventDefault();
    surface.socket.send(new TextEncoder().encode(text));
  });
}

function showCreate(project = state.projects[0]?.path) {
  const select = elements['session-form'].elements.project;
  select.replaceChildren(...state.projects.map(item => new Option(item.name, item.path, false, item.path === project)));
  elements['session-form'].reset();
  if (project) select.value = project;
  elements['form-error'].textContent = '';
  elements['session-dialog'].showModal();
}

elements['session-form'].onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = { project: form.get('project'), name: form.get('name'), agent: form.get('agent'), newWorktree: form.get('newWorktree') === 'on', branch: form.get('branch') };
  try {
    elements.status.textContent = 'creating…';
    const session = await request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    elements['session-dialog'].close();
    await refresh();
    await openSession(session.id);
    elements.status.textContent = 'ready';
  } catch (error) {
    elements['form-error'].textContent = error.message;
    elements.status.textContent = 'error';
  }
};

function updateToolbar() {
  const session = findSession(state.active);
  elements.context.textContent = session ? `${session.name} — ${session.branch || relativeProject(session.project)}` : 'Agent workspace';
  elements.split.disabled = state.tabs.length < 2;
  elements.restart.disabled = !session;
  elements['close-session'].disabled = !session;
}

elements.split.onclick = () => {
  state.split = !state.split;
  renderSurfaces();
};
elements.restart.onclick = async () => { if (state.active) await request(`/api/sessions/${state.active}/restart`, { method: 'POST' }), await refresh(); };
elements['close-session'].onclick = async () => {
  const session = findSession(state.active);
  if (!session || !confirm(`Close ${session.name}? Its worktree, if any, will be kept.`)) return;
  await request(`/api/sessions/${session.id}`, { method: 'DELETE' });
  const surface = state.surfaces.get(session.id);
  if (surface) surface.disposed = true;
  clearTimeout(surface?.retry);
  surface?.socket?.close();
  state.surfaces.delete(session.id);
  state.tabs = state.tabs.filter(id => id !== session.id);
  state.active = state.tabs.at(-1) ?? '';
  await refresh();
};

document.getElementById('new-session').onclick = () => showCreate();
document.getElementById('empty-new').onclick = () => showCreate();
document.getElementById('cancel').onclick = () => elements['session-dialog'].close();
document.getElementById('sidebar-toggle').onclick = () => document.body.classList.toggle('sidebar-open');
elements['session-form'].elements.newWorktree.onchange = event => elements['branch-field'].hidden = !event.target.checked;

function findSession(id) { return state.sessions.find(session => session.id === id); }
function relativeProject(path) { return state.projects.find(project => project.path === path)?.name ?? path; }
function node(tag, className = '', text = '') { const element = document.createElement(tag); element.className = className; if (text) element.textContent = text; return element; }

await refresh();
