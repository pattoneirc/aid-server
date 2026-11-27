package backup

import (
	"fmt"
	"syscall"
)

func checkDiskSpace(path string, required uint64) error {
	var info syscall.Statfs_t
	if err := syscall.Statfs(path, &info); err != nil {
		return fmt.Errorf("无法检查备份目录 %s 的可用空间: %w", path, err)
	}
	available := uint64(info.Bsize) * info.Bavail
	if available < required {
		return fmt.Errorf("备份目录 %s 空间不足，可用 %d 字节，仅三端产物至少需要 %d 字节", path, available, required)
	}
	return nil
}
