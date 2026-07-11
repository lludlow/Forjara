const RS = { COLS: 1, ROWS: 2, ROWS_ITERATOR: 4, BG: 5, FG: 6, CURSOR_STYLE: 10, CURSOR_VISIBLE: 11, CURSOR_HAS_VALUE: 14, CURSOR_X: 15, CURSOR_Y: 16 };
const ROW = { CELLS: 3 };
const CELL = { RAW: 1, STYLE: 2, GRAPHEMES_LEN: 3, GRAPHEMES_BUF: 4, BG: 5, FG: 6, HAS_STYLE: 8 };

export class GhosttyTerminal {
  static async create(path, cols, rows) {
    let instance;
    const imports = { env: { log: (pointer, length) => {
      if (!instance) return;
      const bytes = new Uint8Array(instance.exports.memory.buffer, pointer, length);
      console.debug('[libghostty]', new TextDecoder().decode(bytes));
    } } };
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Unable to load libghostty: ${response.status}`);
    ({ instance } = await WebAssembly.instantiateStreaming(response, imports));
    return new GhosttyTerminal(instance.exports, cols, rows);
  }

  constructor(exports, cols, rows) {
    this.exports = exports;
    this.memory = exports.memory;
    this.decoder = new TextDecoder();
    this.cols = cols;
    this.rows = rows;
    this.layouts = this.#typeLayouts();
    this.handle = this.#newHandle('ghostty_terminal_new', (out) => {
      const layout = this.layouts.GhosttyTerminalOptions;
      return this.#withBytes(layout.size, (options) => {
        const view = this.#view();
        view.setUint16(options + layout.fields.cols.offset, cols, true);
        view.setUint16(options + layout.fields.rows.offset, rows, true);
        view.setUint32(options + layout.fields.max_scrollback.offset, 10000, true);
        return exports.ghostty_terminal_new(0, out, options);
      });
    });
    this.#setColor(11, [216, 222, 233]);
    this.#setColor(12, [11, 13, 17]);
    this.#setColor(13, [216, 222, 233]);
    this.renderState = this.#newHandle('ghostty_render_state_new', (out) => exports.ghostty_render_state_new(0, out));
    this.rowIterator = this.#newHandle('ghostty_render_state_row_iterator_new', (out) => exports.ghostty_render_state_row_iterator_new(0, out));
    this.rowCells = this.#newHandle('ghostty_render_state_row_cells_new', (out) => exports.ghostty_render_state_row_cells_new(0, out));
    this.keyEncoder = this.#newHandle('ghostty_key_encoder_new', (out) => exports.ghostty_key_encoder_new(0, out));
  }

  #typeLayouts() {
    const pointer = this.exports.ghostty_type_json();
    const bytes = new Uint8Array(this.memory.buffer, pointer);
    const end = bytes.indexOf(0);
    return JSON.parse(this.decoder.decode(bytes.subarray(0, end)));
  }

  #view() { return new DataView(this.memory.buffer); }

  #withBytes(length, callback) {
    const pointer = this.exports.ghostty_wasm_alloc_u8_array(length);
    if (!pointer) throw new Error(`libghostty allocation failed (${length} bytes)`);
    try { return callback(pointer); }
    finally { this.exports.ghostty_wasm_free_u8_array(pointer, length); }
  }

  #newHandle(name, create) {
    const pointer = this.exports.ghostty_wasm_alloc_opaque();
    if (!pointer) throw new Error(`${name}: allocation failed`);
    try {
      const result = create(pointer);
      if (result !== 0) throw new Error(`${name}: ${result}`);
      const handle = this.#view().getUint32(pointer, true);
      if (!handle) throw new Error(`${name}: empty handle`);
      return handle;
    } finally {
      this.exports.ghostty_wasm_free_opaque(pointer);
    }
  }

  #bind(call, handle) {
    return this.#withBytes(4, (pointer) => {
      this.#view().setUint32(pointer, handle, true);
      const result = call(pointer);
      if (result !== 0) throw new Error(`libghostty iterator bind: ${result}`);
    });
  }

  #get(call, size, read) {
    return this.#withBytes(size, (pointer) => {
      const result = call(pointer);
      return result === 0 ? read(this.#view(), pointer) : null;
    });
  }

  #rgb(call) {
    return this.#get(call, 3, (view, pointer) => [view.getUint8(pointer), view.getUint8(pointer + 1), view.getUint8(pointer + 2)]);
  }

  #setColor(option, color) {
    this.#withBytes(3, (pointer) => {
      new Uint8Array(this.memory.buffer, pointer, 3).set(color);
      const result = this.exports.ghostty_terminal_set(this.handle, option, pointer);
      if (result !== 0) throw new Error(`ghostty_terminal_set color: ${result}`);
    });
  }

  write(bytes) {
    this.#withBytes(bytes.length, (pointer) => {
      new Uint8Array(this.memory.buffer, pointer, bytes.length).set(bytes);
      this.exports.ghostty_terminal_vt_write(this.handle, pointer, bytes.length);
    });
  }

  resize(cols, rows, cellWidth, cellHeight) {
    if (cols === this.cols && rows === this.rows) return;
    const result = this.exports.ghostty_terminal_resize(this.handle, cols, rows, Math.round(cellWidth), Math.round(cellHeight));
    if (result !== 0) throw new Error(`ghostty_terminal_resize: ${result}`);
    this.cols = cols;
    this.rows = rows;
  }

  frame() {
    const result = this.exports.ghostty_render_state_update(this.renderState, this.handle);
    if (result !== 0) throw new Error(`ghostty_render_state_update: ${result}`);
    const background = this.#rgb((out) => this.exports.ghostty_render_state_get(this.renderState, RS.BG, out)) ?? [11, 13, 17];
    const foreground = this.#rgb((out) => this.exports.ghostty_render_state_get(this.renderState, RS.FG, out)) ?? [216, 222, 233];
    const cells = [];
    this.#bind((out) => this.exports.ghostty_render_state_get(this.renderState, RS.ROWS_ITERATOR, out), this.rowIterator);
    for (let y = 0; y < this.rows && this.exports.ghostty_render_state_row_iterator_next(this.rowIterator); y++) {
      this.#bind((out) => this.exports.ghostty_render_state_row_get(this.rowIterator, ROW.CELLS, out), this.rowCells);
      for (let x = 0; x < this.cols && this.exports.ghostty_render_state_row_cells_next(this.rowCells); x++) {
        cells.push(this.#cell(x, y, foreground, background));
      }
    }
    const cursor = {
      visible: this.#value(RS.CURSOR_VISIBLE, 1, 'u8') === 1 && this.#value(RS.CURSOR_HAS_VALUE, 1, 'u8') === 1,
      style: this.#value(RS.CURSOR_STYLE, 4, 'u32') ?? 1,
      x: this.#value(RS.CURSOR_X, 2, 'u16') ?? 0,
      y: this.#value(RS.CURSOR_Y, 2, 'u16') ?? 0,
    };
    return { cells, foreground, background, cursor };
  }

  #value(key, size, kind) {
    return this.#get((out) => this.exports.ghostty_render_state_get(this.renderState, key, out), size, (view, pointer) => {
      if (kind === 'u8') return view.getUint8(pointer);
      if (kind === 'u16') return view.getUint16(pointer, true);
      return view.getUint32(pointer, true);
    });
  }

  #cell(x, y, defaultFg, defaultBg) {
    const get = (key, out) => this.exports.ghostty_render_state_row_cells_get(this.rowCells, key, out);
    const count = this.#get((out) => get(CELL.GRAPHEMES_LEN, out), 4, (view, pointer) => view.getUint32(pointer, true)) ?? 0;
    let text = '';
    if (count > 0) {
      const bytes = Math.max(4, count * 4);
      text = this.#withBytes(bytes, (pointer) => {
        if (get(CELL.GRAPHEMES_BUF, pointer) !== 0) return '';
        const view = this.#view();
        const points = Array.from({ length: count }, (_, index) => view.getUint32(pointer + index * 4, true));
        return String.fromCodePoint(...points);
      });
    }
    const fg = this.#rgb((out) => get(CELL.FG, out)) ?? defaultFg;
    const bg = this.#rgb((out) => get(CELL.BG, out)) ?? defaultBg;
    const styled = this.#get((out) => get(CELL.HAS_STYLE, out), 1, (view, pointer) => view.getUint8(pointer)) === 1;
    const style = { bold: false, italic: false, faint: false, inverse: false, invisible: false, strike: false, underline: 0 };
    if (styled) {
      const layout = this.layouts.GhosttyStyle;
      this.#withBytes(layout.size, (pointer) => {
        const view = this.#view();
        view.setUint32(pointer + layout.fields.size.offset, layout.size, true);
        if (get(CELL.STYLE, pointer) !== 0) return;
        for (const field of ['bold', 'italic', 'faint', 'inverse', 'invisible']) style[field] = view.getUint8(pointer + layout.fields[field].offset) === 1;
        style.strike = view.getUint8(pointer + layout.fields.strikethrough.offset) === 1;
        style.underline = view.getInt32(pointer + layout.fields.underline.offset, true);
      });
    }
    const width = this.#withBytes(8, (raw) => {
      if (get(CELL.RAW, raw) !== 0) return 1;
      const value = this.#view().getBigUint64(raw, true);
      return this.#get((out) => this.exports.ghostty_cell_get(value, 3, out), 4, (view, pointer) => view.getUint32(pointer, true)) ?? 0;
    });
    return { x, y, text, fg, bg, style, width };
  }

  encodeKey(event) {
    const code = keyCode(event.code);
    if (code === 0 && event.key.length !== 1) return new Uint8Array();
    const eventHandle = this.#newHandle('ghostty_key_event_new', (out) => this.exports.ghostty_key_event_new(0, out));
    try {
      this.exports.ghostty_key_event_set_action(eventHandle, event.repeat ? 2 : 1);
      this.exports.ghostty_key_event_set_key(eventHandle, code);
      this.exports.ghostty_key_event_set_mods(eventHandle, (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0));
      if (event.key.length === 1) {
        const bytes = new TextEncoder().encode(event.key);
        this.#withBytes(bytes.length, (pointer) => {
          new Uint8Array(this.memory.buffer, pointer, bytes.length).set(bytes);
          this.exports.ghostty_key_event_set_utf8(eventHandle, pointer, bytes.length);
        });
      }
      this.exports.ghostty_key_encoder_setopt_from_terminal(this.keyEncoder, this.handle);
      return this.#withBytes(64, (buffer) => this.#withBytes(4, (written) => {
        const result = this.exports.ghostty_key_encoder_encode(this.keyEncoder, eventHandle, buffer, 64, written);
        if (result !== 0) return new Uint8Array();
        return new Uint8Array(this.memory.buffer, buffer, this.#view().getUint32(written, true)).slice();
      }));
    } finally {
      this.exports.ghostty_key_event_free(eventHandle);
    }
  }
}

function keyCode(code) {
  if (/^Key[A-Z]$/.test(code)) return 20 + code.charCodeAt(3) - 65;
  if (/^Digit[0-9]$/.test(code)) return 6 + Number(code.slice(5));
  const keys = { Backquote: 1, Backslash: 2, BracketLeft: 3, BracketRight: 4, Comma: 5, Equal: 16, Minus: 46, Period: 47, Quote: 48, Semicolon: 49, Slash: 50, Backspace: 53, Enter: 58, Space: 63, Tab: 64, Delete: 68, End: 69, Home: 71, Insert: 72, PageDown: 73, PageUp: 74, ArrowDown: 75, ArrowLeft: 76, ArrowRight: 77, ArrowUp: 78, Escape: 120 };
  if (/^F([1-9]|1[0-9]|2[0-5])$/.test(code)) return 120 + Number(code.slice(1));
  return keys[code] ?? 0;
}
