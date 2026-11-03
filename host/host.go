// Package host runs one Aviary app: a small local web server that serves the
// app's interface and opens it in its own window (Edge app mode on Windows).
// It also provides storage for settings, shared rocket profiles and files
// (recordings, runs, flight library), plus a live event stream.
package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Version is set at build time with -ldflags "-X aviary/host.Version=..."
var Version = "dev"

// Config describes one app.
type Config struct {
	AppID  string // "owl", "heron", "mockingbird"
	Name   string // "Owl"
	Port   int    // preferred localhost port; fixed so browser permissions persist
	Assets fs.FS  // contains shared/ and <AppID>/ directories
	Width  int
	Height int
	// Setup lets an app add its own routes.
	Setup func(mux *http.ServeMux, h *Host)
}

// Host is a running app instance.
type Host struct {
	cfg      Config
	DataDir  string // settings and shared profiles (%APPDATA%\Aviary)
	DocsDir  string // user-facing files (Documents\Aviary)
	CacheDir string // map tiles, logs (%LOCALAPPDATA%\Aviary)
	port     int

	mu       sync.Mutex
	subs     map[chan sseMsg]struct{}
	clients  int
	everSeen bool
	idleT    *time.Timer
	srv      *http.Server
	fileMu   sync.Mutex
}

type sseMsg struct {
	event string
	data  []byte
}

// Areas are the folders under Documents\Aviary that apps may read and write.
var Areas = map[string]string{
	"owl":         "Owl Recordings",
	"mockingbird": "Mockingbird Runs",
	"heron":       "Heron Library",
	"motors":      "Motors",
}

// Run starts the app and blocks until it exits.
func Run(cfg Config) {
	h := &Host{cfg: cfg, subs: map[chan sseMsg]struct{}{}}
	h.initDirs()
	h.initLog()
	log.Printf("%s %s starting", cfg.Name, Version)

	ln, port, existing := h.listen()
	if existing != "" {
		// Another copy is already running: just show its window.
		log.Printf("already running at %s", existing)
		if os.Getenv("AVIARY_NO_BROWSER") == "" {
			openAppWindow(existing, cfg.Width, cfg.Height)
		}
		return
	}
	if ln == nil {
		messageBox(cfg.Name, "Could not start: no free local port was found near "+strconv.Itoa(cfg.Port)+".")
		os.Exit(1)
	}
	h.port = port
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	log.Printf("serving at %s", url)
	fmt.Println(url)

	mux := http.NewServeMux()
	h.routes(mux)
	if cfg.Setup != nil {
		cfg.Setup(mux, h)
	}
	h.srv = &http.Server{Handler: h.guard(mux), ReadHeaderTimeout: 10 * time.Second}

	// If no window ever connects (browser failed to open), don't linger forever.
	go func() {
		time.Sleep(120 * time.Second)
		h.mu.Lock()
		seen := h.everSeen
		h.mu.Unlock()
		if !seen && os.Getenv("AVIARY_STAY") == "" {
			log.Printf("no window connected; exiting")
			h.Shutdown()
		}
	}()

	if os.Getenv("AVIARY_NO_BROWSER") == "" {
		go func() {
			time.Sleep(150 * time.Millisecond)
			if err := openAppWindow(url, cfg.Width, cfg.Height); err != nil {
				log.Printf("open window: %v", err)
				messageBox(cfg.Name, "Open this address in Microsoft Edge or Google Chrome:\n\n"+url)
			}
		}()
	}

	if err := h.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("server: %v", err)
	}
	log.Printf("%s exited", cfg.Name)
}

// Shutdown stops the server; Run returns afterwards.
func (h *Host) Shutdown() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if h.srv != nil {
			h.srv.Shutdown(ctx)
		}
	}()
}

func (h *Host) listen() (net.Listener, int, string) {
	if p := os.Getenv("AVIARY_PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			h.cfg.Port = n
		}
	}
	for i := 0; i < 20; i++ {
		port := h.cfg.Port + i
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			return ln, port, ""
		}
		// Is it us?
		url := fmt.Sprintf("http://127.0.0.1:%d/", port)
		c := http.Client{Timeout: 800 * time.Millisecond}
		if resp, err := c.Get(url + "api/info"); err == nil {
			var info map[string]any
			json.NewDecoder(resp.Body).Decode(&info)
			resp.Body.Close()
			if info["app"] == h.cfg.AppID {
				return nil, 0, url
			}
		}
	}
	return nil, 0, ""
}

func (h *Host) initDirs() {
	base := os.Getenv("AVIARY_HOME")
	if base != "" {
		h.DataDir = filepath.Join(base, "data")
		h.DocsDir = filepath.Join(base, "Documents", "Aviary")
		h.CacheDir = filepath.Join(base, "cache")
	} else {
		cfg, err := os.UserConfigDir()
		if err != nil {
			cfg = os.TempDir()
		}
		h.DataDir = filepath.Join(cfg, "Aviary")
		h.DocsDir = filepath.Join(documentsDir(), "Aviary")
		h.CacheDir = filepath.Join(localCacheDir(), "Aviary")
	}
	for _, d := range []string{h.DataDir, h.DocsDir, h.CacheDir} {
		os.MkdirAll(d, 0o755)
	}
	for _, a := range Areas {
		os.MkdirAll(filepath.Join(h.DocsDir, a), 0o755)
	}
}

func (h *Host) initLog() {
	dir := filepath.Join(h.CacheDir, "logs")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, h.cfg.AppID+".log")
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
		os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}
}

// guard blocks requests from other web pages (DNS rebinding, cross-site posts).
func (h *Host) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hostOK := false
		for _, a := range []string{"127.0.0.1", "localhost"} {
			if r.Host == fmt.Sprintf("%s:%d", a, h.port) {
				hostOK = true
			}
		}
		if !hostOK {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" && o != "null" {
				if o != fmt.Sprintf("http://127.0.0.1:%d", h.port) && o != fmt.Sprintf("http://localhost:%d", h.port) {
					http.Error(w, "forbidden origin", http.StatusForbidden)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Host) routes(mux *http.ServeMux) {
	mux.HandleFunc("/api/info", h.handleInfo)
	mux.HandleFunc("/api/events", h.handleEvents)
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		h.Shutdown()
	})
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		h.handleJSONFile(w, r, filepath.Join(h.DataDir, h.cfg.AppID+".settings.json"))
	})
	mux.HandleFunc("/api/store/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/api/store/")
		if !validName(name) {
			http.Error(w, "bad store name", 400)
			return
		}
		h.handleJSONFile(w, r, filepath.Join(h.DataDir, name+".json"))
	})
	mux.HandleFunc("/api/files", h.handleList)
	mux.HandleFunc("/api/file", h.handleFile)
	mux.HandleFunc("/api/file/append", h.handleAppend)
	mux.HandleFunc("/api/reveal", h.handleReveal)

	sub, _ := fs.Sub(h.cfg.Assets, "shared")
	mux.Handle("/shared/", http.StripPrefix("/shared/", h.static(sub)))
	app, _ := fs.Sub(h.cfg.Assets, h.cfg.AppID)
	mux.Handle("/", h.static(app))
}

func (h *Host) static(fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		ct := mime.TypeByExtension(path.Ext(p))
		switch path.Ext(p) {
		case ".js", ".mjs":
			ct = "text/javascript; charset=utf-8"
		case ".css":
			ct = "text/css; charset=utf-8"
		case ".svg":
			ct = "image/svg+xml"
		case ".html":
			ct = "text/html; charset=utf-8"
		}
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(data)
	})
}

func (h *Host) handleInfo(w http.ResponseWriter, r *http.Request) {
	areas := map[string]string{}
	for k, v := range Areas {
		areas[k] = filepath.Join(h.DocsDir, v)
	}
	writeJSON(w, map[string]any{
		"app": h.cfg.AppID, "name": h.cfg.Name, "version": Version,
		"dataDir": h.DataDir, "docsDir": h.DocsDir, "areas": areas,
		"platform": platformName(),
	})
}

// ---- live event stream; also tells us when the window closes ----

func (h *Host) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch := make(chan sseMsg, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.clients++
	h.everSeen = true
	if h.idleT != nil {
		h.idleT.Stop()
		h.idleT = nil
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.clients--
		if h.clients == 0 && os.Getenv("AVIARY_STAY") == "" {
			h.idleT = time.AfterFunc(6*time.Second, func() {
				h.mu.Lock()
				n := h.clients
				h.mu.Unlock()
				if n == 0 {
					log.Printf("window closed; exiting")
					h.Shutdown()
				}
			})
		}
		h.mu.Unlock()
	}()

	fmt.Fprintf(w, "event: hello\ndata: {\"app\":%q}\n\n", h.cfg.AppID)
	fl.Flush()
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-ch:
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", m.event, m.data)
			// Drain whatever else is queued before flushing.
			for i := 0; i < 64; i++ {
				select {
				case m2 := <-ch:
					fmt.Fprintf(w, "event: %s\ndata: %s\n\n", m2.event, m2.data)
					continue
				default:
				}
				break
			}
			fl.Flush()
		case <-tick.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// Publish sends an event to every open window.
func (h *Host) Publish(event string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- sseMsg{event, data}:
		default: // window is behind; drop rather than block
		}
	}
}

// ---- JSON settings / stores ----

func (h *Host) handleJSONFile(w http.ResponseWriter, r *http.Request, p string) {
	switch r.Method {
	case http.MethodGet:
		data, err := os.ReadFile(p)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("null"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	case http.MethodPut, http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
		if err != nil || !json.Valid(body) {
			http.Error(w, "invalid JSON", 400)
			return
		}
		h.fileMu.Lock()
		err = atomicWrite(p, body)
		h.fileMu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", 405)
	}
}

// ---- file areas under Documents\Aviary ----

func (h *Host) resolve(area, rel string) (string, error) {
	dirName, ok := Areas[area]
	if !ok {
		return "", fmt.Errorf("unknown area %q", area)
	}
	root := filepath.Join(h.DocsDir, dirName)
	rel = filepath.FromSlash(path.Clean("/" + strings.ReplaceAll(rel, "\\", "/")))
	full := filepath.Join(root, rel)
	if full != root && !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes area")
	}
	return full, nil
}

type fileEntry struct {
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Dir      bool      `json:"dir"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func (h *Host) handleList(w http.ResponseWriter, r *http.Request) {
	area := r.URL.Query().Get("area")
	root, err := h.resolve(area, "")
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	var out []fileEntry
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		depth := strings.Count(rel, string(filepath.Separator))
		if depth > 2 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, fileEntry{Path: filepath.ToSlash(rel), Name: d.Name(), Dir: d.IsDir(), Size: info.Size(), Modified: info.ModTime()})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	if out == nil {
		out = []fileEntry{}
	}
	writeJSON(w, map[string]any{"root": root, "files": out})
}

func (h *Host) handleFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p, err := h.resolve(q.Get("area"), q.Get("path"))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	switch r.Method {
	case http.MethodGet:
		f, err := os.Open(p)
		if err != nil {
			http.Error(w, "not found", 404)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.Copy(w, f)
	case http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		if q.Get("unique") == "1" {
			p = uniquePath(p)
		}
		h.fileMu.Lock()
		err = atomicWrite(p, body)
		h.fileMu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		root, _ := h.resolve(q.Get("area"), "")
		rel, _ := filepath.Rel(root, p)
		writeJSON(w, map[string]any{"ok": true, "path": filepath.ToSlash(rel), "full": p})
	default:
		http.Error(w, "method", 405)
	}
}

func (h *Host) handleAppend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	q := r.URL.Query()
	p, err := h.resolve(q.Get("area"), q.Get("path"))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	h.fileMu.Lock()
	defer h.fileMu.Unlock()
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer f.Close()
	if _, err := f.Write(body); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (h *Host) handleReveal(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p, err := h.resolve(q.Get("area"), q.Get("path"))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := reveal(p); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func validName(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func atomicWrite(p string, data []byte) error {
	os.MkdirAll(filepath.Dir(p), 0o755)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		// Windows can refuse to replace a file another program has open.
		os.Remove(tmp)
		return os.WriteFile(p, data, 0o644)
	}
	return nil
}

func uniquePath(p string) string {
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 2; i < 1000; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(c); err != nil {
			return c
		}
	}
	return p
}
