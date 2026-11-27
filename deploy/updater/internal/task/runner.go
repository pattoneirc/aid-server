package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"aid-updater/internal/backup"
	"aid-updater/internal/config"
	"aid-updater/internal/health"
	"aid-updater/internal/sysctl"
)

// Runner 消费任务文件并执行升级动作。
type Runner struct {
	cfg      *config.Config
	reporter *health.Reporter
	version  string
	// exitRequested 自升级成功后置位，主循环据此退出进程交由 systemd 拉起新版本
	exitRequested    bool
	cancelMu         sync.Mutex
	activeTaskID     string
	cancellationOpen bool
	activeTaskCancel context.CancelFunc
	lastRecoveryScan time.Time
}

var errTaskCancelled = errors.New("升级已由管理员取消")

type cancelRequest struct {
	TaskID string `json:"taskId"`
}

// NewRunner 创建任务执行器。
func NewRunner(cfg *config.Config, reporter *health.Reporter, version string) *Runner {
	return &Runner{cfg: cfg, reporter: reporter, version: version}
}

// ExitRequested 返回是否需要退出进程（自升级完成后）。
func (r *Runner) ExitRequested() bool {
	return r.exitRequested
}

// reportProgress 同步任务阶段到健康文件并写入统一日志，供后台与 aid.sh 实时展示。
func (r *Runner) reportProgress(t *Task, progress int, phase, message string) {
	log.Printf("[进度 %d%%] %s: %s", progress, phase, message)
	r.reporter.SetTaskProgress(t.TaskID, t.Action, progress, phase, message)
}

// RecoverInterrupted 启动时优先恢复中断任务的文件与数据库，再清理认领文件。
func (r *Runner) RecoverInterrupted() {
	release, err := r.lockDeployment()
	if err != nil {
		log.Printf("暂缓恢复检查: %v", err)
		return
	}
	defer release()
	recoveryPattern := filepath.Join(r.cfg.WorkDir, "recovery-*.json")
	recoveryFiles, _ := filepath.Glob(recoveryPattern)
	for _, path := range recoveryFiles {
		record, loadErr := r.loadRecovery(path)
		if loadErr != nil {
			log.Printf("读取中断恢复记录失败 %s: %v", path, loadErr)
			continue
		}
		if record.Completed {
			if len(record.Snapshot.Digests) > 0 {
				if err := r.finishVersionChange(&record.Task, path, record.Snapshot); err != nil {
					log.Printf("继续备份轮换失败: %v", err)
				}
				continue
			}
			if err := os.Remove(path); err != nil {
				log.Printf("清理已完成任务的恢复记录失败: %v", err)
			}
			continue
		}
		if record.Preparing {
			if err := r.finishInterruptedPreparation(path, record.Task.TaskID); err != nil {
				log.Printf("恢复备份阶段中断失败: %v", err)
			}
			continue
		}
		log.Printf("恢复中断任务 %s(%s)", record.Task.TaskID, record.Task.Action)
		restoreErr := r.restoreVersion(record.Snapshot, record.DatabaseDirty)
		if restoreErr != nil {
			log.Printf("中断任务恢复失败，保留恢复记录等待人工处理: %v", restoreErr)
			r.reporter.SetTask(record.Task.TaskID, record.Task.Action, health.TaskStateFailed,
				trimMessage("升级中断且自动恢复失败: "+restoreErr.Error()))
			continue
		}
		r.reporter.SetTask(record.Task.TaskID, record.Task.Action, health.TaskStateFailed,
			"升级器中断，已自动恢复原版本")
		if err := os.Remove(path); err != nil {
			log.Printf("清理恢复记录失败: %v", err)
		} else if record.CreatedSnapshot {
			if err := backup.Discard(r.cfg.BackupDir, record.Snapshot); err != nil {
				log.Printf("清理中断任务创建的备份失败: %v", err)
			}
		}
	}

	pattern := filepath.Join(r.cfg.WorkDir, "claimed-*.json")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		log.Printf("扫描中断任务文件失败: %v", err)
		matches = nil
	}
	for _, path := range matches {
		t, err := Parse(path)
		if err != nil {
			log.Printf("读取中断任务认领记录失败，保留待检查: %s: %v", path, err)
			continue
		}
		if filepath.Base(path) != "claimed-"+t.TaskID+".json" {
			log.Printf("认领记录与任务编号不一致，保留待检查: %s", path)
			continue
		}
		log.Printf("发现中断任务 %s(%s)，标记为失败", t.TaskID, t.Action)
		if err := r.cleanupVersionTaskWork(t); err != nil {
			log.Printf("清理中断任务产物失败，保留认领记录以便下次恢复: %v", err)
			r.reporter.SetTask(t.TaskID, t.Action, health.TaskStateFailed, trimMessage(err.Error()))
			continue
		}
		r.reporter.SetTask(t.TaskID, t.Action, health.TaskStateFailed,
			"任务因升级器中断未完成，请确认系统状态后重新发起")
		if err := os.Remove(path); err != nil {
			log.Printf("清理中断任务文件失败: %v", err)
		}
	}
	// 任务进程异常退出时可能遗留提交锁。恢复记录与已认领任务处理完后再清理，
	// 让后端可以重新投递；若 inbox 中仍有原任务，下一轮会重新认领。
	if err := os.Remove(r.taskRunningMarker()); err != nil && !os.IsNotExist(err) {
		log.Printf("清理中断任务提交锁失败: %v", err)
	}
}

func (r *Runner) finishInterruptedPreparation(path, taskID string) error {
	if err := startBackend(r.cfg); err != nil {
		return err
	}
	if err := sysctl.WaitHealthy(r.cfg.Install.HealthCheckURL, time.Duration(r.cfg.Install.HealthCheckTimeoutSeconds)*time.Second); err != nil {
		return err
	}
	if err := backup.DiscardIncomplete(r.cfg.BackupDir, taskID); err != nil {
		return err
	}
	return os.Remove(path)
}

// PollOnce 检查任务文件，存在则认领并执行；返回是否执行了任务。
func (r *Runner) PollOnce() bool {
	if time.Since(r.lastRecoveryScan) >= 15*time.Second {
		r.lastRecoveryScan = time.Now()
		if claims, _ := filepath.Glob(filepath.Join(r.cfg.WorkDir, "claimed-cli-*.json")); len(claims) != 0 {
			r.RecoverInterrupted()
		}
	}
	if pending, _ := filepath.Glob(filepath.Join(r.cfg.WorkDir, "recovery-*.json")); len(pending) != 0 {
		log.Printf("存在待处理的版本恢复记录，暂停接收任务: %s", pending[0])
		return false
	}
	if err := r.recoverNginx(); err != nil {
		log.Printf("Nginx中断恢复失败，暂停接收任务: %v", err)
		return false
	}
	if _, err := os.Stat(r.cfg.TaskFile); err != nil {
		return false
	}
	claimed, err := r.claim()
	if err != nil {
		log.Printf("认领任务失败: %v", err)
		return false
	}
	defer func() {
		if err := os.Remove(claimed); err != nil && !os.IsNotExist(err) {
			log.Printf("清理任务文件失败: %v", err)
		}
		if err := os.Remove(r.taskRunningMarker()); err != nil && !os.IsNotExist(err) {
			log.Printf("清理任务提交锁失败: %v", err)
		}
	}()

	t, err := Parse(claimed)
	if err != nil {
		log.Printf("任务解析失败: %v", err)
		r.reporter.SetTask("unknown", "UNKNOWN", health.TaskStateFailed, fmt.Sprintf("任务解析失败: %v", err))
		return true
	}

	log.Printf("开始执行任务 %s: %s %s -> %s", t.TaskID, t.Action, t.SourceVersion, t.TargetVersion)
	r.reporter.SetTask(t.TaskID, t.Action, health.TaskStateRunning, "任务执行中")
	r.reportProgress(t, 1, "任务已受理", "升级器已认领任务，正在准备执行")

	var runErr error
	switch t.Action {
	case ActionUpgrade, ActionRollback, ActionBackupSettings:
		release, err := r.lockDeployment()
		if err != nil {
			runErr = err
			break
		}
		defer release()
		if t.Action == ActionBackupSettings {
			runErr = r.configureBackups(t)
		} else {
			runErr = r.runCancellableApply(t, t.Action == ActionRollback)
		}
	case ActionUpdaterUpgrade:
		runErr = r.runSelfUpgrade(t)
	case ActionConfigValidate:
		runErr = r.runConfigValidate(t)
	case ActionNginxValidate, ActionNginxApply, ActionNginxRollback:
		runErr = r.runNginx(t)
	case ActionConfigApply:
		runErr = r.runConfigApply(t)
	case ActionConfigRollback:
		runErr = r.runConfigRollback()
	case ActionConfigTest:
		runErr = r.runConfigTest(t)
	case ActionCertInstall:
		runErr = r.runCertificateInstall(t)
	}

	if runErr != nil {
		if errors.Is(runErr, errTaskCancelled) {
			log.Printf("任务 %s 已取消", t.TaskID)
			r.reporter.SetTask(t.TaskID, t.Action, health.TaskStateCancelled, errTaskCancelled.Error())
			return true
		}
		log.Printf("任务 %s 执行失败: %v", t.TaskID, runErr)
		r.reporter.SetTask(t.TaskID, t.Action, health.TaskStateFailed, trimMessage(runErr.Error()))
		return true
	}
	if t.Action == ActionUpdaterUpgrade {
		// 先交接目标版本；systemd/Docker 拉起的新进程核验后才报告成功。
		r.reporter.SetRestartPending(t.TaskID, t.TargetVersion)
		r.exitRequested = true
		return true
	}
	log.Printf("任务 %s 执行成功", t.TaskID)
	message := fmt.Sprintf("已完成 %s -> %s", t.SourceVersion, t.TargetVersion)
	switch t.Action {
	case ActionBackupSettings:
		message = "备份路径和保留份数已验证并保存"
	case ActionConfigValidate:
		message = "配置校验通过"
	case ActionConfigApply:
		message = "配置已应用并完成重启"
	case ActionConfigRollback:
		message = "已恢复上一份配置并完成重启"
	case ActionConfigTest:
		message = "配置诊断已完成"
	case ActionCertInstall:
		message = "HTTPS证书已安全安装，请应用配置后生效"
	case ActionNginxValidate:
		message = "Nginx候选配置校验通过，未保存或重载"
	case ActionNginxApply:
		message = "Nginx配置已保存并请求平滑重载，请核验站点入口"
	case ActionNginxRollback:
		message = "已恢复上次Nginx配置并请求平滑重载"
	}
	r.reporter.SetTask(t.TaskID, t.Action, health.TaskStateSuccess, message)
	return true
}

// claim 先创建后端可见的运行锁，再把任务原子移入工作目录，堵住“已认领但
// 健康文件尚未来得及写 RUNNING”的极短窗口，避免第二个任务覆盖升级过程。
func (r *Runner) claim() (string, error) {
	if err := os.MkdirAll(r.cfg.WorkDir, 0o755); err != nil {
		return "", fmt.Errorf("创建工作目录失败: %w", err)
	}
	marker := r.taskRunningMarker()
	markerFile, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("创建任务提交锁失败: %w", err)
	}
	if closeErr := markerFile.Close(); closeErr != nil {
		_ = os.Remove(marker)
		return "", fmt.Errorf("写入任务提交锁失败: %w", closeErr)
	}
	claimed := filepath.Join(r.cfg.WorkDir, fmt.Sprintf("claimed-%d.json", time.Now().UnixNano()))
	if err := os.Rename(r.cfg.TaskFile, claimed); err != nil {
		_ = os.Remove(marker)
		return "", fmt.Errorf("移动任务文件失败: %w", err)
	}
	return claimed, nil
}

func (r *Runner) taskRunningMarker() string {
	return r.cfg.TaskFile + ".running"
}

func (r *Runner) taskCancelFile() string {
	return r.cfg.TaskFile + ".cancel"
}

func (r *Runner) runCancellableApply(t *Task, isRollback bool) error {
	ctx, cancel := context.WithCancel(context.Background())
	r.cancelMu.Lock()
	r.activeTaskID = t.TaskID
	r.cancellationOpen = true
	r.activeTaskCancel = cancel
	r.cancelMu.Unlock()
	r.reporter.SetTaskCancellation(t.TaskID, true, false)
	_ = os.Remove(r.taskCancelFile())

	done := make(chan struct{})
	watcherDone := make(chan struct{})
	go r.watchCancellation(t, done, watcherDone)
	runErr := r.runApply(ctx, t, isRollback)
	r.cancelMu.Lock()
	r.cancellationOpen = false
	r.cancelMu.Unlock()
	close(done)
	<-watcherDone
	cancel()
	r.cancelMu.Lock()
	r.activeTaskID = ""
	r.cancellationOpen = false
	r.activeTaskCancel = nil
	r.cancelMu.Unlock()
	_ = os.Remove(r.taskCancelFile())
	return runErr
}

func (r *Runner) watchCancellation(t *Task, done <-chan struct{}, watcherDone chan<- struct{}) {
	defer close(watcherDone)
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			r.consumeCancellationRequest(t)
		}
	}
}

func (r *Runner) consumeCancellationRequest(t *Task) bool {
	path := r.taskCancelFile()
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	defer os.Remove(path)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > 4096 {
		log.Printf("忽略非法升级取消请求: %s", path)
		return false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Printf("读取升级取消请求失败: %v", err)
		return false
	}
	var request cancelRequest
	if err := json.Unmarshal(raw, &request); err != nil || strings.TrimSpace(request.TaskID) != t.TaskID {
		log.Printf("忽略不匹配的升级取消请求")
		return false
	}

	r.cancelMu.Lock()
	accepted := r.activeTaskID == t.TaskID && r.cancellationOpen && r.activeTaskCancel != nil
	cancel := r.activeTaskCancel
	if accepted {
		r.cancellationOpen = false
	}
	r.cancelMu.Unlock()
	if !accepted {
		log.Printf("任务 %s 已进入不可取消阶段，忽略取消请求", t.TaskID)
		return false
	}
	r.reporter.SetTaskCancellation(t.TaskID, false, true)
	log.Printf("任务 %s 已收到取消请求，正在安全停止当前阶段", t.TaskID)
	cancel()
	return true
}

func (r *Runner) closeCancellationWindow(ctx context.Context, t *Task) error {
	if r.consumeCancellationRequest(t) {
		return errTaskCancelled
	}
	if err := contextCancellationError(ctx); err != nil {
		return err
	}
	r.cancelMu.Lock()
	if r.activeTaskID == t.TaskID {
		r.cancellationOpen = false
	}
	r.cancelMu.Unlock()
	r.reporter.SetTaskCancellation(t.TaskID, false, false)
	return nil
}

func contextCancellationError(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return errTaskCancelled
	}
	return ctx.Err()
}

func (r *Runner) cleanupVersionTaskWork(t *Task) error {
	if !taskIDPattern.MatchString(t.TaskID) {
		return fmt.Errorf("无法安全清理任务产物，任务 ID 格式错误")
	}
	switch t.Action {
	case ActionUpgrade, ActionRollback:
		files := []string{"pkg-" + t.TaskID + ".tar.gz", "pkg-" + t.TaskID + ".tar.gz.part",
			"pkg-" + t.TaskID + ".tar.gz.part.sha256", "extract-" + t.TaskID, "source-" + t.TaskID,
			"source-builder-" + t.TaskID + ".sh", "source-builder-" + t.TaskID + ".sh.part"}
		if strings.HasPrefix(t.TaskID, "cli-") {
			files = append(files, t.TaskID+".json")
		}
		return cleanupWork(r.cfg.WorkDir, files...)
	case ActionUpdaterUpgrade:
		return cleanupWork(r.cfg.WorkDir, "updater-"+t.TaskID+".tar.gz", "updater-"+t.TaskID+".tar.gz.part",
			"updater-extract-"+t.TaskID)
	default:
		return nil
	}
}

func cleanupWork(root string, names ...string) error {
	if _, err := os.Lstat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("检查升级器工作目录失败: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil || resolvedRoot != filepath.Clean(root) {
		return fmt.Errorf("升级器工作目录不是实际路径: %s", root)
	}
	var cleanupErr error
	for _, name := range names {
		path := filepath.Join(root, name)
		if err := os.RemoveAll(path); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("清理工作产物失败 %s: %w", path, err))
		}
	}
	return cleanupErr
}

// restoreAndReport 升级失败后还原备份并重启服务，返回给用户的失败说明。
func (r *Runner) restoreAndReport(t *Task, s *backup.Snapshot, cause error, recoveryPath string, databaseDirty bool) error {
	log.Printf("开始回滚: 原因=%v", cause)
	r.reportProgress(t, 95, "自动恢复", "升级失败，正在恢复升级前版本")
	if err := r.restoreVersion(s, databaseDirty); err != nil {
		return fmt.Errorf("版本切换失败(%v)，自动恢复失败(%v)，保护备份: %s", cause, err, s.Dir)
	}
	if recoveryPath != "" {
		if err := os.Remove(recoveryPath); err != nil && !os.IsNotExist(err) {
			log.Printf("清理恢复记录失败: %v", err)
		}
	}
	return fmt.Errorf("升级失败已自动回滚到原版本(%v)", cause)
}

func (r *Runner) restoreVersion(s *backup.Snapshot, databaseDirty bool) error {
	if err := sysctl.StopService(r.cfg.Install.ServiceManager, r.cfg.Install.BackendService); err != nil {
		return err
	}
	if databaseDirty {
		if err := backup.RestoreDatabase(r.cfg, s); err != nil {
			return err
		}
	}
	if err := backup.Restore(r.cfg, s); err != nil {
		return err
	}
	if err := startBackend(r.cfg); err != nil {
		return err
	}
	if err := sysctl.WaitHealthy(r.cfg.Install.HealthCheckURL, time.Duration(r.cfg.Install.HealthCheckTimeoutSeconds)*time.Second); err != nil {
		return err
	}
	return restartAuxServices(r.cfg)
}
func trimMessage(message string) string {
	const maxLen = 500
	message = strings.TrimSpace(message)
	// 按字符截断，避免切坏多字节 UTF-8
	if runes := []rune(message); len(runes) > maxLen {
		return string(runes[:maxLen])
	}
	return message
}
