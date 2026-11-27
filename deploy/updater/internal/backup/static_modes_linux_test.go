package backup

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestReplaceDirMakesStaticAssetsReadableWithPrivateUmask(t *testing.T) {
	original := syscall.Umask(0o077)
	defer syscall.Umask(original)

	root := t.TempDir()
	source := filepath.Join(root, "snapshot")
	sourceAssets := filepath.Join(source, "static")
	if err := os.MkdirAll(sourceAssets, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceAssets, "index.html"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "public")
	if err := ReplaceDir(source, target); err != nil {
		t.Fatal(err)
	}
	for relative, want := range map[string]os.FileMode{".": 0o755, "static": 0o755, "static/index.html": 0o644} {
		info, err := os.Stat(filepath.Join(target, relative))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", relative, got, want)
		}
	}
}
