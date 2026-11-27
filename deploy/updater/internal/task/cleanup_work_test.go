package task

import (
	"os"
	"path/filepath"
	"testing"

	"aid-updater/internal/config"
)

func TestCleanupVersionTaskWork(t *testing.T) {
	root := t.TempDir()
	taskFiles := []string{
		"pkg-current.tar.gz", "pkg-current.tar.gz.part", "pkg-current.tar.gz.part.sha256",
		"source-builder-current.sh", "source-builder-current.sh.part",
	}
	otherFiles := []string{"pkg-other.tar.gz", "recovery-current.json", "updater.log"}
	for _, name := range append(taskFiles, otherFiles...) {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"extract-current", "source-current", "backups", "build-cache"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	runner := &Runner{cfg: &config.Config{WorkDir: root}}
	if err := runner.cleanupVersionTaskWork(&Task{TaskID: "current", Action: ActionUpgrade}); err != nil {
		t.Fatal(err)
	}
	for _, name := range append(taskFiles, "extract-current", "source-current") {
		if _, err := os.Lstat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Errorf("task artifact %s remains: %v", name, err)
		}
	}
	for _, name := range append(otherFiles, "backups", "build-cache") {
		if _, err := os.Lstat(filepath.Join(root, name)); err != nil {
			t.Errorf("unrelated path %s was removed: %v", name, err)
		}
	}
}
