package host

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------- UDP telemetry (for Wi-Fi radios such as ESP32 boards) ----

type udpListener struct {
	mu   sync.Mutex
	conn *net.UDPConn
	port int
	last *net.UDPAddr
	rx   int64
}

// EnableUDP adds /api/udp/{start,stop,status,send}. Received datagrams are
// split into lines and published to the window as "udp" events.
func (h *Host) EnableUDP(mux *http.ServeMux) {
	u := &udpListener{}
	mux.HandleFunc("/api/udp/start", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Port int `json:"port"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Port <= 0 || req.Port > 65535 {
			http.Error(w, "port must be 1-65535", 400)
			return
		}
		u.mu.Lock()
		if u.conn != nil {
			u.conn.Close()
			u.conn = nil
		}
		conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: req.Port})
		if err != nil {
			u.mu.Unlock()
			http.Error(w, "could not listen on UDP port "+strconv.Itoa(req.Port)+": "+err.Error(), 409)
			return
		}
		u.conn, u.port, u.rx = conn, req.Port, 0
		u.mu.Unlock()
		go func() {
			buf := make([]byte, 65536)
			var partial string
			for {
				n, addr, err := conn.ReadFromUDP(buf)
				if err != nil {
					return
				}
				u.mu.Lock()
				u.last = addr
				u.rx += int64(n)
				u.mu.Unlock()
				text := partial + string(buf[:n])
				parts := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
				partial = ""
				lines := make([]string, 0, len(parts))
				for i, p := range parts {
					if i == len(parts)-1 && !strings.HasSuffix(text, "\n") && len(parts) > 1 {
						partial = p
						continue
					}
					p = strings.TrimRight(p, "\r")
					if p != "" {
						lines = append(lines, p)
					}
				}
				if len(partial) > 4096 {
					partial = ""
				}
				if len(lines) > 0 {
					h.Publish("udp", map[string]any{"lines": lines, "from": addr.String(), "t": time.Now().UnixMilli()})
				}
			}
		}()
		writeJSON(w, map[string]any{"ok": true, "port": req.Port})
	})
	mux.HandleFunc("/api/udp/stop", func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		if u.conn != nil {
			u.conn.Close()
			u.conn = nil
		}
		u.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/udp/status", func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		defer u.mu.Unlock()
		last := ""
		if u.last != nil {
			last = u.last.String()
		}
		addrs := []string{}
		if list, err := net.InterfaceAddrs(); err == nil {
			for _, a := range list {
				if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil && !ipn.IP.IsLinkLocalUnicast() {
					addrs = append(addrs, ipn.IP.String())
				}
			}
		}
		writeJSON(w, map[string]any{"listening": u.conn != nil, "port": u.port, "bytes": u.rx, "lastSender": last, "addresses": addrs})
	})
	mux.HandleFunc("/api/udp/send", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text string `json:"text"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		u.mu.Lock()
		conn, last := u.conn, u.last
		u.mu.Unlock()
		if conn == nil || last == nil {
			http.Error(w, "nothing has sent UDP data yet, so there is no address to reply to", 409)
			return
		}
		if _, err := conn.WriteToUDP([]byte(req.Text), last); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
}

// ---------------- Map and elevation tiles with a local cache --------------

// tileSource is one kind of tile: where it comes from and how long it stays fresh.
type tileSource struct {
	dir, url, agent string
	maxZoom         int
	keep            time.Duration // 0 = keep forever (the ground doesn't move)
}

var tileSources = map[string]tileSource{
	// OpenStreetMap map pictures
	"tiles": {dir: "tiles", url: "https://tile.openstreetmap.org/%d/%d/%d.png", maxZoom: 19, keep: 30 * 24 * time.Hour},
	// Ground height as colours (Terrarium encoding, free AWS open data):
	// metres = R*256 + G + B/256 - 32768
	"elev": {dir: "elev", url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png", maxZoom: 15},
}

// EnableTiles serves /tiles/{z}/{x}/{y}.png (map) and /elev/{z}/{x}/{y}.png
// (elevation), keeping every tile fetched so maps and 3D terrain still work at
// a field with no internet. All three apps share the same cache folder.
func (h *Host) EnableTiles(mux *http.ServeMux) {
	sem := make(chan struct{}, 2) // OSM asks clients to keep connections low
	client := &http.Client{Timeout: 15 * time.Second}

	// fetch returns a tile from the cache or the network; src is "cache", "network" or "stale".
	fetch := func(kind string, z, x, y int, network bool) ([]byte, string, error) {
		ts := tileSources[kind]
		p := filepath.Join(h.CacheDir, ts.dir, strconv.Itoa(z), strconv.Itoa(x), strconv.Itoa(y)+".png")
		st, statErr := os.Stat(p)
		if statErr == nil && (ts.keep == 0 || time.Since(st.ModTime()) < ts.keep) {
			data, err := os.ReadFile(p)
			return data, "cache", err
		}
		if network {
			sem <- struct{}{}
			data, err := func() ([]byte, error) {
				defer func() { <-sem }()
				req, _ := http.NewRequest("GET", fmt.Sprintf(ts.url, z, x, y), nil)
				req.Header.Set("User-Agent", "Aviary/"+Version+" (personal model rocketry ground station)")
				resp, err := client.Do(req)
				if err != nil {
					return nil, err
				}
				defer resp.Body.Close()
				if resp.StatusCode != 200 {
					return nil, fmt.Errorf("tile server: %s", resp.Status)
				}
				return io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			}()
			if err == nil {
				os.MkdirAll(filepath.Dir(p), 0o755)
				os.WriteFile(p, data, 0o644)
				return data, "network", nil
			}
			if statErr != nil {
				return nil, "", err
			}
		}
		if statErr == nil { // stale copy beats nothing
			data, err := os.ReadFile(p)
			return data, "stale", err
		}
		return nil, "", fmt.Errorf("not saved for offline use")
	}

	parse := func(kind, path string) (z, x, y int, ok bool) {
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(path, "/"+kind+"/"), ".png"), "/")
		if len(parts) != 3 {
			return
		}
		var e1, e2, e3 error
		z, e1 = strconv.Atoi(parts[0])
		x, e2 = strconv.Atoi(parts[1])
		y, e3 = strconv.Atoi(parts[2])
		ok = e1 == nil && e2 == nil && e3 == nil && z >= 0 && z <= tileSources[kind].maxZoom && x >= 0 && y >= 0 && x < 1<<z && y < 1<<z
		return
	}
	for _, kind := range []string{"tiles", "elev"} {
		kind := kind
		mux.HandleFunc("/"+kind+"/", func(w http.ResponseWriter, r *http.Request) {
			z, x, y, ok := parse(kind, r.URL.Path)
			if !ok {
				http.NotFound(w, r)
				return
			}
			data, src, err := fetch(kind, z, x, y, true)
			if err != nil {
				log.Printf("%s %d/%d/%d: %v", kind, z, x, y, err)
				http.Error(w, "tile unavailable offline", 404)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("X-Tile-Source", src)
			w.Write(data)
		})
	}

	// Save an area for offline use: map tiles and elevation around a point.
	// Runs in the background; /api/tiles/prefetch (GET) reports progress.
	var pmu sync.Mutex
	prog := map[string]any{"running": false, "done": 0, "total": 0, "failed": 0}
	mux.HandleFunc("/api/tiles/prefetch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			pmu.Lock()
			defer pmu.Unlock()
			writeJSON(w, prog)
			return
		}
		var q struct {
			Lat, Lon, Radius float64
			MapZoom          int `json:"mapZoom"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&q); err != nil || q.Lat < -85 || q.Lat > 85 || q.Lon < -180 || q.Lon > 180 {
			http.Error(w, "need lat and lon", 400)
			return
		}
		if q.Radius <= 0 || q.Radius > 8000 {
			q.Radius = 3000
		}
		if q.MapZoom < 12 || q.MapZoom > 17 {
			q.MapZoom = 16
		}
		type job struct {
			kind    string
			z, x, y int
		}
		var jobs []job
		add := func(kind string, z0, z1 int) {
			for z := z0; z <= z1; z++ {
				x0, y0 := lonLatToTile(q.Lon-q.Radius/(111320*math.Cos(q.Lat*math.Pi/180)), q.Lat+q.Radius/111320, z)
				x1, y1 := lonLatToTile(q.Lon+q.Radius/(111320*math.Cos(q.Lat*math.Pi/180)), q.Lat-q.Radius/111320, z)
				for x := x0; x <= x1; x++ {
					for y := y0; y <= y1; y++ {
						jobs = append(jobs, job{kind, z, x, y})
					}
				}
			}
		}
		add("elev", 10, 14)
		add("tiles", 12, q.MapZoom)
		if len(jobs) > 1500 {
			http.Error(w, "that area is too big to save", 400)
			return
		}
		pmu.Lock()
		if prog["running"] == true {
			pmu.Unlock()
			http.Error(w, "already saving an area", 409)
			return
		}
		prog = map[string]any{"running": true, "done": 0, "total": len(jobs), "failed": 0}
		pmu.Unlock()
		go func() {
			done, failed := 0, 0
			for _, j := range jobs {
				if _, _, err := fetch(j.kind, j.z, j.x, j.y, true); err != nil {
					failed++
				}
				done++
				pmu.Lock()
				prog["done"], prog["failed"] = done, failed
				pmu.Unlock()
			}
			pmu.Lock()
			prog["running"] = false
			pmu.Unlock()
		}()
		writeJSON(w, map[string]any{"total": len(jobs)})
	})

	mux.HandleFunc("/api/tiles/stats", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{}
		for kind, ts := range tileSources {
			var n, size int64
			filepath.Walk(filepath.Join(h.CacheDir, ts.dir), func(_ string, info os.FileInfo, err error) error {
				if err == nil && !info.IsDir() {
					n++
					size += info.Size()
				}
				return nil
			})
			out[kind] = n
			out[kind+"Bytes"] = size
		}
		out["bytes"] = out["tilesBytes"]
		writeJSON(w, out)
	})
}

func lonLatToTile(lon, lat float64, z int) (int, int) {
	n := math.Exp2(float64(z))
	x := int((lon + 180) / 360 * n)
	lr := lat * math.Pi / 180
	y := int((1 - math.Log(math.Tan(lr)+1/math.Cos(lr))/math.Pi) / 2 * n)
	clampi := func(v int) int {
		if v < 0 {
			return 0
		}
		if v >= int(n) {
			return int(n) - 1
		}
		return v
	}
	return clampi(x), clampi(y)
}
