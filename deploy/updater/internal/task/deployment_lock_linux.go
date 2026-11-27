package task

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func (r *Runner) lockDeployment() (func(), error) {
	release, err := r.lockOnDisk(".aid-deployment.lock")
	if err != nil {
		return nil, err
	}
	releaseVersion, err := r.lockLocalVersion()
	if err != nil {
		release()
		return nil, err
	}
	return func() { releaseVersion(); release() }, nil
}

// A Docker CLI worker can outlive the host shell that started docker exec.
func (r *Runner) lockLocalVersion() (func(), error) {
	return r.lockOnDisk(".aid-version-execution.lock")
}

func (r *Runner) lockOnDisk(name string) (func(), error) {
	root := filepath.Join(filepath.Dir(filepath.Dir(r.cfg.Install.BackendJar)), "source-build")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || resolved != root {
		return nil, fmt.Errorf("部署锁所在路径非法: %s", root)
	}
	fd, err := syscall.Open(filepath.Join(root, name),
		syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("另一项部署任务正在运行: %w", err)
	}
	return func() { _ = syscall.Close(fd) }, nil
}
