package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	webassets "github.com/lludlow/forjara/web"
)

type Server struct {
	workspace string
	wasmPath  string
	assets    http.Handler
}

func New(workspace, wasmPath string) (*Server, error) {
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return nil, fmt.Errorf("workspace: %w", err)
	}
	assets, err := fs.Sub(webassets.Assets, ".")
	if err != nil {
		return nil, err
	}
	return &Server{workspace: root, wasmPath: wasmPath, assets: http.FileServer(http.FS(assets))}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	})
	mux.HandleFunc("GET /api/terminal", s.terminal)
	mux.HandleFunc("GET /ghostty-vt.wasm", s.wasm)
	mux.Handle("/", s.assets)
	return mux
}

func (s *Server) wasm(w http.ResponseWriter, r *http.Request) {
	if s.wasmPath == "" {
		http.Error(w, "ghostty-vt.wasm is not configured", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/wasm")
	http.ServeFile(w, r, s.wasmPath)
}

type control struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func (s *Server) terminal(w http.ResponseWriter, r *http.Request) {
	if err := ensureSession(r.Context(), "forjara-main", s.workspace); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)

	cmd := exec.CommandContext(r.Context(), "tmux", "attach-session", "-t", "forjara-main")
	terminal, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 40})
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "PTY unavailable")
		return
	}
	defer terminal.Close()

	errCh := make(chan error, 2)
	go func() {
		buffer := make([]byte, 32<<10)
		for {
			n, readErr := terminal.Read(buffer)
			if n > 0 {
				ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
				writeErr := conn.Write(ctx, websocket.MessageBinary, buffer[:n])
				cancel()
				if writeErr != nil {
					errCh <- writeErr
					return
				}
			}
			if readErr != nil {
				errCh <- readErr
				return
			}
		}
	}()
	go func() {
		for {
			kind, data, readErr := conn.Read(r.Context())
			if readErr != nil {
				errCh <- readErr
				return
			}
			if kind == websocket.MessageBinary {
				_, readErr = terminal.Write(data)
			} else {
				readErr = resize(terminal, data)
			}
			if readErr != nil {
				errCh <- readErr
				return
			}
		}
	}()

	if err := <-errCh; err != nil && !errors.Is(err, io.EOF) {
		log.Printf("terminal disconnected: %v", err)
	}
}

func resize(terminal *os.File, data []byte) error {
	var message control
	if err := json.Unmarshal(data, &message); err != nil || message.Type != "resize" {
		return nil
	}
	message.Cols = clamp(message.Cols, 2, 500)
	message.Rows = clamp(message.Rows, 1, 500)
	return pty.Setsize(terminal, &pty.Winsize{Cols: uint16(message.Cols), Rows: uint16(message.Rows)})
}

func clamp(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func ensureSession(ctx context.Context, name, cwd string) error {
	if exec.CommandContext(ctx, "tmux", "has-session", "-t", name).Run() == nil {
		return nil
	}
	command := exec.CommandContext(ctx, "tmux", "new-session", "-d", "-s", name, "-c", cwd)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("start tmux: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func ListenAddress() string {
	port := 8080
	if value := os.Getenv("FORJARA_WEB_PORT"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 && parsed < 65536 {
			port = parsed
		}
	}
	return fmt.Sprintf("0.0.0.0:%d", port)
}
