'use client'

import { StudioCanvasPopover } from '@/components/studio/canvas/StudioCanvasPopover'
import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  AppstoreOutlined,
  BorderOutlined,
  DownloadOutlined,
  FolderOutlined,
  OrderedListOutlined,
  PlayCircleOutlined,
  UngroupOutlined
} from '@ant-design/icons'
import { message } from 'antd'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { executeLegacyStudioGroupImages, executeStudioGroupImages, type StudioGroupImageExecution } from '@/hooks/studio/executeStudioGroupImages'
import { useStudioUiStore } from '@/stores/studioUi'
import { downloadMediaFileWithToast } from '@/utils/mediaFileDownload'
import {
  STUDIO_GRID_STORYBOARD_MERGE_TOOLTIP,
  canMergeNodesToGridStoryboard
} from '@/utils/studio/studioGroupStoryboardBridge'
import { isStudioNodeBatchExecutable, listGroupDownloadableMedia } from '@/utils/studio/studioGroupActions'
import type { SelectionScreenRect, StudioArrangement } from '@/utils/studio/studioSelectionLayout'
import { placeStudioSelectionToolbar } from '@/utils/studio/studioSelectionLayout'
import { studioNodeMediaDownloadType } from '@/utils/studio/studioNodeMedia'
import { StudioCanvasDropdownPopover } from './StudioCanvasDropdownMenu'
import { StudioCanvasToolbarButton } from './StudioCanvasToolbarButton'
import { StudioCanvasTooltip } from './StudioCanvasTooltip'
import { StudioGroupColorPicker } from './StudioGroupColorPicker'
import { StudioGroupExecutionDialog } from './StudioGroupExecutionDialog'

export interface StudioGroupToolbarHandle {
  reposition: (selectionRect: SelectionScreenRect, viewportRect: SelectionScreenRect) => void
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

type GroupExecution = {
  scopeKey: string
  groupId: string
  groupTitle: string
  rows: StudioGroupImageExecution[]
  running: boolean
}

export const StudioGroupToolbar = memo(forwardRef<StudioGroupToolbarHandle, { visible: boolean }>(
  function StudioGroupToolbar({ visible }, ref) {
    const elementRef = useRef<HTMLDivElement>(null)
    const canvasRuntime = useCanvasProjectRuntime()
    const scopeKey = useStudioUiStore((state) => state.scopeKey)
    const studioMode = useStudioUiStore((state) => state.studioMode)
    const selectedNodeIds = useStudioUiStore((state) => state.selectedNodeIds)
    const nodes = useStudioUiStore((state) => state.nodes)
    const groups = useStudioUiStore((state) => state.groups)
    const arrangeNodes = useStudioUiStore((state) => state.arrangeNodes)
    const ungroupNodes = useStudioUiStore((state) => state.ungroupNodes)
    const convertGroupToGridStoryboard = useStudioUiStore((state) => state.convertGroupToGridStoryboard)
    const setGroupColor = useStudioUiStore((state) => state.setGroupColor)
    const saveNodesToAssets = useStudioUiStore((state) => state.saveNodesToAssets)
    const [colorOpen, setColorOpen] = useState(false)
    const [arrangeOpen, setArrangeOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [execution, setExecution] = useState<GroupExecution | null>(null)
    const [reportOpen, setReportOpen] = useState(false)
    const activeExecution = useRef<GroupExecution | null>(null)

    const group = useMemo(
      () => visible ? groups.find((item) => sameIdSet(item.childIds, selectedNodeIds)) : undefined,
      [groups, selectedNodeIds, visible]
    )
    const childNodes = useMemo(() => {
      if (!group) return []
      const idSet = new Set(group.childIds)
      return nodes.filter((node) => idSet.has(node.id))
    }, [group, nodes])
    const mergeCheck = useMemo(() => canMergeNodesToGridStoryboard(childNodes), [childNodes])
    const executableNodes = useMemo(() => childNodes.filter(isStudioNodeBatchExecutable), [childNodes])
    const report = execution?.scopeKey === scopeKey ? execution : null
    const executeDisabledReason = !executableNodes.length
      ? '分组内没有可生成的图片节点'
      : studioMode === 'free' && !canvasRuntime
        ? '画布生成尚未就绪，请稍后重试'
        : canvasRuntime && (!canvasRuntime.canEdit || !canvasRuntime.canUseFeature('canvas.generate'))
          ? '当前账号没有画布生成权限'
          : canvasRuntime && !canvasRuntime.canMutate
            ? '画布协作连接尚未就绪，请稍后重试'
            : busy || report?.running ? '已有整组任务正在执行' : ''

    useImperativeHandle(ref, () => ({
      reposition(selectionRect, viewportRect) {
        const element = elementRef.current
        if (!element) return
        const measured = element.getBoundingClientRect()
        const position = placeStudioSelectionToolbar(
          selectionRect,
          viewportRect,
          { width: Math.max(measured.width, 280), height: Math.max(measured.height, 40) }
        )
        element.style.left = `${position.left}px`
        element.style.top = `${position.top}px`
        element.dataset.placement = position.placement
      }
    }), [])

    const arrangementItems = useMemo(
      () => [
        { key: 'grid', label: '宫格排列' },
        { key: 'horizontal', label: '水平排列' },
        { key: 'vertical', label: '垂直排列' }
      ],
      []
    )

    const executeGroup = useCallback(async () => {
      if (!group || executeDisabledReason || activeExecution.current?.scopeKey === scopeKey) return
      if (!canvasRuntime) {
        setBusy(true)
        try {
          await executeLegacyStudioGroupImages(group.childIds)
        } finally {
          setBusy(false)
        }
        return
      }
      const byId = new Map(executableNodes.map(node => [node.id, node]))
      const rows: StudioGroupImageExecution[] = [...new Set(group.childIds)].flatMap(id => {
        const node = byId.get(id)
        return node ? [{ id, title: node.data.title?.trim() || '图片节点', status: 'pending' as const }] : []
      })
      const run = { scopeKey, groupId: group.id, groupTitle: group.title, rows, running: true }
      activeExecution.current = run
      setExecution(run)
      setReportOpen(true)
      try {
        await executeStudioGroupImages({
          scopeKey, groupId: group.id, nodes: rows, runtime: canvasRuntime,
          onUpdate: (row) => {
            if (activeExecution.current !== run) return
            setExecution(current => current && { ...current, rows: current.rows.map(item => item.id === row.id ? row : item) })
          }
        })
      } finally {
        if (activeExecution.current === run) {
          activeExecution.current = null
          setExecution(current => current && { ...current, running: false })
        }
      }
    }, [canvasRuntime, executableNodes, executeDisabledReason, group, scopeKey])

    const downloadGroup = useCallback(async () => {
      if (!group) return
      const items = listGroupDownloadableMedia(nodes, group.childIds)
      if (!items.length) {
        message.info('没有可下载的媒体')
        return
      }
      for (const item of items) {
        await downloadMediaFileWithToast(
          item.url,
          item.title,
          studioNodeMediaDownloadType(item.kind, undefined)
        )
      }
    }, [group, nodes])

    const saveToToolbox = useCallback(() => {
      if (!group) return
      const count = saveNodesToAssets(group.childIds)
      if (count) message.success(`已添加 ${count} 项到工具箱`)
      else message.info('没有可保存的媒体')
    }, [group, saveNodesToAssets])

    const resultDialog = report ? (
      <StudioGroupExecutionDialog
        open={reportOpen}
        groupTitle={report.groupTitle}
        rows={report.rows}
        running={report.running}
        onClose={() => setReportOpen(false)}
        onLocate={(nodeId) => {
          if (!useStudioUiStore.getState().nodes.some(node => node.id === nodeId)) {
            message.info('节点已删除')
            return
          }
          setReportOpen(false)
          useStudioUiStore.getState().selectNodes([nodeId])
          window.dispatchEvent(new CustomEvent('studio:focus-node', { detail: { nodeId } }))
        }}
      />
    ) : null

    const color = group?.colorTag ?? null

    return (
      <>
      {group ? <div
        ref={elementRef}
        className="studio-group-toolbar studio-canvas-glass-toolbar nodrag nowheel"
        role="toolbar"
        aria-label={group.title || `分组 ${group.childIds.length} 个节点`}
        style={{ left: -9999, top: 0 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <StudioCanvasPopover
          open={colorOpen}
          onOpenChange={setColorOpen}
          trigger="click"
          placement="bottom"
          arrow={false}
          classNames={{ root: 'studio-composer-popover studio-composer-popover--canvas studio-canvas-dropdown-popover' }}
          getPopupContainer={(trigger) => trigger.closest('.studio-canvas') ?? document.body}
          content={(
            <StudioGroupColorPicker
              value={color}
              onChange={(next) => {
                setGroupColor(group.id, next)
                setColorOpen(false)
              }}
            />
          )}
        >
          <span className="studio-node-media-toolbar__popover-anchor">
            <StudioCanvasTooltip title="标签">
              <button
                type="button"
                className="studio-canvas-glass-toolbar__btn studio-group-toolbar__color-btn"
                aria-label="标签"
                onClick={() => setColorOpen(true)}
              >
                <i
                  className={`studio-group-toolbar__color-dot${color ? '' : ' is-none'}`}
                  style={color ? { background: color } : undefined}
                />
              </button>
            </StudioCanvasTooltip>
          </span>
        </StudioCanvasPopover>

        <StudioCanvasDropdownPopover
          placement="bottom"
          open={arrangeOpen}
          onOpenChange={setArrangeOpen}
          ariaLabel="组内排列"
          items={arrangementItems}
          onSelect={(key) => arrangeNodes(group.childIds, key as StudioArrangement)}
          trigger={
            <StudioCanvasToolbarButton
              caret
              expanded={arrangeOpen}
              label="排列"
              icon={<AppstoreOutlined aria-hidden />}
            />
          }
        />

        <span className="studio-canvas-glass-toolbar__divider" aria-hidden />

        <StudioCanvasTooltip title={executeDisabledReason || undefined}>
          <span>
            <StudioCanvasToolbarButton
              showLabel
              label="整组执行"
              icon={<PlayCircleOutlined aria-hidden />}
              disabled={Boolean(executeDisabledReason)}
              onClick={() => { void executeGroup() }}
            />
          </span>
        </StudioCanvasTooltip>

        {report?.groupId === group.id ? (
          <StudioCanvasToolbarButton
            label="查看整组执行结果"
            icon={<OrderedListOutlined aria-hidden />}
            onClick={() => setReportOpen(true)}
          />
        ) : null}

        <StudioCanvasToolbarButton
          showLabel
          label="添加到工具箱"
          icon={<FolderOutlined aria-hidden />}
          onClick={saveToToolbox}
        />

        {mergeCheck.ok ? (
          <StudioCanvasToolbarButton
            showLabel
            label="转分镜组"
            icon={<BorderOutlined aria-hidden />}
            onClick={() => {
              const id = convertGroupToGridStoryboard(group.id)
              if (!id) message.warning(STUDIO_GRID_STORYBOARD_MERGE_TOOLTIP)
            }}
          />
        ) : (
          <StudioCanvasTooltip title={STUDIO_GRID_STORYBOARD_MERGE_TOOLTIP}>
            <span>
              <StudioCanvasToolbarButton
                showLabel
                label="转分镜组"
                icon={<BorderOutlined aria-hidden />}
                disabled
              />
            </span>
          </StudioCanvasTooltip>
        )}

        <StudioCanvasToolbarButton
          showLabel
          label="解组"
          icon={<UngroupOutlined aria-hidden />}
          onClick={() => ungroupNodes(group.childIds)}
        />

        <StudioCanvasToolbarButton
          showLabel
          label="批量下载"
          icon={<DownloadOutlined aria-hidden />}
          onClick={() => { void downloadGroup() }}
        />
      </div> : null}
      {resultDialog}
      </>
    )
  }
))
