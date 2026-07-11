package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	forjaraweb "github.com/lludlow/forjara/internal/web"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "signal" {
		if len(os.Args) != 3 {
			log.Fatal("usage: forjara-web signal <busy|awaiting_input|idle|notification>")
		}
		if err := forjaraweb.SendSignal(os.Getenv("FORJARA_EVENT_SOCKET"), os.Getenv("FORJARA_SESSION_ID"), os.Args[2]); err != nil {
			log.Fatal(err)
		}
		return
	}
	workspace := first(os.Getenv("FORJARA_WORKSPACE"), "/workspace")
	stateDir := first(os.Getenv("FORJARA_STATE_DIR"), first(os.Getenv("HOME"), "/config")+"/.local/state/forjara")
	socket := first(os.Getenv("FORJARA_EVENT_SOCKET"), stateDir+"/events.sock")
	if os.Getenv("FORJARA_EVENT_SOCKET") == "" {
		if err := os.Setenv("FORJARA_EVENT_SOCKET", socket); err != nil {
			log.Fatal(err)
		}
	}
	server, err := forjaraweb.New(workspace, os.Getenv("FORJARA_GHOSTTY_WASM"), stateDir)
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		if err := forjaraweb.ServeSignals(socket, server.Signal); err != nil {
			log.Fatal(fmt.Errorf("signal socket: %w", err))
		}
	}()
	address := forjaraweb.ListenAddress()
	log.Printf("Forjara web listening on %s", address)
	log.Fatal(http.ListenAndServe(address, server.Handler()))
}

func first(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
