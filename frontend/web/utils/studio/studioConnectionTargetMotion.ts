import type { StudioNodeData } from '@/types/studio'

const OPERATION_IMAGE_PURPOSES = new Set([
  'reference', 'hd', 'outpaint', 'crop', 'matting', 'erase', 'repaint',
  'grid_storyboard', 'layer_separation', 'layer_extract'
])

/** Only ordinary canvas cards advertise the connection drop motion. */
export function isStudioConnectionMotionTarget(data: StudioNodeData): boolean {
  return data.status !== 'queued'
    && data.status !== 'generating'
    && !data.flowBinding
    && !data.videoPurpose
    && !data.videoSubjectEdit
    && !data.audioEdit
    && !data.mediaDerivation
    && !data.gridStoryboardOrigin
    && !data.previzOfNodeId
    && !data.previzOfSceneId
    && !data.previzRecordMode
    && !data.operationOrigin
    && !data.operationRunId
    && !data.imageToolOptions?.sourceNodeId
    && !data.videoToolOptions?.sourceNodeId
    && !(data.kind === 'video' && data.zoneId === 'shot-production'
      && ['由3D预演时间轴真实录制，可在画布中预览和继续编辑', '由预演台时间轴真实录制，可在画布中预览和继续编辑'].includes(String(data.resultSummary)))
    && !OPERATION_IMAGE_PURPOSES.has(data.imagePurpose || '')
}

/** Pointer frames only change the hovered card's compositor styles, never the canvas store. */
export function createStudioConnectionTargetMotion(canvas: HTMLElement) {
  let target: HTMLElement | null = null
  let candidates: HTMLElement[] = []
  let frame: number | null = null
  let pointer: { x: number; y: number } | null = null

  const clearTarget = () => {
    if (!target) return
    target.classList.remove('is-connection-hover')
    const card = target.querySelector<HTMLElement>('.studio-node-card')
    card?.style.removeProperty('--studio-connection-tilt-x')
    card?.style.removeProperty('--studio-connection-tilt-y')
    target = null
  }

  const paint = () => {
    frame = null
    if (!pointer) return
    // React Flow disables node hit testing while a connection is active, so
    // elementFromPoint() sees the pane instead of the card under the pointer.
    const next = candidates.findLast((shell) => {
      if (!shell.isConnected || shell.dataset.connectionTilt !== 'true') return false
      const rect = shell.getBoundingClientRect()
      return pointer!.x >= rect.left && pointer!.x <= rect.right
        && pointer!.y >= rect.top && pointer!.y <= rect.bottom
    }) ?? null
    if (next !== target) {
      clearTarget()
      target = next
      target?.classList.add('is-connection-hover')
    }
    const card = target?.querySelector<HTMLElement>('.studio-node-card')
    if (!card) return
    const rect = card.getBoundingClientRect()
    const horizontal = Math.max(-1, Math.min(1, (pointer.x - rect.left) / rect.width * 2 - 1))
    const vertical = Math.max(-1, Math.min(1, (pointer.y - rect.top) / rect.height * 2 - 1))
    card.style.setProperty('--studio-connection-tilt-x', `${(-vertical * 2.5).toFixed(2)}deg`)
    card.style.setProperty('--studio-connection-tilt-y', `${(horizontal * 5).toFixed(2)}deg`)
  }

  const move = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY }
    if (frame === null) frame = window.requestAnimationFrame(paint)
  }

  const stop = () => {
    window.removeEventListener('pointermove', move)
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    pointer = null
    candidates = []
    clearTarget()
  }

  return {
    start(origin: string | readonly string[] | null) {
      stop()
      if (!origin || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
      const sourceIds = new Set(typeof origin === 'string' ? [origin] : origin)
      candidates = Array.from(canvas.querySelectorAll<HTMLElement>('.studio-node-shell[data-connection-tilt="true"]'))
        .filter((shell) => !sourceIds.has(shell.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? ''))
      window.addEventListener('pointermove', move, { passive: true })
    },
    stop
  }
}
