'use client'
import { useCanvasPublicationChannel } from '@/hooks/useCanvasPublicationChannel'

import { SearchOutlined } from '@ant-design/icons'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import CasePlazaMasonry from '~/components/home/CasePlazaMasonry'
import HomeComposer from '~/components/home/composer/HomeComposer'
import { GallerySubmitIcon } from '~/components/home/GallerySubmitIcon'
import { HomeRecordFooter } from '~/components/home/HomeRecordFooter'
import { HomeSegmented } from '~/components/home/theme/HomeSegmented'
import { useHomePointerChrome } from '~/components/home/theme/useHomePointerChrome'
import { useHomeHeroContentReady } from '~/composables/useHomeHeroContentReady'
import { useHomeGuestAccess } from '~/hooks/useHomeGuestAccess'
import { useHomeSidebarExtraNav } from '~/composables/useHomeSidebarExtraNav'
import {
  useCasePlazaFeed,
  type CasePlazaFeedItem,
  type CasePlazaFilter
} from '~/hooks/useCasePlazaFeed'
import { useUserStore } from '~/stores/user'
import { CASE_PLAZA_DEFAULT_TAB } from '~/utils/casePlazaSearchCriteria'
import {
  consumeHomeGalleryScrollSnapshot,
  peekHomeGalleryScrollSnapshot,
  readHomeMainScrollTop,
  restoreHomeGalleryScroll,
  saveHomeGalleryScrollSnapshot
} from '~/utils/homeGalleryScrollRestore'
import '~/components/home/home-ui-v4.css'

const CanvasProjectCollection = dynamic(
  () => import('~/components/canvas/CanvasProjectCollection').then((mod) => mod.CanvasProjectCollection),
  { ssr: false }
)
const CanvasPublicationGalleryContent = dynamic(
  () => import('@/components/canvas/CanvasPublicationGallery').then((mod) => mod.CanvasPublicationGalleryContent),
  { ssr: false, loading: () => <CasePlazaMasonry appearance="home-v4" items={[]} status="loadingFirst" hasMore={false} error="" /> }
)
const DiscoverySubmissionModal = dynamic(() => import('~/components/home/DiscoverySubmissionModal'), { ssr: false })

const filterTabs = [
  { label: '发现', value: 'discovery' },
  { label: '电影/短片', value: 'movie' }
] as const

export default function HomeNewIndexPage() {
  const token = useUserStore((s) => s.token)
  const { requireLogin } = useHomeGuestAccess()
  const { markHomeHeroContentReady } = useHomeHeroContentReady()
  const { openTutorial } = useHomeSidebarExtraNav()
  const isLoggedIn = !!token
  useHomePointerChrome()

  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<CasePlazaFilter | 'canvas'>(CASE_PLAZA_DEFAULT_TAB)
  const [submissionModalOpen, setSubmissionModalOpen] = useState(false)
  const [submissionReady, setSubmissionReady] = useState(false)
  const [canvasSearchQuery, setCanvasSearchQuery] = useState('')
  const canvasEnabled = useCanvasPublicationChannel()
  const availableTabs = canvasEnabled ? [...filterTabs, { label: '画布', value: 'canvas' } as const] : filterTabs

  const rememberCasePosition = useCallback((item: CasePlazaFeedItem) => {
    saveHomeGalleryScrollSnapshot({
      scrollTop: readHomeMainScrollTop(),
      workId: item.id,
      savedAt: Date.now()
    })
  }, [])

  useEffect(() => {
    if (submissionModalOpen) setSubmissionReady(true)
  }, [submissionModalOpen])

  useEffect(() => {
    markHomeHeroContentReady(true)
    return () => markHomeHeroContentReady(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openSubmissionModal() {
    if (!isLoggedIn) {
      requireLogin('投稿作品')
      return
    }
    setSubmissionModalOpen(true)
  }

  return (
    <div className="home-new-index home-ui-v4">
      <div className="page-content">
        <HomeComposer
          isLoggedIn={isLoggedIn}
          onRequireLogin={requireLogin}
          onTutorial={() => void openTutorial()}
        />

        <div className="home-page-wrap">
        {isLoggedIn ? <CanvasProjectCollection variant="home" enabled /> : null}
        <section className="gallery-section" aria-labelledby="gallery-section-title">
          <header className="section-header">
            <h2 id="gallery-section-title" className="section-title">案例广场</h2>
            <div className="section-toolbar">
              <HomeSegmented
                className="home-seg--sub"
                ariaLabel="案例分类"
                value={activeTab}
                options={availableTabs}
                onChange={(value) => {
                  setActiveTab(value)
                  if (value === 'discovery') setSearchQuery('')
                }}
              />
              {activeTab === 'discovery' ? (
                <button
                  type="button"
                  className="gallery-submit-btn"
                  aria-label="投稿作品"
                  onClick={openSubmissionModal}
                >
                  <span className="gallery-submit-btn__icon-wrap" aria-hidden="true">
                    <GallerySubmitIcon />
                  </span>
                  <span>投稿</span>
                </button>
              ) : (
                <div className="search-box">
                  <SearchOutlined className="search-icon" />
                  <input
                    value={activeTab === 'canvas' ? canvasSearchQuery : searchQuery}
                    onChange={(event) => activeTab === 'canvas' ? setCanvasSearchQuery(event.target.value) : setSearchQuery(event.target.value)}
                    type="search"
                    maxLength={activeTab === 'canvas' ? 100 : undefined}
                    placeholder={activeTab === 'canvas' ? '搜索画布作品...' : '搜索作品...'}
                    className="search-input"
                    aria-label={activeTab === 'canvas' ? '搜索画布作品' : '搜索作品'}
                  />
                </div>
              )}
            </div>
          </header>

          {activeTab === 'canvas'
            ? <CanvasPublicationGalleryContent enabled={canvasEnabled} embedded searchQuery={canvasSearchQuery} />
            : <HomeCasePlazaFeed activeTab={activeTab} searchQuery={searchQuery} onOpen={rememberCasePosition} />}
        </section>
        </div>
        <HomeRecordFooter />
      </div>

      {submissionReady ? (
        <DiscoverySubmissionModal
          open={submissionModalOpen}
          onOpenChange={setSubmissionModalOpen}
        />
      ) : null}
    </div>
  )
}

function HomeCasePlazaFeed({ activeTab, searchQuery, onOpen }: {
  activeTab: CasePlazaFilter
  searchQuery: string
  onOpen: (item: CasePlazaFeedItem) => void
}) {
  const casePlazaFeed = useCasePlazaFeed({ activeTab, searchQuery })
  const pendingGalleryScrollRestoreRef = useRef(false)

  useEffect(() => {
    if (peekHomeGalleryScrollSnapshot()) {
      pendingGalleryScrollRestoreRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!pendingGalleryScrollRestoreRef.current) return
    if (casePlazaFeed.status === 'loadingFirst') return
    if (!casePlazaFeed.items.length && casePlazaFeed.status !== 'ready') return

    const snapshot = consumeHomeGalleryScrollSnapshot()
    pendingGalleryScrollRestoreRef.current = false
    if (!snapshot) return

    requestAnimationFrame(() => {
      restoreHomeGalleryScroll(snapshot)
      requestAnimationFrame(() => {
        restoreHomeGalleryScroll(snapshot)
      })
    })
  }, [casePlazaFeed.items.length, casePlazaFeed.status])
  return (
    <CasePlazaMasonry
      appearance="home-v4"
      items={casePlazaFeed.items}
      status={casePlazaFeed.status}
      hasMore={casePlazaFeed.hasMore}
      error={casePlazaFeed.error}
      onLoadMore={casePlazaFeed.loadMore}
      onReload={casePlazaFeed.reload}
      onOpen={onOpen}
    />
  )
}
