'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { BillingQuoteVO } from '@/types/business-api'
import { canvasQuoteIdentity, canvasQuoteRequestKey, requestCanvasQuote } from '@/utils/canvas/canvasQuote'
import { useCanvasGatewayIdentity } from './useCanvasGatewayIdentity'
import { apiErrorMessage } from '@/utils/apiError'
import { canvasQuoteErrorData } from '@/utils/canvas/canvasQuoteMetadataRecovery'
import { videoQuoteReferenceIssues, type VideoQuoteReferenceIssue } from '@/utils/canvas/canvasVideoQuoteReferenceIssues'
import { canRetryCanvasQuote, CANVAS_QUOTE_ACTIVATION_COOLDOWN, CANVAS_QUOTE_RETRY_DELAYS } from '@/utils/canvas/canvasQuoteRecovery'

export type CanvasQuoteStatus = 'IDLE' | 'CONNECTING' | 'BLOCKED' | 'LOADING' | 'READY' | 'ERROR'
export type CanvasQuoteState = {
  quote: BillingQuoteVO | null; loading: boolean; error: string; status: CanvasQuoteStatus; refresh: () => void
  referenceIssues?: VideoQuoteReferenceIssue[]
}

function quoteError(reason: unknown): string {
  const data = canvasQuoteErrorData(reason)
  if (data?.errorCode === 'CANVAS_QUOTE_REFERENCE_METADATA_UNAVAILABLE'
    || data?.errorCode === 'CANVAS_QUOTE_REFERENCE_AUDIO_METADATA_UNAVAILABLE') {
    return '素材缺少可信媒体信息，准备尚未完成；请重新报价或选择其他模型'
  }
  if (data?.errorCode === 'MEDIA_INPUT_METADATA_REQUIRED') {
    return '图片素材缺少可信尺寸或格式信息，准备尚未完成；请补齐素材信息后重新报价'
  }
  return apiErrorMessage(reason, '报价暂不可用，请重新报价')
}

/** Read-only quotes recover in the background; generation and authorization remain explicit user actions. */
export function useCanvasQuote<T>(scope: string, request: T | null,
  load: (request: T, signal: AbortSignal) => Promise<BillingQuoteVO>, blockedReason = ''): CanvasQuoteState {
  const { identity, connected } = useCanvasGatewayIdentity()
  const ownerId = useId()
  const requestKey = canvasQuoteRequestKey(request)
  const stableRequest = useMemo<T | null>(() => requestKey ? JSON.parse(requestKey) as T : null, [requestKey])
  const loader = useRef(load)
  useEffect(() => { loader.current = load }, [load])
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([identity, scope, requestKey, revision, blockedReason])
  const [state, setState] = useState<{ key: string; quote: BillingQuoteVO | null; error: string; loading: boolean; referenceIssues?: VideoQuoteReferenceIssue[] }>({ key: '', quote: null, error: '', loading: false })
  const refresh = useCallback(() => {
    if (connected && stableRequest && !blockedReason) setRevision(value => value + 1)
  }, [connected, stableRequest, blockedReason])

  useEffect(() => {
    if (!connected || !stableRequest || blockedReason) return
    let active = true, running = false, failed = false, pending = false, attempts = 0, lastStarted = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const owner = new AbortController()
    const available = () => !document.hidden && navigator.onLine !== false
    const schedule = (delay: number) => {
      if (!active || running) return
      clearTimeout(timer)
      timer = undefined
      if (!available()) { pending = true; return }
      pending = false
      timer = setTimeout(run, delay)
    }
    const run = () => {
      timer = undefined
      if (!active || running) return
      if (!available()) { pending = true; return }
      running = true
      failed = false
      lastStarted = Date.now()
      setState({ key, quote: null, error: '', loading: true })
      // Each preparation owns its resource receipt. API quote requests dedupe across all consumers below this boundary.
      void requestCanvasQuote(`preview:${scope}:${ownerId}`, stableRequest, signal => loader.current(stableRequest, signal), owner.signal)
        .then(quote => {
          if (active && canvasQuoteIdentity() === identity) setState({ key, quote, error: '', loading: false })
        }).catch(reason => {
          if (!active || canvasQuoteIdentity() !== identity) return
          failed = true
          setState({ key, quote: null, error: quoteError(reason), loading: false, referenceIssues: videoQuoteReferenceIssues(reason) })
          const delay = CANVAS_QUOTE_RETRY_DELAYS[attempts]
          if (canRetryCanvasQuote(reason) && delay !== undefined) {
            attempts += 1
            // Release the flight before scheduling its next read.
            running = false
            schedule(delay)
          }
        }).finally(() => { running = false })
    }
    const activate = () => {
      if (!active || running || timer || !available()) return
      if (pending) { schedule(320); return }
      if (failed && Date.now() - lastStarted >= CANVAS_QUOTE_ACTIVATION_COOLDOWN) {
        attempts = 0
        schedule(320)
      }
    }
    schedule(320)
    window.addEventListener('online', activate)
    window.addEventListener('focus', activate)
    document.addEventListener('visibilitychange', activate)
    return () => {
      active = false
      clearTimeout(timer)
      owner.abort()
      window.removeEventListener('online', activate)
      window.removeEventListener('focus', activate)
      document.removeEventListener('visibilitychange', activate)
    }
  }, [blockedReason, connected, identity, key, ownerId, scope, stableRequest])

  if (!stableRequest) return { quote: null, loading: false, error: '', status: 'IDLE', refresh }
  if (!connected) return { quote: null, loading: false, error: '画布连接尚未就绪，连接完成后将重新报价', status: 'CONNECTING', refresh }
  if (blockedReason) return { quote: null, loading: false, error: blockedReason, status: 'BLOCKED', refresh }
  if (state.key !== key) return { quote: null, loading: true, error: '', status: 'LOADING', refresh }
  if (state.loading) return { quote: null, loading: true, error: '', status: 'LOADING', refresh }
  return { quote: state.quote, loading: false, error: state.error, status: state.quote ? 'READY' : 'ERROR', refresh, referenceIssues: state.referenceIssues }
}
