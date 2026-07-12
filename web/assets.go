package web

import "embed"

// Assets contains the browser application bundled into forjara-web.
//
//go:embed index.html app.css app.js ghostty.js terminal.js
var Assets embed.FS
