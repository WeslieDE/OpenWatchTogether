package room

import (
	"regexp"
	"strings"
)

// Muss exakt zu Rooms::normalize() (src/Rooms.php) und slugify() in
// sfu/server.js passen - sonst landet HLSStream in einem anderen "Raum" als
// die Browser, die denselben Namen eingegeben haben.
var (
	spaceRun   = regexp.MustCompile(`\s+`)
	disallowed = regexp.MustCompile(`[^a-z0-9äöüß\-]`)
	dashRun    = regexp.MustCompile(`-+`)
)

func Slugify(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = spaceRun.ReplaceAllString(s, "-")
	s = disallowed.ReplaceAllString(s, "")
	s = dashRun.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")

	r := []rune(s)
	if len(r) > 40 {
		r = r[:40]
	}
	return string(r)
}
