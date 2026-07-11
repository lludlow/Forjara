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
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	webassets "github.com/lludlow/forjara/web"
)

type Server struct {
	workspace string
	wasmPath  string
	assets    http.Handler
	registry  *Registry
	mu        sync.Mutex
	listeners map[chan struct{}]struct{}
}

func New(workspace, wasmPath, stateDir string) (*Server, error) {
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return nil, fmt.Errorf("workspace: %w", err)
	}
	assets, err := fs.Sub(webassets.Assets, ".")
	if err != nil {
		return nil, err
	}
	registry, err := NewRegistry(root, stateDir)
	if err != nil {
		return nil, err
	}
	return &Server{workspace: root, wasmPath: wasmPath, assets: http.FileServer(http.FS(assets)), registry: registry, listeners: map[chan struct{}]struct{}{}}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	})
	mux.HandleFunc("GET /api/state", s.state)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("POST /api/sessions", s.createSession)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.deleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/restart", s.restartSession)
	mux.HandleFunc("GET /api/sessions/{id}/terminal", s.terminal)
	mux.HandleFunc("GET /ghostty-vt.wasm", s.wasm)
	mux.Handle("/", s.assets)
	return mux
}

func (s *Server) state(w http.ResponseWriter, _ *http.Request) {
	projects, err := s.registry.Projects()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects, "sessions": s.registry.Sessions()})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var input CreateSession
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input); err != nil {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}
	session, err := s.registry.Create(input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.notify()
	writeJSON(w, http.StatusCreated, session)
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	if err := s.registry.Delete(r.PathValue("id")); err != nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	s.notify()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) restartSession(w http.ResponseWriter, r *http.Request) {
	session, err := s.registry.Restart(r.PathValue("id"))
	if err != nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	s.notify()
	writeJSON(w, http.StatusOK, session)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	listener := make(chan struct{}, 1)
	s.mu.Lock()
	s.listeners[listener] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.listeners, listener)
		s.mu.Unlock()
	}()
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-listener:
			_, _ = io.WriteString(w, "event: state\ndata: {}\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) Signal(session, activity string) error {
	if err := s.registry.UpdateActivity(session, activity); err != nil {
		return err
	}
	s.notify()
	return nil
}

func (s *Server) notify() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for listener := range s.listeners {
		select {
		case listener <- struct{}{}:
		default:
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
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
	session, ok := s.registry.Session(r.PathValue("id"))
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if err := startSession(session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)

	cmd := exec.CommandContext(r.Context(), "tmux", "attach-session", "-t", session.Tmux)
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

func ListenAddress() string {
	port := 8080
	if value := os.Getenv("FORJARA_WEB_PORT"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 && parsed < 65536 {
			port = parsed
		}
	}
	return fmt.Sprintf("0.0.0.0:%d", port)
}
