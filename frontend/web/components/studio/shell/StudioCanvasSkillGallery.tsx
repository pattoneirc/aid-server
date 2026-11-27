'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftOutlined, CloseOutlined, SearchOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { StudioSegmentedTabs } from '@/components/studio/composer/StudioSegmentedTabs'
import { Modal } from 'antd'
import type { CanvasRuntimeGroup } from '@/types/canvas-runtime-api'
import {
  canvasSkillOutputLabel,
  type CanvasSkillItem
} from '@/utils/studio/canvasSkillCatalog'
import './studio-canvas-skill-gallery.css'

type View = 'browse' | 'favorites' | 'mine'

function coverHue(item: CanvasSkillItem) {
  let hash = 0
  for (const char of item.code || item.name) hash = (hash * 33 + char.charCodeAt(0)) % 360
  return String(hash)
}

export function StudioCanvasSkillGallery({
  open,
  items,
  groups,
  favorites,
  onClose,
  onToggleFavorite,
  onSelect,
  onSearch,
  hasMore = false,
  onLoadMore,
  loading = false
}: {
  open: boolean
  items: CanvasSkillItem[]
  groups: CanvasRuntimeGroup[]
  favorites: string[]
  onClose: () => void
  onToggleFavorite: (code: string) => void
  onSelect: (code: string) => void
  onSearch?: (keyword: string, scope?: 'OFFICIAL' | 'OWNED' | 'FAVORITES') => Promise<void>
  hasMore?: boolean
  onLoadMore?: () => Promise<void>
  loading?: boolean
}) {
  const [view, setView] = useState<View>('browse')
  const [groupCode, setGroupCode] = useState('')
  const [query, setQuery] = useState('')
  const [detailCode, setDetailCode] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !onSearch) return
    const timer = window.setTimeout(() => { void onSearch(query, view === 'mine' ? 'OWNED' : view === 'favorites' ? 'FAVORITES' : 'OFFICIAL') }, query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [open, query, view, onSearch])

  useEffect(() => {
    if (!open) return
    setView('browse')
    setGroupCode('')
    setQuery('')
    setDetailCode(null)
  }, [open])

  const categories = useMemo(
    () => [...groups].sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0)),
    [groups]
  )
  const needle = query.trim().toLocaleLowerCase()
  const cards = items.filter((item) => {
    if (!item.code) return false
    if (view === 'favorites' && !favorites.includes(item.code)) return false
    if (view === 'mine' && !item.own) return false
    if (view === 'browse') {
      if (groupCode && item.groupCode !== groupCode) return false
      if (!item.available) return false
    }
    if (!needle) return true
    return `${item.name} ${item.code} ${item.description} ${item.group}`.toLocaleLowerCase().includes(needle)
  })
  const detail = detailCode == null ? null : items.find((item) => item.code === detailCode) ?? null
  const detailGroup = detail ? groups.find((group) => group.groupCode === detail.groupCode) : null
  const gridRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = moreRef.current
    if (!open || detail || !hasMore || !onLoadMore || !sentinel || loading) return
    if (typeof IntersectionObserver === 'undefined') {
      void onLoadMore()
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void onLoadMore()
    }, { root: gridRef.current, rootMargin: '240px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [open, detail, hasMore, onLoadMore, loading, cards.length])

  const choose = (code: string) => {
    if (!items.some(item => item.code === code && item.available)) return
    onSelect(code)
    onClose()
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      closable={false}
      width={980}
      centered
      className="canvas-skill-gallery-modal"
      getContainer={() => document.querySelector<HTMLElement>('.studio-canvas') || document.body}
      destroyOnHidden
    >
      <section className="canvas-skill-gallery" aria-label="Skill 技能库">
        <header className="canvas-skill-gallery__top">
          <StudioSegmentedTabs className="canvas-skill-gallery__views" ariaLabel="Skill 范围" value={view}
            onChange={key => { setView(key); setDetailCode(null) }} options={[{ value: 'browse', label: 'Skill' }, { value: 'favorites', label: '收藏' }, { value: 'mine', label: '我的' }]} />
          {!detail && <label className="canvas-skill-gallery__search">
            <SearchOutlined />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill" aria-label="搜索 Skill" />
          </label>}
          <button type="button" className="canvas-skill-gallery__close" aria-label="关闭技能库" onClick={onClose}><CloseOutlined /></button>
        </header>
        {detail ? (
          <SkillDetail
            item={detail}
            scene={detailGroup?.description || detail.group}
            favorite={favorites.includes(detail.code)}
            onBack={() => setDetailCode(null)}
            onToggleFavorite={() => onToggleFavorite(detail.code)}
            onSelect={() => choose(detail.code)}
          />
        ) : (
          <>
            {view === 'browse' && categories.length > 0 ? <div className="canvas-skill-gallery__filters">
                <div className="canvas-skill-gallery__categories">
                  <StudioSegmentedTabs className="canvas-skill-gallery__rail" ariaLabel="Skill 分类" value={groupCode} onChange={setGroupCode}
                    options={[{ value: '', label: '推荐' }, ...categories.map(group => ({ value: group.groupCode, label: group.name }))]} />
                </div>
            </div> : null}
            <div ref={gridRef} className="canvas-skill-gallery__grid" role="list">
              {cards.length ? cards.map((item) => (
                <article key={item.code} role="listitem" className="canvas-skill-gallery__card">
                  <button type="button" className="canvas-skill-gallery__open" onClick={() => setDetailCode(item.code)}>
                    <SkillCover item={item} />
                    <span className="canvas-skill-gallery__copy">
                      <strong>{item.name}</strong>
                      <small>{item.description || item.group}</small>
                      <span className="canvas-skill-gallery__meta">{item.group}{item.available ? '' : ` · ${item.unavailableReason || '当前不可调用'}`}</span>
                    </span>
                  </button>
                  <div className="canvas-skill-gallery__hover">
                    {item.code ? <em>/{item.code}</em> : <span />}
                    <span className="canvas-skill-gallery__hover-actions">
                      <button type="button" className="canvas-skill-gallery__star" aria-label={`${favorites.includes(item.code) ? '取消收藏' : '收藏'}${item.name}`} aria-pressed={favorites.includes(item.code)} onClick={() => onToggleFavorite(item.code)}>
                        {favorites.includes(item.code) ? <StarFilled /> : <StarOutlined />}
                      </button>
                      <button type="button" disabled={!item.available} onClick={() => choose(item.code)}>使用</button>
                    </span>
                  </div>
                </article>
              )) : <p className="canvas-skill-gallery__empty">{loading ? '正在加载 Skill…' : query ? '没有找到匹配的 Skill' : '这个分类下还没有 Skill'}</p>}
              {hasMore ? <p ref={moreRef} className="canvas-skill-gallery__more" role="status">{loading ? '正在加载' : ''}</p> : null}
            </div>
          </>
        )}
      </section>
    </Modal>
  )
}

function SkillCover({ item }: { item: CanvasSkillItem }) {
  return (
    <span className="canvas-skill-cover" style={item.iconUrl ? undefined : { ['--skill-hue' as string]: coverHue(item) }}>
      {item.iconUrl ? <img src={item.iconUrl} alt="" /> : null}
      <em>{canvasSkillOutputLabel(item.outputKind)}</em>
    </span>
  )
}

function SkillDetail({
  item,
  scene,
  favorite,
  onBack,
  onToggleFavorite,
  onSelect
}: {
  item: CanvasSkillItem
  scene: string
  favorite: boolean
  onBack: () => void
  onToggleFavorite: () => void
  onSelect: () => void
}) {
  const rows = [
    ['介绍', item.description || '暂无介绍'],
    ['使用场景', scene || item.group],
    ['如何使用', item.code ? `在对话输入框输入 /${item.code}，或从列表中选择这个 Skill` : '不附加 Skill，直接描述你的需求'],
    ['输出内容', `${canvasSkillOutputLabel(item.outputKind)}结果`]
  ]
  return (
    <div className="canvas-skill-detail">
      <div className="canvas-skill-detail__bar">
        <button type="button" onClick={onBack}><ArrowLeftOutlined /> 返回</button>
        <button type="button" aria-label={favorite ? '取消收藏' : '收藏 Skill'} aria-pressed={favorite} onClick={onToggleFavorite}>{favorite ? <StarFilled /> : <StarOutlined />}</button>
        <button type="button" className="canvas-skill-detail__add" disabled={!item.available} onClick={onSelect}>添加 Skill</button>
      </div>
      <div className="canvas-skill-detail__hero">
        <SkillCover item={item} />
      </div>
      <h2>{item.name}</h2>
      <p>{item.group}{item.code ? ` · /${item.code}` : ''}{item.available ? '' : ` · ${item.unavailableReason || '当前不可调用'}`}</p>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </div>
  )
}
