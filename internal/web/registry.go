package web

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Project struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Git  bool   `json:"git"`
}

type Session struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Project   string    `json:"project"`
	CWD       string    `json:"cwd"`
	Worktree  string    `json:"worktree,omitempty"`
	Branch    string    `json:"branch,omitempty"`
	Agent     string    `json:"agent,omitempty"`
	Tmux      string    `json:"tmux"`
	Status    string    `json:"status"`
	Activity  string    `json:"activity,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type CreateSession struct {
	Name        string `json:"name"`
	Project     string `json:"project"`
	Agent       string `json:"agent"`
	NewWorktree bool   `json:"newWorktree"`
	Branch      string `json:"branch"`
}

type Registry struct {
	mu        sync.Mutex
	workspace string
	path      string
	sessions  map[string]Session
}

func NewRegistry(workspace, stateDir string) (*Registry, error) {
	if stateDir == "" {
		stateDir = filepath.Join(os.TempDir(), "forjara")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	r := &Registry{workspace: workspace, path: filepath.Join(stateDir, "sessions.json"), sessions: map[string]Session{}}
	data, err := os.ReadFile(r.path)
	if err == nil {
		var sessions []Session
		if err := json.Unmarshal(data, &sessions); err != nil {
			return nil, fmt.Errorf("read sessions: %w", err)
		}
		for _, session := range sessions {
			session.Status = "stopped"
			r.sessions[session.ID] = session
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return r, nil
}

func (r *Registry) Projects() ([]Project, error) {
	if isGit(r.workspace) {
		return []Project{{Name: filepath.Base(r.workspace), Path: r.workspace, Git: true}}, nil
	}
	entries, err := os.ReadDir(r.workspace)
	if err != nil {
		return nil, err
	}
	projects := make([]Project, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		path := filepath.Join(r.workspace, entry.Name())
		projects = append(projects, Project{Name: entry.Name(), Path: path, Git: isGit(path)})
	}
	sort.Slice(projects, func(i, j int) bool { return strings.ToLower(projects[i].Name) < strings.ToLower(projects[j].Name) })
	if len(projects) == 0 {
		projects = append(projects, Project{Name: filepath.Base(r.workspace), Path: r.workspace})
	}
	return projects, nil
}

func (r *Registry) Sessions() []Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	sessions := make([]Session, 0, len(r.sessions))
	for id, session := range r.sessions {
		if exec.Command("tmux", "has-session", "-t", session.Tmux).Run() == nil {
			session.Status = "running"
		} else {
			session.Status = "stopped"
		}
		r.sessions[id] = session
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].CreatedAt.Before(sessions[j].CreatedAt) })
	return sessions
}

func (r *Registry) Session(id string) (Session, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[id]
	return session, ok
}

func (r *Registry) Create(input CreateSession) (Session, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" || len(name) > 80 {
		return Session{}, errors.New("session name must be between 1 and 80 characters")
	}
	project, err := r.safePath(input.Project)
	if err != nil {
		return Session{}, err
	}
	info, err := os.Stat(project)
	if err != nil || !info.IsDir() {
		return Session{}, errors.New("project directory does not exist")
	}
	agent := strings.TrimSpace(input.Agent)
	if agent != "" && agent != "shell" && !allowedAgent(agent) {
		return Session{}, errors.New("unknown agent")
	}

	id, err := randomID()
	if err != nil {
		return Session{}, err
	}
	session := Session{ID: id, Name: name, Project: project, CWD: project, Agent: agent, Tmux: "forjara-" + id, Status: "running", CreatedAt: time.Now().UTC()}
	if input.NewWorktree {
		if !isGit(project) {
			return Session{}, errors.New("worktrees require a Git project")
		}
		branch := strings.TrimSpace(input.Branch)
		if branch == "" {
			branch = "forjara/" + slug(name)
		}
		if exec.Command("git", "check-ref-format", "--branch", branch).Run() != nil {
			return Session{}, errors.New("invalid branch name")
		}
		worktree := filepath.Join(project, ".forjara", "worktrees", slug(name)+"-"+id[:6])
		if err := excludeForjara(project); err != nil {
			return Session{}, err
		}
		if output, err := exec.Command("git", "-C", project, "worktree", "add", "-b", branch, worktree).CombinedOutput(); err != nil {
			return Session{}, fmt.Errorf("create worktree: %s", strings.TrimSpace(string(output)))
		}
		session.CWD, session.Worktree, session.Branch = worktree, worktree, branch
	}
	if err := startSession(session); err != nil {
		if session.Worktree != "" {
			_ = exec.Command("git", "-C", project, "worktree", "remove", session.Worktree).Run()
		}
		return Session{}, err
	}

	r.mu.Lock()
	r.sessions[id] = session
	err = r.saveLocked()
	r.mu.Unlock()
	return session, err
}

func (r *Registry) Restart(id string) (Session, error) {
	r.mu.Lock()
	session, ok := r.sessions[id]
	r.mu.Unlock()
	if !ok {
		return Session{}, os.ErrNotExist
	}
	if err := startSession(session); err != nil {
		return Session{}, err
	}
	session.Status = "running"
	return session, nil
}

func (r *Registry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[id]
	if !ok {
		return os.ErrNotExist
	}
	_ = exec.Command("tmux", "kill-session", "-t", session.Tmux).Run()
	delete(r.sessions, id)
	return r.saveLocked()
}

func (r *Registry) UpdateActivity(id, activity string) error {
	switch activity {
	case "started", "busy", "awaiting_input", "idle", "stopped", "notification":
	default:
		return errors.New("invalid activity")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[id]
	if !ok {
		return os.ErrNotExist
	}
	session.Activity = activity
	r.sessions[id] = session
	return r.saveLocked()
}

func (r *Registry) safePath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New("invalid project path")
	}
	relative, err := filepath.Rel(r.workspace, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("project must be beneath the workspace")
	}
	return resolved, nil
}

func (r *Registry) saveLocked() error {
	sessions := make([]Session, 0, len(r.sessions))
	for _, session := range r.sessions {
		session.Status = ""
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].CreatedAt.Before(sessions[j].CreatedAt) })
	data, err := json.MarshalIndent(sessions, "", "  ")
	if err != nil {
		return err
	}
	temporary := r.path + ".tmp"
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, r.path)
}

func startSession(session Session) error {
	if exec.Command("tmux", "has-session", "-t", session.Tmux).Run() == nil {
		return nil
	}
	arguments := []string{"new-session", "-d", "-s", session.Tmux, "-c", session.CWD, "-e", "FORJARA_SESSION_ID=" + session.ID}
	if socket := os.Getenv("FORJARA_EVENT_SOCKET"); socket != "" {
		arguments = append(arguments, "-e", "FORJARA_EVENT_SOCKET="+socket)
	}
	command := exec.Command("tmux", arguments...)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("start session: %s", strings.TrimSpace(string(output)))
	}
	if allowedAgent(session.Agent) {
		launch := "forjara-web signal started; " + session.Agent + "; forjara-web signal stopped"
		if output, err := exec.Command("tmux", "send-keys", "-t", session.Tmux, launch, "Enter").CombinedOutput(); err != nil {
			return fmt.Errorf("launch agent: %s", strings.TrimSpace(string(output)))
		}
	}
	return nil
}

func allowedAgent(agent string) bool {
	switch agent {
	case "claude", "codex", "agy", "opencode":
		return true
	default:
		return false
	}
}

func isGit(path string) bool {
	return exec.Command("git", "-C", path, "rev-parse", "--is-inside-work-tree").Run() == nil
}

func randomID() (string, error) {
	data := make([]byte, 12)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func slug(value string) string {
	var result strings.Builder
	for _, character := range strings.ToLower(value) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			result.WriteRune(character)
		} else if result.Len() > 0 && !strings.HasSuffix(result.String(), "-") {
			result.WriteByte('-')
		}
	}
	value = strings.Trim(result.String(), "-")
	if value == "" {
		return "session"
	}
	return value
}

func excludeForjara(project string) error {
	gitDir, err := exec.Command("git", "-C", project, "rev-parse", "--git-dir").Output()
	if err != nil {
		return err
	}
	directory := strings.TrimSpace(string(gitDir))
	if !filepath.IsAbs(directory) {
		directory = filepath.Join(project, directory)
	}
	path := filepath.Join(directory, "info", "exclude")
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), ".forjara/") {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = fmt.Fprintln(file, ".forjara/")
	return err
}
