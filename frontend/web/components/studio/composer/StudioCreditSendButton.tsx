'use client'

import type { ComponentProps } from 'react'
import { ComposerSendButton } from '~/components/common/composer-send/ComposerSendButton'
import { COMPOSER_SEND_EMPTY_TOOLTIP, resolveComposerSendVisualState } from '~/utils/composerSendButton'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'
import { useUserStore } from '@/stores/user'
import { studioCreditPresentation } from '@/utils/studio/studioCreditEstimate'
import type { CanvasQuoteStatus } from '@/hooks/studio/useCanvasQuote'

/** 描边四角星跟随金额前景色，不引入独立色彩，画布内各主题下与文字同调。 */
export function StudioCreditMark() {
  return (
    <svg className="studio-credit-amount__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />
    </svg>
  )
}

/** 节点 Composer 与工具面板共用同一积分图标和金额排版。 */
export function StudioCreditAmount({
  credits,
  isFree = false,
  authoritative = false,
  loading = false,
  loadingLabel = '报价中',
  pendingQuote = false,
  error = '',
  quoteStatus
}: {
  credits: number
  isFree?: boolean
  authoritative?: boolean
  loading?: boolean
  loadingLabel?: string
  pendingQuote?: boolean
  error?: string
  quoteStatus?: CanvasQuoteStatus
}) {
  const presentation = studioCreditPresentation(credits, { isFree, authoritative })
  const label = quoteStatus ? quoteStatus === 'READY' ? presentation.visible : '—'
    : loading ? loadingLabel : error || pendingQuote ? '—' : presentation.visible
  const amountDescription = loading ? '正在获取积分价格' : error
    || (quoteStatus && quoteStatus !== 'READY' ? '积分价格暂不可用' : label)
  return (
    <span className="studio-credit-amount" aria-label={amountDescription} aria-busy={loading || undefined}>
      <StudioCreditMark />
      <b>{label}</b>
    </span>
  )
}

type Props = Omit<ComponentProps<typeof ComposerSendButton>, 'leadingContent'> & {
  credits: number
  /** 免费模型展示「免费」，不再显示约 0 */
  isFree?: boolean
  showCredits?: boolean
  /** 仅服务端 billing/quote 返回的金额可设为 true；本地模型列表估算不得阻止提交。 */
  authoritative?: boolean
  estimateLoading?: boolean
  estimateLoadingLabel?: string
  estimateError?: string
  disabledReason?: string
  /** 按素材和参数动态计费、目录无固定单价时，避免把零值误显示成免费报价。 */
  pendingQuote?: boolean
  quoteStatus?: CanvasQuoteStatus
}

export function StudioCreditSendButton({
  credits,
  isFree = false,
  showCredits = true,
  authoritative = false,
  estimateLoading = false,
  estimateLoadingLabel,
  estimateError = '',
  disabledReason = '',
  pendingQuote = false,
  quoteStatus,
  disabled,
  className = '',
  emptyTooltip = COMPOSER_SEND_EMPTY_TOOLTIP,
  ...props
}: Props) {
  const balance = useUserStore((state) => state.user?.balance)
  const presentation = studioCreditPresentation(credits, { isFree, authoritative })
  const insufficient = !pendingQuote && !isFree
    && authoritative
    && showCredits
    && typeof balance === 'number'
    && balance < credits
  const visualState = resolveComposerSendVisualState({
    mode: props.mode ?? 'agent',
    hasContent: props.hasContent,
    loading: props.loading,
    generating: props.generating,
    showResume: props.showResume
  })
  const sendOwnsTooltip = visualState === 'pause' || visualState === 'resume'
  const quoteUnavailable = Boolean(showCredits && quoteStatus && quoteStatus !== 'READY')
  const quoteUnavailableReason = estimateError.trim()
    || (quoteStatus === 'ERROR' ? '当前功能暂不可用' : '')
  const sendDisabled = Boolean(disabled || insufficient || quoteUnavailable)
  const quoteTooltip = quoteUnavailable ? quoteUnavailableReason : showCredits
    ? insufficient
      ? `\u79ef\u5206\u4e0d\u8db3\uff1a\u5f53\u524d${balance}\uff0c\u672c\u6b21\u62a5\u4ef7${credits}`
      : estimateLoading
        ? '\u6b63\u5728\u83b7\u53d6\u79ef\u5206\u4ef7\u683c'
        : estimateError
          ? `\u62a5\u4ef7\u6682\u4e0d\u53ef\u7528\uff1a${estimateError}`
          : pendingQuote ? '提交前获取服务端报价' : presentation.ariaLabel
    : ''
  const tooltip = sendOwnsTooltip ? '' : disabledReason || (visualState === 'empty' ? emptyTooltip : quoteTooltip)
  const tooltipNeedsFocus = visualState === 'empty' || (sendDisabled && visualState === 'active')
  const sendButton = (
    <ComposerSendButton
      {...props}
      disabled={sendDisabled}
      emptyTooltip=""
      className={`${className}${insufficient ? ' is-insufficient' : ''}`}
      leadingContent={showCredits ? (
        <StudioCreditAmount credits={credits} isFree={isFree} authoritative={authoritative} loading={estimateLoading}
          loadingLabel={estimateLoadingLabel}
          pendingQuote={pendingQuote} error={estimateError} quoteStatus={quoteStatus} />
      ) : undefined}
    />
  )
  return (
    <span className={`studio-credit-send${insufficient ? ' is-insufficient' : ''}`}>
      {tooltip ? (
        <StudioCanvasTooltip title={tooltip} placement="top" trigger={['hover', 'focus']}>
          <span tabIndex={tooltipNeedsFocus ? 0 : undefined}>{sendButton}</span>
        </StudioCanvasTooltip>
      ) : sendButton}
    </span>
  )
}
