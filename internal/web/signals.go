package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

type signalMessage struct {
	Session  string `json:"session"`
	Activity string `json:"activity"`
	Error    string `json:"error,omitempty"`
}

func ServeSignals(path string, update func(string, string) error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return err
	}
	for {
		connection, err := listener.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
			var message signalMessage
			if err := json.NewDecoder(connection).Decode(&message); err == nil {
				if err := update(message.Session, message.Activity); err != nil {
					message.Error = err.Error()
				}
			} else {
				message.Error = "invalid signal"
			}
			_ = json.NewEncoder(connection).Encode(message)
		}()
	}
}

func SendSignal(path, session, activity string) error {
	if path == "" || session == "" {
		return errors.New("FORJARA_EVENT_SOCKET and FORJARA_SESSION_ID are required")
	}
	connection, err := net.DialTimeout("unix", path, 3*time.Second)
	if err != nil {
		return err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if err := json.NewEncoder(connection).Encode(signalMessage{Session: session, Activity: activity}); err != nil {
		return err
	}
	var response signalMessage
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return err
	}
	if response.Error != "" {
		return fmt.Errorf("signal: %s", response.Error)
	}
	return nil
}
