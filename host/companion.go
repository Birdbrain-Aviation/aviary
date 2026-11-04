package host

// Owl's phone companion: a small web app served to phones on the same network
// (Wi-Fi or the phone's own hotspot), showing Owl's live readouts and a
// recovery arrow driven by the phone's GPS and compass.
//
// It is off until the Owl window turns it on. It then listens on every network
// interface, but only for:
//   - https://<laptop>:47712/          the companion app (static files)
//   - https://<laptop>:47712/c/...      live data, only with the pairing key
//   - http://<laptop>:47711/            a setup page and Owl's certificate
// Nothing else on the laptop (files, settings, the main API) is reachable.
//
// iPhones only allow GPS and compass on secure pages, so the app is served over
// HTTPS with a certificate from a small local certificate authority that Owl
// makes once and the phone trusts once (Settings > General > About >
// Certificate Trust Settings). The server certificate is re-made for whatever
// addresses the laptop has, so changing networks doesn't need a new trust.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	companionPort      = 47712 // HTTPS: the app and its data
	companionSetupPort = 47711 // HTTP: setup page and certificate download
)

type companion struct {
	h     *Host
	files fs.FS
	mu    sync.Mutex
	on    bool
	key   string
	state []byte
	subs  map[chan []byte]struct{}
	srvs  []*http.Server
	err   string

	caCert *x509.Certificate
	caDER  []byte
	caKey  *ecdsa.PrivateKey
	leaf   *tls.Certificate
	leafIP map[string]bool

	contact map[string]any // last request from a phone
}

// EnableCompanion adds the phone companion to an app (Owl). files holds the
// companion's web app (index.html and friends).
func (h *Host) EnableCompanion(mux *http.ServeMux, files fs.FS) {
	c := &companion{h: h, files: files, subs: map[chan []byte]struct{}{}}
	dir := filepath.Join(h.DataDir, "companion")
	os.MkdirAll(dir, 0o700)
	c.key = c.loadKey(dir)

	mux.HandleFunc("/api/companion", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var q struct {
				On     bool `json:"on"`
				NewKey bool `json:"newKey"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&q); err != nil {
				http.Error(w, "bad request", 400)
				return
			}
			if q.NewKey {
				c.mu.Lock()
				c.key = randomKey()
				os.WriteFile(filepath.Join(dir, "key.txt"), []byte(c.key), 0o600)
				c.mu.Unlock()
				c.dropSubs() // phones with the old key are disconnected
			}
			if q.On {
				c.start(dir)
			} else {
				c.stop()
			}
		}
		writeJSON(w, c.status())
	})
	mux.HandleFunc("/api/companion/firewall", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		if err := allowFirewall(); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, c.status())
	})
	mux.HandleFunc("/api/companion/state", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil || !json.Valid(data) {
			http.Error(w, "bad state", 400)
			return
		}
		c.publish(data)
		w.WriteHeader(204)
	})
}

func randomKey() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (c *companion) loadKey(dir string) string {
	p := filepath.Join(dir, "key.txt")
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) >= 8 {
		return strings.TrimSpace(string(b))
	}
	k := randomKey()
	os.WriteFile(p, []byte(k), 0o600)
	return k
}

func (c *companion) publish(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = data
	for ch := range c.subs {
		select {
		case ch <- data:
		default:
		}
	}
}

func (c *companion) dropSubs() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for ch := range c.subs {
		close(ch)
		delete(c.subs, ch)
	}
}

// A network address phones might reach this computer on.
type lanAddr struct {
	IP, Iface string
	Primary   bool // the one Windows uses for its default route
}

// Adapters that phones can't reach: virtual machines, WSL, VPN tunnels.
func virtualIface(name string) bool {
	n := strings.ToLower(name)
	for _, w := range []string{"vethernet", "virtualbox", "vmware", "hyper-v", "wsl", "docker", "vboxnet", "virbr", "veth", "br-", "loopback", "pseudo", "teredo", "isatap", "bluetooth", "zerotier", "hamachi"} {
		if strings.Contains(n, w) {
			return true
		}
	}
	return false
}

// LAN addresses people can reach this computer on, best guess first: the
// adapter that carries the default route, then other real adapters.
func lanAddrs() []lanAddr {
	primary := ""
	if conn, err := net.Dial("udp4", "192.0.2.1:9"); err == nil { // no packet is sent; this only asks for the route
		if a, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			primary = a.IP.String()
		}
		conn.Close()
	}
	var out []lanAddr
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || ipn.IP.IsLinkLocalUnicast() {
				continue
			}
			ip := ipn.IP.String()
			if ip != primary && virtualIface(i.Name) {
				continue
			}
			out = append(out, lanAddr{IP: ip, Iface: i.Name, Primary: ip == primary})
		}
	}
	rank := func(a lanAddr) int {
		switch {
		case a.Primary:
			return -1
		case strings.HasPrefix(a.IP, "172.20.10."): // iPhone hotspot
			return 0
		case strings.HasPrefix(a.IP, "192.168."), strings.HasPrefix(a.IP, "10."):
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(a, b int) bool { return rank(out[a]) < rank(out[b]) })
	return out
}

func lanIPs() []string {
	var out []string
	for _, a := range lanAddrs() {
		out = append(out, a.IP)
	}
	return out
}

// noteContact remembers the last time a phone reached the companion, so Owl
// can tell a network or firewall problem from a phone-side one.
func (c *companion) noteContact(r *http.Request, what string) {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "127.0.0.1" || ip == "::1" {
		return
	}
	c.mu.Lock()
	c.contact = map[string]any{"ip": ip, "what": what, "at": time.Now().UnixMilli()}
	c.mu.Unlock()
}

func (c *companion) status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	urls := []map[string]any{}
	for _, a := range lanAddrs() {
		urls = append(urls, map[string]any{
			"ip": a.IP, "iface": a.Iface, "primary": a.Primary,
			"app":   fmt.Sprintf("https://%s:%d/?k=%s", a.IP, companionPort, c.key),
			"setup": fmt.Sprintf("http://%s:%d/?k=%s", a.IP, companionSetupPort, c.key),
		})
	}
	host, _ := os.Hostname()
	fw, fwKnown := firewallAllowed()
	return map[string]any{"on": c.on, "key": c.key, "urls": urls, "port": companionPort, "setupPort": companionSetupPort,
		"hostname": host, "phones": len(c.subs), "error": c.err, "contact": c.contact,
		"firewall": map[string]any{"known": fwKnown, "allowed": fw, "windows": runtime.GOOS == "windows"}}
}

func (c *companion) start(dir string) {
	c.mu.Lock()
	if c.on {
		c.mu.Unlock()
		return
	}
	c.err = ""
	c.mu.Unlock()
	if err := c.loadCA(dir); err != nil {
		c.setErr("Couldn't make the certificate: " + err.Error())
		return
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: c.getCert}
	appLn, err := net.Listen("tcp", fmt.Sprintf(":%d", companionPort))
	if err != nil {
		c.setErr(fmt.Sprintf("Port %d is in use by another program.", companionPort))
		return
	}
	setupLn, err := net.Listen("tcp", fmt.Sprintf(":%d", companionSetupPort))
	if err != nil {
		appLn.Close()
		c.setErr(fmt.Sprintf("Port %d is in use by another program.", companionSetupPort))
		return
	}
	appSrv := &http.Server{Handler: c.appHandler(), TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second,
		ErrorLog: log.New(io.Discard, "", 0)} // phones that haven't trusted the certificate yet fill the log otherwise
	setupSrv := &http.Server{Handler: c.setupHandler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := appSrv.ServeTLS(appLn, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("companion: %v", err)
		}
	}()
	go func() {
		if err := setupSrv.Serve(setupLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("companion setup: %v", err)
		}
	}()
	c.mu.Lock()
	c.on = true
	c.srvs = []*http.Server{appSrv, setupSrv}
	c.mu.Unlock()
	log.Printf("companion on: %v", lanIPs())
}

func (c *companion) setErr(s string) {
	c.mu.Lock()
	c.err = s
	c.mu.Unlock()
	log.Printf("companion: %s", s)
}

func (c *companion) stop() {
	c.mu.Lock()
	srvs := c.srvs
	c.srvs = nil
	c.on = false
	c.mu.Unlock()
	for _, s := range srvs {
		s.Close()
	}
	c.dropSubs()
}

func (c *companion) keyOK(r *http.Request) bool {
	k := r.URL.Query().Get("k")
	c.mu.Lock()
	want := c.key
	c.mu.Unlock()
	return k != "" && subtle.ConstantTimeCompare([]byte(k), []byte(want)) == 1
}

func (c *companion) appHandler() http.Handler {
	mux := http.NewServeMux()
	static := http.FileServer(http.FS(c.files))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			c.noteContact(r, "opened the companion")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasSuffix(r.URL.Path, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("/c/state", func(w http.ResponseWriter, r *http.Request) {
		if !c.keyOK(r) {
			http.Error(w, "wrong or missing pairing key", 401)
			return
		}
		c.mu.Lock()
		s := c.state
		c.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if s == nil {
			s = []byte("{}")
		}
		w.Write(s)
	})
	mux.HandleFunc("/c/events", func(w http.ResponseWriter, r *http.Request) {
		if !c.keyOK(r) {
			http.Error(w, "wrong or missing pairing key", 401)
			return
		}
		c.noteContact(r, "connected for live data")
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		ch := make(chan []byte, 16)
		c.mu.Lock()
		c.subs[ch] = struct{}{}
		first := c.state
		c.mu.Unlock()
		defer func() {
			c.mu.Lock()
			if _, ok := c.subs[ch]; ok {
				delete(c.subs, ch)
			}
			c.mu.Unlock()
		}()
		fmt.Fprint(w, "retry: 2000\n\n")
		if first != nil {
			fmt.Fprintf(w, "event: state\ndata: %s\n\n", first)
		}
		fl.Flush()
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case m, ok := <-ch:
				if !ok {
					return
				}
				// only the newest state matters
				for len(ch) > 0 {
					if n, ok2 := <-ch; ok2 {
						m = n
					}
				}
				fmt.Fprintf(w, "event: state\ndata: %s\n\n", m)
				fl.Flush()
			case <-tick.C:
				fmt.Fprint(w, "event: ping\ndata: {}\n\n")
				fl.Flush()
			}
		}
	})
	return mux
}

// The setup page: plain HTTP, so it opens before the phone trusts anything.
func (c *companion) setupHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/aviary-owl.cer", func(w http.ResponseWriter, r *http.Request) {
		c.noteContact(r, "downloaded the certificate")
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="aviary-owl.cer"`)
		w.Write(c.caDER)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		c.noteContact(r, "opened the setup page")
		k := r.URL.Query().Get("k")
		hostOnly := r.Host
		if hh, _, err := net.SplitHostPort(r.Host); err == nil {
			hostOnly = hh
		}
		app := fmt.Sprintf("https://%s:%d/?k=%s", hostOnly, companionPort, k)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, setupPage, html.EscapeString(app), html.EscapeString(app))
	})
	return mux
}

const setupPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owl companion setup</title>
<style>
:root { color-scheme: light dark; --ink:#16202a; --g:#56626c; --o:#ff5a1f; --rule:#cdd5d8; --bg:#fbfcfb; }
@media (prefers-color-scheme: dark) { :root { --ink:#e4eaee; --g:#9aa8b2; --rule:#26323c; --bg:#151e26; } }
body { margin:0; font: 17px/1.45 -apple-system, system-ui, sans-serif; color:var(--ink); background:var(--bg); }
main { max-width: 34rem; margin: 0 auto; padding: 22px 18px 40px; }
h1 { font-size: 24px; margin: 0 0 4px; } h1::before { content:""; display:inline-block; width:4px; height:20px; background:var(--o); margin-right:10px; vertical-align:-2px; }
p.sub { color: var(--g); margin-top: 0; }
ol { padding-left: 1.3em; } li { margin: 12px 0; }
a.btn { display:block; text-align:center; padding: 13px; margin: 8px 0; border-radius: 10px; text-decoration:none; font-weight:600; border:1.5px solid var(--ink); color:var(--ink); }
a.btn.primary { background: var(--o); border-color: var(--o); color:#fff; }
.note { color: var(--g); font-size: 15px; }
code { font-size: 15px; }
</style></head><body><main>
<h1>Owl companion</h1>
<p class="sub">One-time setup, about two minutes. Then the companion opens straight from your home screen.</p>
<ol>
<li><b>Get Owl's certificate.</b> <a class="btn" href="/aviary-owl.cer">Download certificate</a> Tap <b>Allow</b>, then <b>Close</b>.</li>
<li><b>Install it.</b> Open <b>Settings</b>, tap <b>Profile Downloaded</b> near the top, then <b>Install</b> (twice) and enter your passcode.</li>
<li><b>Trust it.</b> Settings, General, About, <b>Certificate Trust Settings</b>: turn on <b>Aviary Owl</b>, then Continue.</li>
<li><b>Open the companion.</b> <a class="btn primary" href="%s">Open Owl companion</a></li>
<li><b>Add it to your home screen.</b> In Safari tap the Share button, then <b>Add to Home Screen</b>.</li>
</ol>
<p class="note">The certificate only lets your phone talk securely to Owl on this laptop; Owl made it on this computer and it isn't used for anything else. You can remove it any time in Settings, General, VPN &amp; Device Management.</p>
<p class="note">Address: <code>%s</code></p>
</main></body></html>`

// ---- certificates ----

func (c *companion) loadCA(dir string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.caCert != nil {
		return nil
	}
	certP, keyP := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "ca-key.pem")
	if cb, err := os.ReadFile(certP); err == nil {
		if kb, err := os.ReadFile(keyP); err == nil {
			cblk, _ := pem.Decode(cb)
			kblk, _ := pem.Decode(kb)
			if cblk != nil && kblk != nil {
				cert, err1 := x509.ParseCertificate(cblk.Bytes)
				key, err2 := x509.ParseECPrivateKey(kblk.Bytes)
				if err1 == nil && err2 == nil && time.Now().Before(cert.NotAfter.Add(-30*24*time.Hour)) {
					c.caCert, c.caDER, c.caKey = cert, cblk.Bytes, key
					return nil
				}
			}
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	tpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "Aviary Owl (" + host + ")", Organization: []string{"Aviary Owl"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	cert, _ := x509.ParseCertificate(der)
	kder, _ := x509.MarshalECPrivateKey(key)
	if err := os.WriteFile(keyP, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(certP, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return err
	}
	c.caCert, c.caDER, c.caKey = cert, der, key
	return nil
}

func serial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	return n
}

// Server certificate for every address the laptop has right now, made again
// when a phone reaches it on an address it doesn't cover (a new network).
func (c *companion) getCert(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	local := ""
	if hello.Conn != nil {
		if a, ok := hello.Conn.LocalAddr().(*net.TCPAddr); ok {
			local = a.IP.String()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.leaf != nil && (local == "" || c.leafIP[local]) && time.Now().Before(c.leaf.Leaf.NotAfter.Add(-24*time.Hour)) {
		return c.leaf, nil
	}
	ips := map[string]bool{"127.0.0.1": true}
	for _, ip := range lanIPs() {
		ips[ip] = true
	}
	if local != "" {
		ips[local] = true
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	tpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: "Owl companion"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(0, 0, 397), // iPhones refuse longer-lived server certificates
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
	}
	if host != "" {
		tpl.DNSNames = append(tpl.DNSNames, host, strings.ToLower(host)+".local")
	}
	for ip := range ips {
		tpl.IPAddresses = append(tpl.IPAddresses, net.ParseIP(ip))
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.caCert, &key.PublicKey, c.caKey)
	if err != nil {
		return nil, err
	}
	leaf, _ := x509.ParseCertificate(der)
	c.leaf = &tls.Certificate{Certificate: [][]byte{der, c.caDER}, PrivateKey: key, Leaf: leaf}
	c.leafIP = ips
	return c.leaf, nil
}
