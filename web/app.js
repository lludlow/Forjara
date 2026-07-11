const terminal = document.querySelector('#terminal');
const status = document.querySelector('#status');
const decoder = new TextDecoder();
let socket;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/api/terminal`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    status.textContent = 'connected';
    resize();
    terminal.focus();
  };
  socket.onmessage = (event) => {
    terminal.textContent += typeof event.data === 'string' ? event.data : decoder.decode(event.data);
    terminal.scrollTop = terminal.scrollHeight;
  };
  socket.onclose = () => {
    status.textContent = 'disconnected';
    setTimeout(connect, 1000);
  };
}

function resize() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const style = getComputedStyle(terminal);
  const probe = document.createElement('span');
  probe.textContent = 'M';
  probe.style.font = style.font;
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  socket.send(JSON.stringify({
    type: 'resize',
    cols: Math.max(2, Math.floor(terminal.clientWidth / rect.width)),
    rows: Math.max(1, Math.floor(terminal.clientHeight / rect.height)),
  }));
}

terminal.addEventListener('keydown', (event) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const keys = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D' };
  const value = keys[event.key] ?? (event.key.length === 1 ? event.key : '');
  if (!value) return;
  event.preventDefault();
  socket.send(new TextEncoder().encode(event.ctrlKey && value.length === 1 ? String.fromCharCode(value.toUpperCase().charCodeAt(0) - 64) : value));
});

new ResizeObserver(resize).observe(terminal);
connect();
