import { GhosttyTerminal } from './ghostty.js';
import { CanvasTerminal } from './terminal.js';

const canvas = document.querySelector('#terminal');
const status = document.querySelector('#status');
const ghostty = await GhosttyTerminal.create('/ghostty-vt.wasm', 120, 40);
const terminal = new CanvasTerminal(canvas, ghostty);
let socket;
let retry;

function connect() {
  clearTimeout(retry);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/api/terminal`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    status.textContent = 'connected';
    terminal.onResize = ({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };
    terminal.fit();
    canvas.focus();
  };
  socket.onmessage = ({ data }) => {
    if (typeof data === 'string') return;
    ghostty.write(new Uint8Array(data));
    terminal.render();
  };
  socket.onclose = () => {
    status.textContent = 'disconnected';
    retry = setTimeout(connect, 1000);
  };
}

canvas.addEventListener('keydown', (event) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if ((event.metaKey || event.ctrlKey) && ['c', 'v'].includes(event.key.toLowerCase()) && event.shiftKey) return;
  const data = ghostty.encodeKey(event);
  if (!data.length) return;
  event.preventDefault();
  socket.send(data);
});

canvas.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text');
  if (!text || socket?.readyState !== WebSocket.OPEN) return;
  event.preventDefault();
  socket.send(new TextEncoder().encode(text));
});

new ResizeObserver(() => terminal.fit()).observe(canvas);
connect();
