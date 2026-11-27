'use client'

import { Button, Modal, Tag } from 'antd'
import { AimOutlined } from '@ant-design/icons'
import { StudioWorkspaceModalProvider } from '@/components/studio/shell/StudioWorkspaceModalProvider'
import type { StudioGroupImageExecution } from '@/hooks/studio/executeStudioGroupImages'
import './studio-group-execution.css'

const statusLabels = {
  pending: '等待执行',
  running: '执行中',
  completed: '已完成',
  accepted: '已受理',
  failed: '失败'
}

const statusColors = { pending: 'default', running: 'processing', completed: 'success', accepted: 'processing', failed: 'error' }

export function StudioGroupExecutionDialog({
  open, groupTitle, rows, running, onClose, onLocate
}: {
  open: boolean
  groupTitle: string
  rows: StudioGroupImageExecution[]
  running: boolean
  onClose: () => void
  onLocate: (nodeId: string) => void
}) {
  const completed = rows.filter(row => row.status === 'completed').length
  const accepted = rows.filter(row => row.status === 'accepted').length
  const failed = rows.filter(row => row.status === 'failed').length

  return (
    <StudioWorkspaceModalProvider>
      <Modal open={open} width={520} title="整组执行结果" footer={null} onCancel={onClose}>
        <div className="studio-group-execution" onPointerDown={event => event.stopPropagation()}>
          <div className="studio-group-execution__summary" role="status">
            <strong>{groupTitle || '图片分组'}</strong>
            <span>{rows.length} 个图片节点 · 完成 {completed} · 已受理 {accepted} · 失败 {failed}{running ? ' · 执行中' : ''}</span>
          </div>
          <ul className="studio-group-execution__list" aria-label="图片节点执行结果">
            {rows.map((row) => (
              <li className="studio-group-execution__row" key={row.id}>
                <div>
                  <div className="studio-group-execution__name">{row.title}</div>
                  {row.reason ? <div className="studio-group-execution__reason">{row.reason}</div> : null}
                </div>
                <Tag color={statusColors[row.status]}>{statusLabels[row.status]}</Tag>
                <Button
                  type="text"
                  size="small"
                  icon={<AimOutlined />}
                  aria-label={`定位节点：${row.title}`}
                  onClick={() => onLocate(row.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </StudioWorkspaceModalProvider>
  )
}
