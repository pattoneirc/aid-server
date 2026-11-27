package task

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"aid-updater/internal/backup"
	"aid-updater/internal/health"
	"aid-updater/internal/sysctl"
)

type backupSettings struct {
	Directory string `json:"directory"`
	Keep      int    `json:"keep"`
}

func (r *Runner) backupSettingsPath() string {
	return filepath.Join(filepath.Dir(r.cfg.HealthFile), "backup-settings.json")
}

// RefreshBackups publishes a read-only inventory beside the updater health file.
func (r *Runner) RefreshBackups() error {
	path := filepath.Join(filepath.Dir(r.cfg.HealthFile), "version-backups.json")
	if err := writeJSONAtomic(path, struct {
		Directory string         `json:"directory"`
		Keep      int            `json:"keep"`
		Backups   []backup.Entry `json:"backups"`
	}{r.cfg.BackupDir, r.cfg.KeepBackups, backup.List(r.cfg.BackupDir)}); err != nil {
		return err
	}
	return os.Chmod(path, 0o644)
}

// RunLocal is the root-operated command line entry point. The manager holds
// the deployment lock and checks local packages before invoking the updater.
func (r *Runner) RunLocal(ctx context.Context, localPackage, id, current, target string) (result error) {
	release, err := r.lockLocalVersion()
	if err != nil {
		return err
	}
	defer release()
	if _, err := os.Stat(r.cfg.TaskFile); err == nil {
		return fmt.Errorf("升级器已有待处理任务")
	}
	if pending, _ := filepath.Glob(filepath.Join(r.cfg.WorkDir, "recovery-*.json")); len(pending) != 0 {
		return fmt.Errorf("存在待处理的版本恢复记录: %s", pending[0])
	}
	if pending, _ := filepath.Glob(filepath.Join(r.cfg.WorkDir, "claimed-cli-*.json")); len(pending) != 0 {
		return fmt.Errorf("上次命令行版本切换正在等待恢复: %s", pending[0])
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	t := &Task{
		SchemaVersion: SupportedSchemaVersion,
		TaskID:        fmt.Sprintf("cli-%x", random),
		Action:        ActionUpgrade,
		SourceVersion: current,
		TargetVersion: target,
		RequestedAt:   time.Now().UTC().Format(time.RFC3339),
		BackupID:      id,
		localPackage:  localPackage,
	}
	if id != "" {
		snapshot, err := backup.Load(r.cfg.BackupDir, id)
		if err != nil {
			return err
		}
		t.TargetVersion, t.Action = snapshot.Version, ActionRollback
	}
	claim := filepath.Join(r.cfg.WorkDir, "claimed-"+t.TaskID+".json")
	if err := writeJSONAtomic(claim, t); err != nil {
		return err
	}
	defer func() {
		if err := r.cleanupVersionTaskWork(t); err != nil {
			result = errors.Join(result, err)
			return
		}
		result = errors.Join(result, os.Remove(claim))
	}()
	status := filepath.Join(r.cfg.WorkDir, t.TaskID+".json")
	r.reporter = health.NewReporter(status, r.version, r.cfg.Install.ServiceManager)
	return r.runApply(ctx, t, id != "")
}

func (r *Runner) LoadBackupSettings() error {
	raw, err := os.ReadFile(r.backupSettingsPath())
	if os.IsNotExist(err) {
		// Previous installers explicitly wrote the former default of three.
		if r.cfg.KeepBackups == 3 {
			r.cfg.KeepBackups = 1
		}
		return nil
	}
	if err != nil {
		return err
	}
	var s backupSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if !filepath.IsAbs(s.Directory) || s.Keep < 1 || s.Keep > 50 {
		return fmt.Errorf("已保存的备份配置无效")
	}
	r.cfg.BackupDir, r.cfg.KeepBackups = s.Directory, s.Keep
	return nil
}

func (r *Runner) configureBackups(t *Task) error {
	path := filepath.Clean(strings.TrimSpace(t.BackupDir))
	if t.KeepBackups < 1 || t.KeepBackups > 50 {
		return fmt.Errorf("备份保留份数需在 1 到 50 之间")
	}
	for _, protected := range []string{r.cfg.WorkDir, filepath.Dir(r.cfg.Install.BackendJar), filepath.Dir(r.cfg.TaskFile)} {
		rel, err := filepath.Rel(protected, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, "../") {
			return fmt.Errorf("备份目录不能位于程序、任务或临时工作目录: %s", path)
		}
	}
	if err := backup.ValidateDirectory(path); err != nil {
		return fmt.Errorf("备份目录 %s 校验失败: %w", path, err)
	}
	if r.cfg.Install.ServiceManager == "docker" {
		// A directory in the container overlay disappears upon container replacement.
		out, err := exec.Command("docker", "inspect", "--format", "{{json .Mounts}}", "aid-updater").Output()
		if err != nil {
			return fmt.Errorf("无法验证升级器宿主机挂载: %w", err)
		}
		var mounts []struct {
			Type, Source, Destination string
			RW                        bool
		}
		if err := json.Unmarshal(out, &mounts); err != nil {
			return err
		}
		matched := false
		mountLength := 0
		for _, mount := range mounts {
			rel, err := filepath.Rel(mount.Destination, path)
			if err == nil && rel != ".." && !strings.HasPrefix(rel, "../") && len(mount.Destination) > mountLength {
				matched = mount.RW && mount.Type == "bind" && mount.Destination == mount.Source
				mountLength = len(mount.Destination)
			}
		}
		if !matched {
			return fmt.Errorf("备份路径需要升级器容器的同路径可写宿主机挂载: %s", path)
		}
	}
	if err := writeJSONAtomic(r.backupSettingsPath(), backupSettings{path, t.KeepBackups}); err != nil {
		return err
	}
	r.cfg.BackupDir, r.cfg.KeepBackups = path, t.KeepBackups
	return r.RefreshBackups()
}

func (r *Runner) beginVersionChange(t *Task, label string) (*backup.Snapshot, string, bool, error) {
	if err := backup.ValidateDirectory(r.cfg.BackupDir); err != nil {
		return nil, "", false, fmt.Errorf("已中止版本切换，备份目录 %s 不可用: %w", r.cfg.BackupDir, err)
	}
	path, err := r.createRecovery(t, nil, false)
	if err != nil {
		return nil, "", false, err
	}
	r.reportProgress(t, 60, "创建备份", "暂停后端写入，校验或备份当前三端和数据库")
	if err := sysctl.StopService(r.cfg.Install.ServiceManager, r.cfg.Install.BackendService); err != nil {
		return nil, "", false, r.cancelVersionPreparation(path, fmt.Errorf("已中止版本切换，停止后端失败: %w", err))
	}
	snapshot, created, err := backup.Capture(r.cfg, label+"-"+t.TaskID, t.SourceVersion)
	if err != nil {
		return nil, "", false, r.cancelVersionPreparation(path, fmt.Errorf("备份未通过，已中止版本切换: %w", err))
	}
	_, err = r.createRecovery(t, snapshot, created)
	if err != nil {
		if created {
			err = errors.Join(err, backup.Discard(r.cfg.BackupDir, snapshot))
		}
		return nil, "", false, r.cancelVersionPreparation(path, err)
	}
	if created {
		logBackup := "已备份并校验当前三端和数据库"
		r.reportProgress(t, 67, "创建备份", logBackup)
	} else {
		r.reportProgress(t, 67, "复用备份", "已确认现有备份与当前三端和数据库一致")
	}
	return snapshot, path, created, nil
}

func (r *Runner) cancelVersionPreparation(path string, cause error) error {
	if err := startBackend(r.cfg); err != nil {
		return errors.Join(cause, err)
	}
	if err := sysctl.WaitHealthy(r.cfg.Install.HealthCheckURL, time.Duration(r.cfg.Install.HealthCheckTimeoutSeconds)*time.Second); err != nil {
		return errors.Join(cause, err)
	}
	return errors.Join(cause, os.Remove(path))
}

func (r *Runner) discardFailedSnapshot(result error, journal string, snapshot *backup.Snapshot, created bool) error {
	if result == nil || !created {
		return nil
	}
	if _, err := os.Lstat(journal); !os.IsNotExist(err) {
		return nil
	}
	return backup.Discard(r.cfg.BackupDir, snapshot)
}

func (r *Runner) completeVersionChange(t *Task, journal string, snapshot *backup.Snapshot, dirty bool) error {
	if err := markRecoveryCompleted(journal); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, dirty)
	}
	return r.finishVersionChange(t, journal, snapshot)
}

func (r *Runner) finishVersionChange(t *Task, journal string, snapshot *backup.Snapshot) error {
	keep := r.cfg.KeepBackups
	if t.KeepBackups > 0 && t.KeepBackups <= 50 {
		keep = t.KeepBackups
	}
	if err := backup.Retain(r.cfg.BackupDir, snapshot, keep); err != nil {
		return fmt.Errorf("版本已切换，备份轮换失败: %w", err)
	}
	if err := r.RefreshBackups(); err != nil {
		return fmt.Errorf("版本已切换，刷新备份列表失败: %w", err)
	}
	return os.Remove(journal)
}

func (r *Runner) switchBackup(ctx context.Context, t *Task) (result error) {
	target, err := backup.Load(r.cfg.BackupDir, t.BackupID)
	if err != nil {
		return fmt.Errorf("目标备份未通过校验: %w", err)
	}
	if target.Version != t.TargetVersion {
		return fmt.Errorf("目标备份版本与任务不一致")
	}
	if err := r.closeCancellationWindow(ctx, t); err != nil {
		return err
	}
	snapshot, journal, created, err := r.beginVersionChange(t, "rollback")
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, r.discardFailedSnapshot(result, journal, snapshot, created)) }()
	if err := markDatabaseDirty(journal); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, false)
	}
	r.reportProgress(t, 78, "恢复备份", "正在恢复目标版本三端和数据库")
	if err := backup.RestoreDatabase(r.cfg, target); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, true)
	}
	if err := backup.Restore(r.cfg, target); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, true)
	}
	if err := startBackend(r.cfg); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, true)
	}
	if err := sysctl.WaitHealthy(r.cfg.Install.HealthCheckURL, time.Duration(r.cfg.Install.HealthCheckTimeoutSeconds)*time.Second); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, true)
	}
	if err := restartAuxServices(r.cfg); err != nil {
		return r.restoreAndReport(t, snapshot, err, journal, true)
	}
	return r.completeVersionChange(t, journal, snapshot, true)
}
