'use client'

import type { ReactNode } from 'react'
import { Modal } from 'antd'
import './audio-picker-modal.css'

export function AudioPickerModal({
  open,
  title,
  className,
  wrapClassName,
  compact = false,
  onCancel,
  children
}: {
  open: boolean
  title: string
  className: string
  wrapClassName: string
  compact?: boolean
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <Modal
      open={open}
      title={title}
      width={compact ? 'min(520px, calc(100vw - 32px))' : 'min(860px, calc(100vw - 32px))'}
      footer={null}
      destroyOnHidden
      wrapClassName={wrapClassName}
      className={`audio-picker-modal ${className}`}
      centered
      onCancel={onCancel}
    >
      {children}
    </Modal>
  )
}
