'use client'

/* eslint-disable @next/next/no-img-element -- 公开作品封面及品牌 SVG 使用业务地址 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { HtmlShellClass } from '@/components/app/HtmlShellClass'
import { HomeRecordFooter } from '@/components/home/HomeRecordFooter'
import { openLoginModal, useLoginModalStore } from '@/stores/loginModal'
import { useUserStore } from '@/stores/user'
import { MOBILE_CASE_PLAZA_PAGE_SIZE, useCasePlazaFeed, type CasePlazaFeedItem, type CasePlazaFilter } from '@/hooks/useCasePlazaFeed'
import logoMod from '~/assets/img/home/logo-new.svg'
import heroMod from '~/assets/img/home/movie.png'
import groupAvtorMod from '~/assets/img/home/Group-avtor.svg'
import { assetUrl } from '~/utils/assetUrl'
import { MOBILE_DESKTOP_PATH } from '~/utils/mobileOnlyNavigation'
import styles from './mobile-home.module.css'

const logoUrl = assetUrl(logoMod)
const heroUrl = assetUrl(heroMod)
const defaultAvatarUrl = assetUrl(groupAvtorMod)
const tabs: Array<{ value: CasePlazaFilter; label: string }> = [
  { value: 'discovery', label: '发现作品' },
  { value: 'movie', label: '电影 / 短片' },
]

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function MobileFeedCard({
  item,
  active,
  onOpen,
  registerVideoCover
}: {
  item: CasePlazaFeedItem
  active: boolean
  onOpen: () => void
  registerVideoCover: (key: string, element: HTMLDivElement | null) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const key = `${item.sourceKind}-${item.id}`
  const hasVideo = item.mediaType === 'video' && Boolean(item.previewVideoUrl)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (active) {
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
    return () => video.pause()
  }, [active, item.previewVideoUrl])

  return (
    <button type="button" className={styles.card} onClick={onOpen} aria-label={`查看作品：${item.title}`}>
      <div className={styles.cover} ref={hasVideo ? (element) => registerVideoCover(key, element) : undefined}>
        {hasVideo ? (
          <video ref={videoRef} src={item.previewVideoUrl} poster={item.coverImage} preload="none" muted loop playsInline disablePictureInPicture aria-hidden="true" />
        ) : (
          <img src={item.coverImage} alt="" loading="lazy" />
        )}
        <span className={styles.mediaBadge}>{item.categoryLabel}</span>
      </div>
      <div className={styles.cardBody}>
        <h3>{item.title}</h3>
        <p>{item.authorName}</p>
      </div>
    </button>
  )
}

export default function MobileHomePage() {
  const router = useRouter()
  const token = useUserStore((state) => state.token)
  const user = useUserStore((state) => state.user)
  const logout = useUserStore((state) => state.logout)
  const loginOpen = useLoginModalStore((state) => state.open)
  const [prompt, setPrompt] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<CasePlazaFilter>('discovery')
  const [selected, setSelected] = useState<CasePlazaFeedItem | null>(null)
  const [activeVideoKey, setActiveVideoKey] = useState<string | null>(null)
  const accountRef = useRef<HTMLDivElement>(null)
  const videoCoversRef = useRef(new Map<string, HTMLDivElement>())
  const avatarUrl = user?.avatar?.trim() || defaultAvatarUrl
  const feed = useCasePlazaFeed({ activeTab, searchQuery: '', pageSize: MOBILE_CASE_PLAZA_PAGE_SIZE })
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)

  const registerVideoCover = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) videoCoversRef.current.set(key, element)
    else videoCoversRef.current.delete(key)
  }, [])

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const update = () => {
      frame = 0
      if (selected || loginOpen || document.hidden || reducedMotion.matches) {
        setActiveVideoKey(null)
        return
      }
      const midpoint = window.innerHeight / 2
      const activationDistance = Math.min(120, window.innerHeight * 0.16)
      let nearest: string | null = null
      let nearestDistance = activationDistance
      for (const [key, element] of videoCoversRef.current) {
        const rect = element.getBoundingClientRect()
        const distance = Math.abs((rect.top + rect.bottom) / 2 - midpoint)
        if (rect.bottom > 0 && rect.top < window.innerHeight && distance < nearestDistance) {
          nearest = key
          nearestDistance = distance
        }
      }
      setActiveVideoKey((current) => current === nearest ? current : nearest)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    reducedMotion.addEventListener('change', schedule)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
      reducedMotion.removeEventListener('change', schedule)
    }
  }, [feed.items, selected, loginOpen])

  useEffect(() => {
    if (!selected) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [selected])

  useEffect(() => {
    if (!accountOpen) return
    const closeOnPointer = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('mousedown', closeOnPointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountOpen])

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current
    if (!sentinel || !feed.hasMore || feed.status !== 'ready') return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) feed.loadMore()
      },
      { rootMargin: '280px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [feed.hasMore, feed.loadMore, feed.status])

  function startCreation() {
    if (!token) {
      openLoginModal({ tab: 'password', redirect: null })
      return
    }
    router.push(MOBILE_DESKTOP_PATH)
  }

  return (
    <main className={styles.page}>
      <HtmlShellClass classes="mobile-only-shell" />
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.brand}><img src={logoUrl} alt="视觉 AID" /></div>
          {token ? (
            <div className={styles.account} ref={accountRef}>
              <button
                type="button"
                className={styles.avatarButton}
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-label="打开账户菜单"
                onClick={() => setAccountOpen((open) => !open)}
              >
                <img src={avatarUrl} alt="" />
              </button>
              {accountOpen ? (
                <div className={styles.accountMenu} role="menu" aria-label="账户菜单">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false)
                      logout()
                    }}
                  >
                    退出登录
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button type="button" className={styles.loginButton} onClick={() => openLoginModal({ tab: 'password', redirect: null })}>登录</button>
          )}
        </header>

        <section className={styles.hero}>
          <div className={styles.heroArtwork} style={{ backgroundImage: `url("${heroUrl}")` }} aria-hidden="true" />
          <h1>有什么新的故事灵感？</h1>
          <form className={styles.promptBox} onSubmit={(event) => { event.preventDefault(); startCreation() }}>
            <label className={styles.visuallyHidden} htmlFor="mobile-story-prompt">输入故事灵感</label>
            <input id="mobile-story-prompt" value={prompt} maxLength={500} onChange={(event) => setPrompt(event.target.value)} placeholder="输入灵感，开启创作" autoComplete="off" />
            <button type="submit" aria-label="发送灵感，前往创作"><ArrowIcon /></button>
          </form>
        </section>

        <section className={styles.feed} aria-labelledby="mobile-feed-title">
          <div className={styles.sectionHeading}>
            <h2 id="mobile-feed-title">案例广场</h2>
          </div>
          <div className={styles.tabs} role="tablist" aria-label="案例分类">
            {tabs.map((tab) => <button key={tab.value} type="button" role="tab" aria-selected={activeTab === tab.value} className={activeTab === tab.value ? styles.activeTab : ''} onClick={() => setActiveTab(tab.value)}>{tab.label}</button>)}
          </div>

          {feed.status === 'loadingFirst' ? <div className={styles.loading} role="status">正在加载作品…</div> : null}
          {feed.status === 'errorFirst' ? <div className={styles.feedback}><p>{feed.error || '作品加载失败'}</p><button type="button" onClick={feed.reload}>重新加载</button></div> : null}
          {feed.status === 'ready' && feed.items.length === 0 ? <div className={styles.feedback}>暂无作品</div> : null}
          <div className={styles.cards}>
            {feed.items.map((item) => (
              <MobileFeedCard key={`${item.sourceKind}-${item.id}`} item={item} active={!selected && !loginOpen && activeVideoKey === `${item.sourceKind}-${item.id}`} onOpen={() => setSelected(item)} registerVideoCover={registerVideoCover} />
            ))}
          </div>
          {feed.status === 'loadingMore' ? <p className={styles.moreStatus} role="status">正在加载更多…</p> : null}
          {feed.status === 'errorMore' ? <div className={styles.feedback}><p>{feed.error || '加载失败'}</p><button type="button" onClick={feed.loadMore}>重试</button></div> : null}
          <div ref={loadMoreSentinelRef} className={styles.loadMoreSentinel} aria-hidden="true" />
          {!feed.hasMore && feed.status === 'ready' && feed.items.length > 0 ? <p className={styles.feedEnd}>已经到底了</p> : null}
        </section>
        <HomeRecordFooter />
      </div>

      {selected ? <div className={styles.detailBackdrop} onClick={() => setSelected(null)}>
        <section className={styles.detail} role="dialog" aria-modal="true" aria-label={selected.title} onClick={(event) => event.stopPropagation()}>
          <header><span>作品详情</span><button type="button" aria-label="关闭作品详情" onClick={() => setSelected(null)}>×</button></header>
          {selected.mediaType === 'video' && selected.previewVideoUrl
            ? <video key={selected.id} controls playsInline preload="metadata" poster={selected.coverImage} src={selected.previewVideoUrl} />
            : <img src={selected.coverImage} alt={selected.title} />}
          <div className={styles.detailBody}><span>{selected.categoryLabel}</span><h2>{selected.title}</h2><p className={styles.detailAuthor}>作者 · {selected.authorName}</p><p>{selected.projectDesc || '更多内容，请继续浏览。'}</p></div>
        </section>
      </div> : null}
    </main>
  )
}
