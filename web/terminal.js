const rgb = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

export class CanvasTerminal {
  constructor(canvas, ghostty) {
    this.canvas = canvas;
    this.ghostty = ghostty;
    this.context = canvas.getContext('2d', { alpha: false });
    this.fontSize = 14;
    this.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    this.cellWidth = 9;
    this.cellHeight = 19;
    this.onResize = () => {};
    this.selection = null;
    this.frame = null;
    this.#bindSelection();
  }

  fit() {
    const ratio = window.devicePixelRatio || 1;
    const bounds = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    this.canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.context.font = `${this.fontSize}px ${this.fontFamily}`;
    this.context.textBaseline = 'top';
    this.cellWidth = Math.ceil(this.context.measureText('M').width);
    this.cellHeight = Math.ceil(this.fontSize * 1.35);
    const cols = Math.max(2, Math.floor(bounds.width / this.cellWidth));
    const rows = Math.max(1, Math.floor(bounds.height / this.cellHeight));
    this.ghostty.resize(cols, rows, this.cellWidth, this.cellHeight);
    this.onResize({ cols, rows });
    this.render();
  }

  render() {
    const frame = this.ghostty.frame();
    this.frame = frame;
    this.context.fillStyle = rgb(frame.background);
    this.context.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    for (const cell of frame.cells) {
      if (cell.width === 2) continue;
      let foreground = cell.fg;
      let background = cell.bg;
      if (this.#selected(cell.x, cell.y)) [foreground, background] = [[11, 13, 17], [138, 173, 244]];
      if (cell.style.inverse) [foreground, background] = [background, foreground];
      const x = cell.x * this.cellWidth;
      const y = cell.y * this.cellHeight;
      this.context.fillStyle = rgb(background);
      this.context.fillRect(x, y, this.cellWidth * (cell.width === 1 ? 2 : 1), this.cellHeight);
      if (!cell.text || cell.style.invisible) continue;
      this.context.font = `${cell.style.italic ? 'italic ' : ''}${cell.style.bold ? 'bold ' : ''}${this.fontSize}px ${this.fontFamily}`;
      this.context.globalAlpha = cell.style.faint ? 0.55 : 1;
      this.context.fillStyle = rgb(foreground);
      this.context.fillText(cell.text, x, y + 1);
      this.context.globalAlpha = 1;
      if (cell.style.underline) this.#line(x, y + this.cellHeight - 2, foreground);
      if (cell.style.strike) this.#line(x, y + Math.floor(this.cellHeight / 2), foreground);
    }
    const cursor = frame.cursor;
    if (cursor.visible) {
      const x = cursor.x * this.cellWidth;
      const y = cursor.y * this.cellHeight;
      this.context.fillStyle = rgb(frame.foreground);
      if (cursor.style === 0) this.context.fillRect(x, y, 2, this.cellHeight);
      else if (cursor.style === 2) this.context.fillRect(x, y + this.cellHeight - 2, this.cellWidth, 2);
      else this.context.globalAlpha = 0.55, this.context.fillRect(x, y, this.cellWidth, this.cellHeight), this.context.globalAlpha = 1;
    }
  }

  #line(x, y, color) {
    this.context.fillStyle = rgb(color);
    this.context.fillRect(x, y, this.cellWidth, 1);
  }

  selectionText() {
    if (!this.selection || !this.frame) return '';
    const [start, end] = this.#orderedSelection();
    const lines = [];
    for (let y = start.y; y <= end.y; y++) {
      const left = y === start.y ? start.x : 0;
      const right = y === end.y ? end.x : this.ghostty.cols - 1;
      lines.push(this.frame.cells.filter(cell => cell.y === y && cell.x >= left && cell.x <= right && cell.width !== 2).map(cell => cell.text || ' ').join('').trimEnd());
    }
    return lines.join('\n');
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.render();
  }

  #bindSelection() {
    let selecting = false;
    this.canvas.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      selecting = true;
      const point = this.#point(event);
      this.selection = { start: point, end: point };
      this.render();
    });
    this.canvas.addEventListener('mousemove', event => {
      if (!selecting) return;
      this.selection.end = this.#point(event);
      this.render();
    });
    window.addEventListener('mouseup', () => selecting = false);
  }

  #point(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.ghostty.cols - 1, Math.floor((event.clientX - bounds.left) / this.cellWidth))),
      y: Math.max(0, Math.min(this.ghostty.rows - 1, Math.floor((event.clientY - bounds.top) / this.cellHeight))),
    };
  }

  #orderedSelection() {
    const { start, end } = this.selection;
    return start.y < end.y || start.y === end.y && start.x <= end.x ? [start, end] : [end, start];
  }

  #selected(x, y) {
    if (!this.selection) return false;
    const [start, end] = this.#orderedSelection();
    return (y > start.y || y === start.y && x >= start.x) && (y < end.y || y === end.y && x <= end.x);
  }
}
