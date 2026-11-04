// Owl: a ground station for any rocket's telemetry.
package main

import (
	"io/fs"
	"net/http"

	"aviary/host"
	"aviary/web"
)

func main() {
	host.Run(host.Config{
		AppID: "owl", Name: "Owl", Port: 47710, Assets: web.FS, Width: 1480, Height: 940,
		Setup: func(mux *http.ServeMux, h *host.Host) {
			h.EnableUDP(mux)
			h.EnableTiles(mux)
			// the phone companion's web app, served to phones only while sharing is on
			app, _ := fs.Sub(web.FS, "companion")
			h.EnableCompanion(mux, app)
		},
	})
}
