package web

import (
	"encoding/json"
	"os"
	"testing"
)

func TestResizeBounds(t *testing.T) {
	file, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	data, _ := json.Marshal(control{Type: "resize", Cols: 0, Rows: 999})
	if err := resize(file, data); err == nil {
		t.Fatal("resize on a non-PTY should fail after parsing bounded dimensions")
	}
}

func TestClamp(t *testing.T) {
	for _, test := range []struct{ value, want int }{{-1, 1}, {20, 20}, {600, 500}} {
		if got := clamp(test.value, 1, 500); got != test.want {
			t.Fatalf("clamp(%d) = %d, want %d", test.value, got, test.want)
		}
	}
}
