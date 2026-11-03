// Package web holds the user interface for all three apps.
package web

import "embed"

//go:embed shared owl heron mockingbird
var FS embed.FS
