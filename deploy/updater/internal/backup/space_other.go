//go:build !linux

package backup

func checkDiskSpace(_ string, _ uint64) error { return nil }
