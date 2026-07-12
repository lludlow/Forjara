package web

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSignalRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.sock")
	received := make(chan signalMessage, 1)
	go func() {
		_ = ServeSignals(path, func(session, activity string) error {
			received <- signalMessage{Session: session, Activity: activity}
			return nil
		})
	}()
	deadline := time.Now().Add(time.Second)
	for {
		if err := SendSignal(path, "session-1", "busy"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("signal socket did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := <-received; got.Session != "session-1" || got.Activity != "busy" {
		t.Fatalf("signal = %#v", got)
	}
}
