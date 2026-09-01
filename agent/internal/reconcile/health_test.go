package reconcile

import "testing"

// Docker packs exit codes, restart counts and health verdicts into the same
// parentheses. Reading whichever came first meant an exit code was reported to
// the control plane as a health verdict — and a non-empty verdict is how the
// control plane decides a service *has* a health check to wait on, so a
// crash-looping container made itself permanently unpromotable.
func TestHealthFromStatus(t *testing.T) {
	cases := []struct {
		status string
		want   string
		why    string
	}{
		{"Up 2 minutes (healthy)", "healthy", "the ordinary passing case"},
		{"Up 2 minutes (unhealthy)", "unhealthy", "a real failing verdict"},
		{"Up 40 seconds (health: starting)", "starting", "still inside start-period"},
		{"Up 3 hours", "", "no health check configured at all"},
		{"Created", "", "never started"},

		{"Restarting (1) 5 seconds ago", "", "that 1 is an exit code, not health"},
		{"Restarting (255) 2 seconds ago", "", "and so is 255"},
		{"Exited (0) 3 minutes ago", "", "a clean exit is not a health verdict"},
		{"Exited (137) 1 minute ago", "", "nor is being OOM-killed"},

		{"Up 5 seconds (Healthy)", "healthy", "case is Docker's business, not ours"},
		{"Up 1 second (", "", "a truncated status must not panic or invent a value"},
		{"", "", "an empty status is not an error"},
	}

	for _, c := range cases {
		if got := healthFromStatus(c.status); got != c.want {
			t.Errorf("healthFromStatus(%q) = %q, want %q — %s", c.status, got, c.want, c.why)
		}
	}
}
