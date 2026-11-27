'use client'

import { ExclamationCircleOutlined } from '@ant-design/icons'
import { useId, useState, type ReactNode } from 'react'
import type { VideoQuoteReferenceIssue } from '@/utils/canvas/canvasVideoQuoteReferenceIssues'

export type VideoReferenceIssueGroup = {
  resourceId: string
  index: number
  issues: VideoQuoteReferenceIssue[]
}

function describe(issue: VideoQuoteReferenceIssue) {
  const value = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(issue.actual)
  if (issue.kind === 'FILE_SIZE') return `文件过大 · ${value} MB，最大 ${issue.maximum} MB`
  const limit = issue.minimum != null && issue.actual < issue.minimum
    ? `最低 ${issue.minimum}:1` : `最高 ${issue.maximum}:1`
  return `比例超限 · ${value}:1，${limit}（${issue.width} × ${issue.height}）`
}

export function StudioVideoReferenceErrors({ groups, onLocate, renderAction }: {
  groups: VideoReferenceIssueGroup[]
  onLocate: (resourceId: string) => void
  renderAction: (group: VideoReferenceIssueGroup) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const overflow = groups.length - 2
  return (
    <section className="studio-composer-reference-errors" aria-label="参考图校验">
      <div className="studio-composer-reference-errors__heading" role="status">
        <ExclamationCircleOutlined aria-hidden /> {groups.length} 张参考图需要调整
      </div>
      <ul id={listId}>
        {(expanded ? groups : groups.slice(0, 2)).map(group => (
          <li key={group.resourceId}>
            <button type="button" className="studio-composer-reference-errors__locate"
              onClick={() => onLocate(group.resourceId)}>第 {group.index} 张</button>
            <span>{group.issues.map(describe).join('；')}</span>
            {renderAction(group)}
          </li>
        ))}
      </ul>
      {overflow > 0 && <button type="button" aria-controls={listId} aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `查看全部（${groups.length} 张）`}</button>}
    </section>
  )
}
