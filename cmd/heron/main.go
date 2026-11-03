// Heron: a flight data analyzer for any rocket's logs.
package main

import (
	"net/http"

	"aviary/host"
	"aviary/web"
)

func main() {
	host.Run(host.Config{
		AppID: "heron", Name: "Heron", Port: 47720, Assets: web.FS, Width: 1480, Height: 940,
		// map and elevation tiles for the 3D view, shared with Owl's cache
		Setup: func(mux *http.ServeMux, h *host.Host) { h.EnableTiles(mux) },
	})
}
