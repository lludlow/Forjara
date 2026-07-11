package web

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProjectsSupportsRepositoryAndCollectionMounts(t *testing.T) {
	repository := t.TempDir()
	if err := exec.Command("git", "-C", repository, "init", "-q").Run(); err != nil {
		t.Fatal(err)
	}
	registry, err := NewRegistry(repository, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	projects, err := registry.Projects()
	if err != nil || len(projects) != 1 || !projects[0].Git {
		t.Fatalf("repository projects = %#v, %v", projects, err)
	}

	collection := t.TempDir()
	if err := os.Mkdir(filepath.Join(collection, "plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(collection, "repo"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("git", "-C", filepath.Join(collection, "repo"), "init", "-q").Run(); err != nil {
		t.Fatal(err)
	}
	registry, _ = NewRegistry(collection, t.TempDir())
	projects, err = registry.Projects()
	if err != nil || len(projects) != 2 || projects[0].Name != "plain" || projects[0].Git || !projects[1].Git {
		t.Fatalf("collection projects = %#v, %v", projects, err)
	}
}

func TestRegistryPersistsDefinitionsAsStopped(t *testing.T) {
	state := t.TempDir()
	registry, err := NewRegistry(t.TempDir(), state)
	if err != nil {
		t.Fatal(err)
	}
	registry.sessions["one"] = Session{ID: "one", Name: "Agent", Tmux: "missing", CreatedAt: time.Now()}
	if err := registry.saveLocked(); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewRegistry(registry.workspace, state)
	if err != nil {
		t.Fatal(err)
	}
	session, ok := reloaded.Session("one")
	if !ok || session.Status != "stopped" {
		t.Fatalf("reloaded session = %#v, %v", session, ok)
	}
}

func TestSafePathRejectsEscape(t *testing.T) {
	registry, _ := NewRegistry(t.TempDir(), t.TempDir())
	if _, err := registry.safePath(t.TempDir()); err == nil {
		t.Fatal("expected path outside workspace to be rejected")
	}
}

func TestSlug(t *testing.T) {
	if got := slug(" Fix API / Tests "); got != "fix-api-tests" {
		t.Fatalf("slug = %q", got)
	}
	if got := slug("🤷"); got != "session" {
		t.Fatalf("empty slug fallback = %q", got)
	}
}

func TestProjectNameUsesRemote(t *testing.T) {
	repository := t.TempDir()
	if err := exec.Command("git", "-C", repository, "init", "-q").Run(); err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("git", "-C", repository, "remote", "add", "origin", "git@github.com:example/project.git").Run(); err != nil {
		t.Fatal(err)
	}
	if got := projectName(repository); got != "project" {
		t.Fatalf("projectName = %q", got)
	}
}
