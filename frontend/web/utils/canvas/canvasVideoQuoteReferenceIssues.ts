import { canvasQuoteErrorData } from './canvasQuoteMetadataRecovery'

export type VideoQuoteReferenceIssue = {
  resourceId: string
  index: number
  kind: 'ASPECT_RATIO' | 'FILE_SIZE'
  actual: number
  minimum?: number | null
  maximum?: number | null
  width: number
  height: number
}

export function videoQuoteReferenceIssues(reason: unknown): VideoQuoteReferenceIssue[] {
  const data = canvasQuoteErrorData(reason)
  if (!Array.isArray(data?.referenceImageIssues)) return []
  return data.referenceImageIssues.filter((item): item is VideoQuoteReferenceIssue =>
    item != null && typeof item.resourceId === 'string' && /^\d+$/.test(item.resourceId)
    && Number.isInteger(item.index) && item.index > 0 && Number.isFinite(item.actual)
    && (item.kind === 'ASPECT_RATIO' || item.kind === 'FILE_SIZE'))
}
