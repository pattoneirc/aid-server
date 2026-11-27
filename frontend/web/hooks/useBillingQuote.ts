'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUserStore } from '~/stores/user'
import type { BillingQuoteRequest, BillingQuoteVO } from '~/types/business-api'
import { canvasUserBillingQuote, userBillingQuote } from '~/utils/business/billing'

const DEFAULT_DEBOUNCE_MS = 320
const EMPTY_QUOTE = { quote: null, loading: false, error: '' }

export interface UseBillingQuoteOptions {
  enabled?: boolean
  debounceMs?: number
  canvas?: boolean
}

export interface UseBillingQuoteResult {
  quote: BillingQuoteVO | null
  loading: boolean
  error: string
  refresh: () => void
  clear: () => void
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = stableValue(source[key])
  return sorted
}

function requestKey(request: BillingQuoteRequest | null): string {
  return request ? JSON.stringify(stableValue(request)) : ''
}

function extractErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return '报价暂不可用'
  const value = error as {
    msg?: string
    message?: string
    response?: { data?: { msg?: string; message?: string } }
  }
  return String(
    value.response?.data?.msg ||
      value.response?.data?.message ||
      value.msg ||
      value.message ||
      '报价暂不可用'
  )
}

/**
 * 对生成请求做防抖权威报价。参数变化时立即清除旧报价；取消请求和请求序号共同防止竞态回写。
 * 报价失败只返回提示状态，不改变调用方提交按钮状态。请求和结果均不进入模块级缓存。
 */
export function useBillingQuote(
  request: BillingQuoteRequest | null,
  options: UseBillingQuoteOptions = {}
): UseBillingQuoteResult {
  const enabled = options.enabled !== false
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const canvas = options.canvas === true
  const authToken = useUserStore((state) => state.token)
  const serializedRequest = useMemo(() => requestKey(request), [request])
  const stableRequest = useMemo<BillingQuoteRequest | null>(
    () => (serializedRequest ? (JSON.parse(serializedRequest) as BillingQuoteRequest) : null),
    [serializedRequest]
  )
  const sequenceRef = useRef(0)
  const forceNextRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const quoteKey = enabled && authToken && serializedRequest
    ? JSON.stringify([authToken, canvas, serializedRequest]) : ''
  const [result, setResult] = useState<{
    key: string
    quote: BillingQuoteVO | null
    loading: boolean
    error: string
  }>({ key: '', ...EMPTY_QUOTE })

  const cancelPending = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const clear = useCallback(() => {
    cancelPending()
    sequenceRef.current += 1
    setResult({ key: quoteKey, ...EMPTY_QUOTE })
  }, [cancelPending, quoteKey])

  const refresh = useCallback(() => {
    forceNextRef.current = true
    cancelPending()
    sequenceRef.current += 1
    setResult({ key: quoteKey, ...EMPTY_QUOTE, loading: Boolean(quoteKey) })
    setRefreshToken((value) => value + 1)
  }, [cancelPending, quoteKey])

  useEffect(() => {
    cancelPending()
    const current = stableRequest
    const sequence = ++sequenceRef.current
    if (!quoteKey || !current) return

    setResult({ key: quoteKey, ...EMPTY_QUOTE, loading: true })
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const force = forceNextRef.current
      forceNextRef.current = false
      void (canvas ? canvasUserBillingQuote(current) : userBillingQuote(current, { force }))
        .then((value) => {
          if (sequence !== sequenceRef.current) return
          setResult({ key: quoteKey, ...EMPTY_QUOTE, quote: value })
        })
        .catch((reason: unknown) => {
          if (sequence !== sequenceRef.current) return
          setResult({ key: quoteKey, ...EMPTY_QUOTE, error: extractErrorMessage(reason) })
        })
    }, Math.max(0, debounceMs))

    return () => {
      cancelPending()
      sequenceRef.current += 1
    }
  }, [cancelPending, canvas, debounceMs, quoteKey, refreshToken, stableRequest])

  const current = !quoteKey ? EMPTY_QUOTE : result.key === quoteKey ? result : { ...EMPTY_QUOTE, loading: true }
  return { quote: current.quote, loading: current.loading, error: current.error, refresh, clear }
}

export default useBillingQuote
