//go:build windows

package host

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const fwRule = "Aviary Owl phone companion"

var fwCache struct {
	sync.Mutex
	at      time.Time
	allowed bool
}

// firewallAllowed reports whether Owl's companion rule exists (checked at
// most every few seconds; netsh needs no administrator rights to look).
func firewallAllowed() (allowed, known bool) {
	fwCache.Lock()
	defer fwCache.Unlock()
	if time.Since(fwCache.at) < 4*time.Second {
		return fwCache.allowed, true
	}
	cmd := exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name="+fwRule)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // no console window
	err := cmd.Run()
	fwCache.allowed, fwCache.at = err == nil, time.Now()
	return fwCache.allowed, true
}

// allowFirewall asks Windows (one administrator prompt) to let phones reach
// Owl: it clears Owl's old inbound rules, including the block rules Windows
// adds when its firewall question is cancelled, then allows the companion's
// two ports and Owl's UDP telemetry on every network type.
func allowFirewall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := fmt.Sprintf(`/c netsh advfirewall firewall delete rule name=all dir=in program="%[1]s" & `+
		`netsh advfirewall firewall add rule name="%[2]s" dir=in action=allow protocol=TCP localport=%[3]d-%[4]d profile=any program="%[1]s" enable=yes & `+
		`netsh advfirewall firewall add rule name="Aviary Owl telemetry" dir=in action=allow protocol=UDP profile=any program="%[1]s" enable=yes`,
		exe, fwRule, companionSetupPort, companionPort)
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString("cmd.exe")
	params, _ := syscall.UTF16PtrFromString(args)
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), uintptr(unsafe.Pointer(params)), 0, 0) // SW_HIDE
	if r <= 32 {
		return fmt.Errorf("Windows didn't allow the change (code %d). Allow Owl in Windows Security › Firewall › Allow an app instead", r)
	}
	fwCache.Lock()
	fwCache.at = time.Time{} // look again on the next status
	fwCache.Unlock()
	return nil
}
