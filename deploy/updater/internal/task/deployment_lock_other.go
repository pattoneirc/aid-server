//go:build !linux

package task

import "fmt"

func (r *Runner) lockDeployment() (func(), error) {
	return nil, fmt.Errorf("版本切换需要 Linux 部署锁")
}

func (r *Runner) lockLocalVersion() (func(), error) {
	return r.lockDeployment()
}
