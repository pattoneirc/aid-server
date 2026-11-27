'use client'

import { StudioIconGlyph } from '@/components/studio/theme/StudioIconGlyph'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckOutlined, PlusOutlined, SearchOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { StudioSegmentedTabs } from '@/components/studio/composer/StudioSegmentedTabs'
import lightningIconRaw from '~/assets/img/icon/lightning.svg'
import { assetUrl } from '@/utils/assetUrl'
import { Modal, message } from 'antd'
import { StudioCanvasPopover } from '@/components/studio/canvas/StudioCanvasPopover'
import { StudioCanvasDropdownMenu, STUDIO_CANVAS_DROPDOWN_POPOVER_CLASS } from '@/components/studio/canvas/StudioCanvasDropdownMenu'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'
import { StudioComposerChip } from '@/components/studio/composer/StudioComposerChip'
import { useStudioSkillWorkspace } from '@/components/studio/skills/StudioSkillWorkspaceProvider'
import { readSkillAuthoringFiles } from '@/utils/studio/canvasSkillAuthoring'
import { filterCanvasSkillItems, type CanvasSkillItem } from '@/utils/studio/canvasSkillCatalog'
import { getStudioComposerPopupContainer } from '@/utils/studio/studioComposerPopupContainer'
import type { useCanvasSkillCatalog } from '@/hooks/studio/useCanvasSkillCatalog'
import { StudioCanvasSkillGallery } from './StudioCanvasSkillGallery'
import '../composer/studio-runtime-workspace.css'
import './studio-canvas-skill-picker.css'

type Tab = 'general' | 'favorites' | 'mine'
type Catalog = ReturnType<typeof useCanvasSkillCatalog> & {
  search?: (keyword: string, scope?: 'OFFICIAL' | 'OWNED' | 'FAVORITES') => Promise<void>
  hasMore?: boolean
  loadMore?: () => Promise<void>
}
type HoverPreview = { item: CanvasSkillItem; top: number; left: number }

function previewPosition(rect: DOMRect): { top: number; left: number } {
  const width = 248
  const gap = 12
  const left = rect.left - width - gap
  return {
    top: Math.max(12, Math.min(rect.top, window.innerHeight - 230)),
    left: left >= 8 ? left : rect.right + gap
  }
}

function previewCover(item: CanvasSkillItem) {
  let hash = 0
  for (const char of item.code || item.name) hash = (hash * 33 + char.charCodeAt(0)) % 360
  return { ['--skill-hue' as string]: String(hash) }
}

const skillGlyphUrl = assetUrl(lightningIconRaw)

export function StudioCanvasSkillGlyph() {
  return (
    <span className="canvas-skill-glyph" style={{ ['--canvas-skill-glyph' as string]: `url("${skillGlyphUrl}")` }} aria-hidden>
      <i />
    </span>
  )
}

export function StudioCanvasSkillPicker({
  selectedCode,
  catalog,
  onSelect,
  disabled = false,
  executionReady = false,
  open: controlledOpen,
  onOpenChange
}: {
  selectedCode: string
  defaultModelCode: string
  catalog: Catalog
  onSelect: (code: string) => void
  disabled?: boolean
  executionReady?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { items, groups, favorites, loading, error, reload, toggleFavorite } = catalog
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value) }
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const workspace = useStudioSkillWorkspace()
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('general')
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [hover, setHover] = useState<HoverPreview | null>(null)
  const [preview, setPreview] = useState<HoverPreview | null>(null)
  const [previewVisible, setPreviewVisible] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const hoverTimer = useRef<number | null>(null)
  const previewOpen = useRef(false)
  const importFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => { if (open && !catalog.search) void reload(); else if (!open) { setHover(null); setCreateOpen(false) } }, [open, reload, catalog.search])
  useEffect(() => {
    if (!open || !catalog.search) return
    const timer = window.setTimeout(() => { void catalog.search?.(query, tab === 'mine' ? 'OWNED' : tab === 'favorites' ? 'FAVORITES' : 'OFFICIAL') }, query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [open, query, tab, catalog.search])
  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current) }, [])
  useEffect(() => {
    if (!hover) {
      previewOpen.current = false
      setPreviewVisible(false)
      const timer = window.setTimeout(() => setPreview(null), 220)
      return () => window.clearTimeout(timer)
    }
    const opening = !previewOpen.current
    previewOpen.current = true
    setPreview(hover)
    if (!opening) {
      setPreviewVisible(true)
      return
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPreviewVisible(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [hover])

  const filtered = filterCanvasSkillItems(items, { tab, query, favorites })
  const clearHoverSoon = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHover(null), 80)
  }
  const keepHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
  }
  const changeCreateOpen = (value: boolean) => {
    if (value) { keepHover(); setHover(null) }
    setCreateOpen(value)
  }

  const importFiles = async (files: FileList | null) => {
    if (!files?.length || importFlight.current || !workspace) return
    importFlight.current = true
    setImporting(true)
    try {
      const material = await readSkillAuthoringFiles(Array.from(files))
      if (!mounted.current) return
      setImportOpen(false); setCreateOpen(false); setOpen(false)
      workspace.beginAuthoring(material)
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '读取编制材料失败')
    }
    finally { importFlight.current = false; setImporting(false); if (fileRef.current) fileRef.current.value = ''; if (folderRef.current) folderRef.current.value = '' }
  }

  return <>
    <StudioCanvasPopover surface="content" trigger="click" arrow={false} open={open && (!disabled || Boolean(catalog.search))} onOpenChange={(value) => { if (!disabled || catalog.search || !value) setOpen(value) }} placement="topLeft"
      getPopupContainer={getStudioComposerPopupContainer} destroyOnHidden
      classNames={{ root: 'canvas-skill-picker-popover' }}
      content={<section className="canvas-skill-picker" role="dialog" aria-label="选择 Skill">
        <header className="canvas-skill-picker__header">
          <div><strong>Skill</strong><small>探索与管理你的创作能力</small></div>
          <div className="canvas-skill-picker__header-actions">
            <StudioCanvasPopover trigger={['hover', 'click']} arrow={false} placement="bottomRight" open={createOpen && open && !disabled} onOpenChange={changeCreateOpen}
              getPopupContainer={getStudioComposerPopupContainer}
              classNames={{ root: STUDIO_CANVAS_DROPDOWN_POPOVER_CLASS }} zIndex={1400} destroyOnHidden
              content={<StudioCanvasDropdownMenu ariaLabel="创建 Skill" items={[
                { key: 'create', label: '创建新的 Skill', description: '在对话中确认来源与创作方法', icon: <StudioIconGlyph name="skill" />, disabled: !workspace, disabledHint: '当前画布未开放技能编制入口' },
                { key: 'import', label: '导入已有的 Skill', description: '读取材料，继续与编制助手完善', icon: <StudioIconGlyph name="upload" />, disabled: !workspace || importing, disabledHint: importing ? '正在读取编制材料，请稍候' : '当前画布未开放技能编制入口' }
              ]} onSelect={key => { setCreateOpen(false); setOpen(false); if (key === 'create') workspace?.beginAuthoring(); else setImportOpen(true) }} />}
            ><button type="button" className="canvas-skill-picker__header-button" aria-haspopup="menu" aria-expanded={createOpen}><PlusOutlined /> 创建</button></StudioCanvasPopover>
            <button type="button" className="canvas-skill-picker__header-button" onClick={() => { setOpen(false); setGalleryOpen(true) }}>技能库</button>
          </div>
        </header>
        <div className="canvas-skill-picker__filters">
          <StudioSegmentedTabs className="canvas-skill-picker__tabs" ariaLabel="Skill 分类" value={tab} onChange={setTab}
            options={[{ value: 'general', label: '通用' }, { value: 'favorites', label: '收藏' }, { value: 'mine', label: '我的' }]} />
          <label className="canvas-skill-picker__search"><SearchOutlined /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill" aria-label="搜索 Skill" /></label>
        </div>
        {selectedCode && !executionReady ? <p className="canvas-skill-picker__notice">此历史会话使用原有流程；Skill 可在新对话中使用。</p> : null}
        <div className="canvas-skill-picker__list" role="list" aria-label="Skill 列表" aria-busy={loading || importing} onScroll={() => setHover(null)}>
          {loading ? <p className="canvas-skill-picker__empty">正在加载 Skill…</p> : null}
          {error ? <button type="button" className="canvas-skill-picker__retry" onClick={() => void reload()}>{error} · 点击重试</button> : null}
          {!loading && !error && !filtered.length ? <p className="canvas-skill-picker__empty">{query ? '没有找到匹配的 Skill' : tab === 'favorites' ? '还没有收藏的 Skill' : '暂无 Skill'}</p> : null}
          {(catalog.search ? filtered : !loading && !error ? filtered : []).map((item) => <div key={item.code || 'general'} role="listitem" className={`canvas-skill-picker__row${selectedCode === item.code ? ' is-selected' : ''}`}
            onMouseEnter={(event) => { keepHover(); setHover({ item, ...previewPosition(event.currentTarget.getBoundingClientRect()) }) }}
            onMouseLeave={clearHoverSoon}>
            <button type="button" disabled={disabled || !item.available} aria-pressed={selectedCode === item.code} className="canvas-skill-picker__item" onClick={() => { onSelect(item.code); setOpen(false) }}>
              <StudioCanvasSkillGlyph />
              <span className="canvas-skill-picker__copy"><span><strong>{item.name}</strong>{!item.available ? <em>不可用</em> : null}</span><small>{!item.available ? item.unavailableReason || '当前助手未开放此 Skill' : item.description || item.group}</small></span>
              {selectedCode === item.code ? <CheckOutlined className="canvas-skill-picker__check" /> : null}
            </button>
            {item.code ? <StudioCanvasTooltip title={favorites.includes(item.code) ? '取消收藏' : '收藏 Skill'}><button type="button" className="canvas-skill-picker__star" aria-label={`${favorites.includes(item.code) ? '取消收藏' : '收藏'}${item.name}`} aria-pressed={favorites.includes(item.code)} onClick={() => toggleFavorite(item.code)}>{favorites.includes(item.code) ? <StarFilled /> : <StarOutlined />}</button></StudioCanvasTooltip> : null}
          </div>)}
        </div>
        <footer className="canvas-skill-picker__footer">{filtered.length} 个 Skill · 收藏仅保存在当前浏览器
          {catalog.hasMore ? <button type="button" disabled={loading} onClick={() => void catalog.loadMore?.()}>加载更多</button> : null}
        </footer>
      </section>}
    ><StudioCanvasTooltip title={selectedCode ? `Skill · ${items.find((item) => item.code === selectedCode)?.name || selectedCode}` : 'Skill · 通用创作'} placement="top"><StudioComposerChip className={`canvas-agent-tool-select is-icon-only${selectedCode ? ' is-skill-selected' : ''}`} icon={<StudioIconGlyph name="skill" />} label="Skill" arrow={false} active={open && (!disabled || Boolean(catalog.search))} disabled={disabled && !catalog.search} aria-label={selectedCode ? `选择 Skill，当前为 ${items.find((item) => item.code === selectedCode)?.name || selectedCode}` : '选择 Skill，当前为通用创作'} aria-haspopup="dialog" aria-expanded={open} /></StudioCanvasTooltip></StudioCanvasPopover>
    {preview && !createOpen ? createPortal(
      <aside className={`canvas-skill-preview${previewVisible ? ' is-shown' : ''}`} style={{ top: preview.top, left: preview.left }} role="note" aria-label={preview.item.name} onMouseEnter={keepHover} onMouseLeave={clearHoverSoon}>
        <span className="canvas-skill-preview__cover" style={preview.item.iconUrl ? undefined : previewCover(preview.item)}>
          {preview.item.iconUrl ? <img src={preview.item.iconUrl} alt="" /> : null}
        </span>
        <div className="canvas-skill-preview__body">
          <strong>{preview.item.name}</strong>
          <p>{preview.item.description || preview.item.group}</p>
        </div>
      </aside>,
      document.body
    ) : null}
    <Modal open={importOpen} onCancel={() => { if (!importing) setImportOpen(false) }} title="导入已有的 Skill" footer={null} width={520} centered destroyOnHidden className="create-flow-modal canvas-skill-import-modal" mask={{ closable: !importing }} closable={!importing} keyboard={!importing}>
      <p>读取已有文本后，在智能体对话中确认与完善。文件不会直接创建或发布 Skill。</p>
      <div className="canvas-skill-picker__create-menu" aria-busy={importing}>
        <button type="button" disabled={importing} onClick={() => fileRef.current?.click()}><StudioIconGlyph name="upload" /><span><strong>选择 Markdown 文件</strong><small>导入一份已有的方法或主文件</small></span></button>
        <button type="button" disabled={importing} onClick={() => folderRef.current?.click()}><StudioIconGlyph name="library" /><span><strong>选择 Skill 包文件夹</strong><small>包含 SKILL.md，可带系统提示词和参考文件</small></span></button>
      </div>
      {importing ? <p role="status">正在读取编制材料…</p> : null}
    </Modal>
    <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" hidden onChange={(event) => void importFiles(event.target.files)} />
    <input ref={folderRef} type="file" hidden {...{ webkitdirectory: '', directory: '' }} onChange={(event) => void importFiles(event.target.files)} />
    <StudioCanvasSkillGallery
      open={galleryOpen}
      items={items}
      groups={groups}
      favorites={favorites}
      onClose={() => setGalleryOpen(false)}
      onToggleFavorite={toggleFavorite}
      onSelect={onSelect}
      onSearch={catalog.search}
      hasMore={catalog.hasMore}
      onLoadMore={catalog.loadMore}
      loading={loading}
    />
  </>
}
