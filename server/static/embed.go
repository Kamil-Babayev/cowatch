package static

import "embed"

// FS contains the join landing-page files served by the API.
//
//go:embed join
var FS embed.FS
