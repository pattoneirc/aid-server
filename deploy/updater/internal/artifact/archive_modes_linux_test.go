package artifact

import (
	"archive/tar"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestExtractTarGzPreservesModeWithPrivateUmask(t *testing.T) {
	original := syscall.Umask(0o077)
	defer syscall.Umask(original)

	src := writeArchive(t, &tar.Header{Name: "aid.sh", Mode: 0o755, Size: 1, Typeflag: tar.TypeReg}, "x")
	target := t.TempDir()
	if err := ExtractTarGz(src, target); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(target, "aid.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("script mode = %o, want 755", got)
	}
}
