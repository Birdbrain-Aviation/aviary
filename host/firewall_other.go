//go:build !windows

package host

import "errors"

// Linux and macOS firewalls are left to the user; most desktops allow these ports.
func firewallAllowed() (allowed, known bool) { return true, false }

func allowFirewall() error {
	return errors.New("open TCP ports 47711 and 47712 in your firewall (for example: sudo ufw allow 47711:47712/tcp)")
}
