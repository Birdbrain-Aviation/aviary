//go:build windows

package host

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	ole32                    = syscall.NewLazyDLL("ole32.dll")
	user32                   = syscall.NewLazyDLL("user32.dll")
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
	procMessageBoxW          = user32.NewProc("MessageBoxW")
	procShellExecuteW        = shell32.NewProc("ShellExecuteW")
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
var folderIDDocuments = guid{0xFDD39AD0, 0x238F, 0x46AF, [8]byte{0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7}}

func platformName() string { return "windows" }

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0; n++ {
		ptr = unsafe.Add(ptr, 2)
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

// documentsDir returns the real Documents folder, including when it has been
// moved into OneDrive.
func documentsDir() (dir string) {
	defer func() {
		if r := recover(); r != nil || dir == "" {
			home, _ := os.UserHomeDir()
			dir = filepath.Join(home, "Documents")
		}
	}()
	var p *uint16
	r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&folderIDDocuments)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if r == 0 && p != nil {
		dir = utf16PtrToString(p)
		procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	}
	return dir
}

func localCacheDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return d
	}
	d, err := os.UserCacheDir()
	if err != nil {
		return os.TempDir()
	}
	return d
}

func messageBox(title, text string) {
	defer func() { recover() }()
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	const mbIconInformation = 0x40
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbIconInformation)
}

func registryAppPath(exe string) string {
	for _, root := range []syscall.Handle{syscall.HKEY_LOCAL_MACHINE, syscall.HKEY_CURRENT_USER} {
		sub, _ := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exe)
		var k syscall.Handle
		if err := syscall.RegOpenKeyEx(root, sub, 0, syscall.KEY_READ, &k); err != nil {
			continue
		}
		buf := make([]uint16, 1024)
		n := uint32(len(buf) * 2)
		var typ uint32
		err := syscall.RegQueryValueEx(k, nil, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n)
		syscall.RegCloseKey(k)
		if err == nil {
			p := syscall.UTF16ToString(buf)
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

// findBrowser prefers Microsoft Edge (installed on every Windows 10/11 PC),
// then Google Chrome. Both support the serial-port access the apps need.
func findBrowser() string {
	var c []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if base := os.Getenv(env); base != "" {
			c = append(c, filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`))
		}
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
		if base := os.Getenv(env); base != "" {
			c = append(c, filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
		}
	}
	for _, p := range c {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	for _, exe := range []string{"msedge.exe", "chrome.exe"} {
		if p := registryAppPath(exe); p != "" {
			return p
		}
	}
	return ""
}

func openAppWindow(url string, w, h int) error {
	if b := findBrowser(); b != "" {
		args := []string{"--app=" + url, "--no-first-run", "--no-default-browser-check"}
		if w > 0 && h > 0 {
			args = append(args, fmt.Sprintf("--window-size=%d,%d", w, h))
		}
		cmd := exec.Command(b, args...)
		if err := cmd.Start(); err == nil {
			go cmd.Wait()
			return nil
		} else {
			log.Printf("start %s: %v", b, err)
		}
	}
	// Fall back to the default browser, the normal Windows way.
	verb, _ := syscall.UTF16PtrFromString("open")
	target, _ := syscall.UTF16PtrFromString(url)
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if r <= 32 {
		return fmt.Errorf("could not open the default browser (code %d)", r)
	}
	return nil
}

func reveal(p string) error {
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		return exec.Command("explorer.exe", p).Start()
	}
	if _, err := os.Stat(p); err != nil {
		return exec.Command("explorer.exe", filepath.Dir(p)).Start()
	}
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + p + `"`}
	return cmd.Start()
}
