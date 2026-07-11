package main

import (
	"log"
	"net/http"
	"os"

	forjaraweb "github.com/lludlow/forjara/internal/web"
)

func main() {
	workspace := first(os.Getenv("FORJARA_WORKSPACE"), "/workspace")
	stateDir := first(os.Getenv("FORJARA_STATE_DIR"), first(os.Getenv("HOME"), "/config")+"/.local/state/forjara")
	server, err := forjaraweb.New(workspace, os.Getenv("FORJARA_GHOSTTY_WASM"), stateDir)
	if err != nil {
		log.Fatal(err)
	}
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
