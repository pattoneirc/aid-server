package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"aid-updater/internal/config"
	"aid-updater/internal/dbexec"
)

const snapshotManifest = "snapshot.json"

type Entry struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	CreatedAt string `json:"createdAt"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

// ValidateDirectory checks the path in the backup executor's filesystem.
func ValidateDirectory(path string) error {
	root, err := validateExistingBackupRoot(path)
	if err != nil {
		return err
	}
	probe, err := os.CreateTemp(root, ".aid-backup-check-*")
	if err != nil {
		return err
	}
	_, writeErr := probe.WriteString("AID")
	return errors.Join(writeErr, probe.Sync(), probe.Close(), os.Remove(probe.Name()))
}

func protectedPaths(cfg *config.Config) map[string]string {
	return map[string]string{
		"aid-admin.jar":   cfg.Install.BackendJar,
		"build-info.json": filepath.Join(filepath.Dir(cfg.Install.BackendJar), "build-info.json"),
		"admin-dist":      cfg.Install.AdminDist,
		"web-dist":        cfg.Install.WebDist,
	}
}

func digest(path string) (string, int64, error) {
	hash := sha256.New()
	var size int64
	err := filepath.WalkDir(path, func(file string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name, err := filepath.Rel(path, file)
		if err != nil {
			return err
		}
		if item.IsDir() {
			fmt.Fprintf(hash, "dir %q\n", filepath.ToSlash(name))
			return nil
		}
		if !item.Type().IsRegular() {
			return fmt.Errorf("存在非普通文件: %s", file)
		}
		input, err := os.Open(file)
		if err != nil {
			return err
		}
		fileHash := sha256.New()
		n, copyErr := io.Copy(fileHash, input)
		if err := errors.Join(copyErr, input.Close()); err != nil {
			return err
		}
		size += n
		if file == path {
			// A single file uses its raw digest, also used for streaming a DB dump.
			hash = fileHash
		} else {
			fmt.Fprintf(hash, "file %q %d %x\n", filepath.ToSlash(name), n, fileHash.Sum(nil))
		}
		return nil
	})
	return hex.EncodeToString(hash.Sum(nil)), size, err
}

func Capture(cfg *config.Config, label, sourceVersion string) (*Snapshot, bool, error) {
	if !cfg.Database.Enabled {
		return nil, false, fmt.Errorf("未启用数据库备份配置")
	}
	if err := ValidateDirectory(cfg.BackupDir); err != nil {
		return nil, false, fmt.Errorf("备份目录 %s 校验失败: %w", cfg.BackupDir, err)
	}
	paths := protectedPaths(cfg)
	version := struct{ Version string }{Version: sourceVersion}
	raw, err := os.ReadFile(paths["build-info.json"])
	if err == nil {
		if err := json.Unmarshal(raw, &version); err != nil {
			return nil, false, fmt.Errorf("读取运行版本失败: %w", err)
		}
	} else if os.IsNotExist(err) && sourceVersion != "" {
		delete(paths, "build-info.json")
	} else {
		return nil, false, err
	}
	if strings.TrimSpace(version.Version) == "" {
		return nil, false, fmt.Errorf("当前版本未知")
	}
	appDigests := make(map[string]string, len(paths))
	var artifactBytes uint64
	for name, path := range paths {
		sum, size, err := digest(path)
		if err != nil || size == 0 {
			return nil, false, fmt.Errorf("三端产物无法完整备份: %s (%v)", path, err)
		}
		appDigests[name] = sum
		artifactBytes += uint64(size)
	}
	for _, entry := range List(cfg.BackupDir) {
		if entry.Version != version.Version {
			continue
		}
		candidate, err := Load(cfg.BackupDir, entry.ID)
		if err != nil || !sameArtifacts(candidate, appDigests) {
			continue
		}
		hash := sha256.New()
		if err := dbexec.DumpTo(cfg.Database, hash); err != nil {
			return nil, false, err
		}
		if hex.EncodeToString(hash.Sum(nil)) == candidate.Digests["database.sql"] {
			return candidate, false, nil
		}
		break
	}
	if err := checkDiskSpace(cfg.BackupDir, artifactBytes); err != nil {
		return nil, false, err
	}
	snapshot, err := Create(cfg, label+"-"+version.Version)
	if err != nil {
		return nil, false, err
	}
	snapshot.Version = version.Version
	snapshot.Digests = appDigests
	for name := range appDigests {
		sum, size, validateErr := digest(filepath.Join(snapshot.Dir, name))
		if validateErr != nil || sum != appDigests[name] {
			return nil, false, errors.Join(fmt.Errorf("程序备份校验失败: %s", name), validateErr, Discard(cfg.BackupDir, snapshot))
		}
		snapshot.SizeBytes += size
	}
	dbHash, dbSize, err := digest(snapshot.DBDumpFile)
	if err != nil || dbSize == 0 {
		return nil, false, errors.Join(fmt.Errorf("数据库备份校验失败"), err, Discard(cfg.BackupDir, snapshot))
	}
	snapshot.Digests["database.sql"] = dbHash
	snapshot.SizeBytes += dbSize
	return snapshot, true, nil
}

func sameArtifacts(s *Snapshot, current map[string]string) bool {
	if len(s.Digests) != len(current)+1 {
		return false
	}
	for name, sum := range current {
		if s.Digests[name] != sum {
			return false
		}
	}
	return true
}

func snapshotPath(root, id string) (string, error) {
	if !managedBackupNamePattern.MatchString(id) {
		return "", fmt.Errorf("备份编号非法")
	}
	root, err := validateExistingBackupRoot(root)
	if err != nil {
		return "", err
	}
	return validateExistingBackupRoot(filepath.Join(root, id))
}

func readSnapshot(root, id string) (*Snapshot, error) {
	dir, err := snapshotPath(root, id)
	if err != nil {
		return nil, err
	}
	manifest := filepath.Join(dir, snapshotManifest)
	if info, err := os.Lstat(manifest); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("备份记录不可用: %s", id)
	}
	raw, err := os.ReadFile(manifest)
	if err != nil {
		return nil, err
	}
	var s Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	if !s.HasJar || !s.HasAdminDist || !s.HasWebDist || s.Version == "" {
		return nil, fmt.Errorf("备份缺少完整三端")
	}
	s.Dir = dir
	s.DBDumpFile = filepath.Join(dir, "database.sql")
	return &s, nil
}

func Load(root, id string) (*Snapshot, error) {
	s, err := readSnapshot(root, id)
	if err != nil {
		return nil, err
	}
	names := []string{"aid-admin.jar", "admin-dist", "web-dist", "database.sql"}
	if s.HasBuildInfo {
		names = append(names, "build-info.json")
	}
	for _, name := range names {
		sum, size, err := digest(filepath.Join(s.Dir, name))
		if err != nil || size == 0 || s.Digests[name] != sum {
			return nil, fmt.Errorf("备份文件校验失败: %s (%v)", name, err)
		}
	}
	return s, nil
}

func List(root string) []Entry {
	validRoot, err := validateExistingBackupRoot(root)
	if err != nil {
		return []Entry{}
	}
	entries, err := os.ReadDir(validRoot)
	if err != nil {
		return []Entry{}
	}
	items := make([]Entry, 0)
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if !entry.IsDir() {
			continue
		}
		s, err := readSnapshot(validRoot, entry.Name())
		if err == nil {
			items = append(items, Entry{entry.Name(), s.Version, s.CreatedAt.Format("2006-01-02T15:04:05Z07:00"), s.Dir, s.SizeBytes})
		}
	}
	return items
}

func Discard(root string, s *Snapshot) error {
	dir, err := snapshotPath(root, filepath.Base(s.Dir))
	if err != nil {
		return err
	}
	if dir != s.Dir {
		return fmt.Errorf("备份目录超出当前任务范围: %s", s.Dir)
	}
	return os.RemoveAll(dir)
}

// DiscardIncomplete removes only uncommitted directories for this claimed task.
func DiscardIncomplete(root, taskID string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	var cleanupErr error
	for _, entry := range entries {
		_, tag, ok := strings.Cut(entry.Name(), "-")
		if !ok || !entry.IsDir() || (!strings.HasPrefix(tag, "upgrade-"+taskID+"-") && !strings.HasPrefix(tag, "rollback-"+taskID+"-")) {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if _, err := os.Lstat(filepath.Join(path, snapshotManifest)); os.IsNotExist(err) {
			cleanupErr = errors.Join(cleanupErr, Discard(root, &Snapshot{Dir: path}))
		}
	}
	return cleanupErr
}

// Retain commits the protection snapshot, then rotates only managed, committed backups.
func Retain(root string, s *Snapshot, keep int) error {
	dir, err := snapshotPath(root, filepath.Base(s.Dir))
	if err != nil {
		return err
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".snapshot-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(raw)
	if err := errors.Join(writeErr, tmp.Sync(), tmp.Close()); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, snapshotManifest)); err != nil {
		return err
	}
	entries := List(root)
	id := filepath.Base(s.Dir)
	index := slices.IndexFunc(entries, func(e Entry) bool { return e.ID == id })
	if index < 0 {
		return fmt.Errorf("已提交的备份无法读取: %s", id)
	}
	entries[0], entries[index] = entries[index], entries[0]
	var cleanupErr error
	for _, entry := range entries[min(len(entries), max(1, keep)):] {
		cleanupErr = errors.Join(cleanupErr, Discard(root, &Snapshot{Dir: entry.Path}))
	}
	return cleanupErr
}
