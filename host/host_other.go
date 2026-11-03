//go:build !windows

package host

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func platformName() string { return runtime.GOOS }

func documentsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Documents")
}

func localCacheDir() string {
	d, err := os.UserCacheDir()
	if err != nil {
		return os.TempDir()
	}
	return d
}

func messageBox(title, text string) { log.Printf("%s: %s", title, text) }

func openAppWindow(url string, w, h int) error {
	for _, b := range []string{"microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(b); err == nil {
			return exec.Command(p, "--app="+url).Start()
		}
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}

func reveal(p string) error {
	if st, err := os.Stat(p); err != nil || !st.IsDir() {
		p = filepath.Dir(p)
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", p).Start()
	}
	return exec.Command("xdg-open", p).Start()
}
