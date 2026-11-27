import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'

export function StudioComposerReferenceMentionButton({ title, onInsert }: {
  title: string
  onInsert: () => void
}) {
  return (
    <StudioCanvasTooltip title="插入正文引用" placement="bottom">
      <button
        type="button"
        className="studio-composer-reference-mention nodrag nopan"
        aria-label={`在提示词中引用：${title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation()
          onInsert()
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        @
      </button>
    </StudioCanvasTooltip>
  )
}
