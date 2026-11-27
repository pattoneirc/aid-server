'use client'

import { Tooltip } from 'antd'
import type { ReactNode } from 'react'
import {
  COMPOSER_SEND_EMPTY_TOOLTIP,
  isComposerSendClickDisabled,
  resolveComposerSendVisualState,
  type ComposerSendMode
} from '~/utils/composerSendButton'
import './composer-send-button.css'

/** 保留原资源的几何；颜色由消费方主题提供，不对整张图标做滤镜。 */
export function ComposerSendGlyph({ empty = false, stop = false }: { empty?: boolean; stop?: boolean }) {
  const foreground = empty ? 'var(--studio-ui-muted, #8E97A5)' : 'var(--studio-ui-inverse, #1C1E22)'
  return (
    <svg className={`composer-send-button__glyph${empty ? ' is-empty' : ''}`} width={32} height={32} viewBox="0 0 32 32" aria-hidden="true">
      <rect className="composer-send-button__disc" width="32" height="32" rx="16" opacity={empty ? 0.2 : 1} fill={empty ? 'var(--studio-ui-muted, #8E97A5)' : 'var(--studio-ui-accent, #4AE7FD)'} />
      {stop ? <rect className="composer-send-button__mark" x="11" y="11" width="10" height="10" rx="2" fill={foreground} /> : (
        <path className="composer-send-button__mark" d="M16.7168 8.74512L22.9951 15.2441L22.2754 15.9385L21.5566 16.6338L17.0332 11.9502V23.998H14.9619V11.9492L10.4395 16.6338L9.71973 15.9385L9 15.2441L15.2783 8.74512L15.9971 8L16.7168 8.74512Z" fill={foreground} />
      )}
    </svg>
  )
}

export interface ComposerSendButtonProps {
  hasContent: boolean
  mode?: ComposerSendMode
  loading?: boolean
  generating?: boolean
  pauseDisabled?: boolean
  showResume?: boolean
  disabled?: boolean
  emptyTooltip?: string
  className?: string
  leadingContent?: ReactNode
  pauseTooltip?: string
  pauseBusyTooltip?: string
  pauseAriaLabel?: string
  resumeTooltip?: string
  resumeAriaLabel?: string
  onSend: () => void
  onPause?: () => void
  onResume?: () => void
}

export function ComposerSendButton({
  hasContent,
  mode = 'agent',
  loading = false,
  generating = false,
  pauseDisabled = false,
  showResume = false,
  disabled = false,
  emptyTooltip = COMPOSER_SEND_EMPTY_TOOLTIP,
  className = '',
  leadingContent,
  pauseTooltip = '暂停生成',
  pauseBusyTooltip = '正在暂停…',
  pauseAriaLabel = '暂停生成',
  resumeTooltip = '继续接收生成内容',
  resumeAriaLabel = '继续生成',
  onSend,
  onPause,
  onResume
}: ComposerSendButtonProps) {
  const visualState = resolveComposerSendVisualState({
    mode,
    hasContent,
    loading,
    generating,
    showResume
  })
  const clickDisabled = isComposerSendClickDisabled({
    visualState,
    disabled,
    pauseDisabled
  })

  const ariaLabel =
    visualState === 'loading'
      ? '正在创建项目'
      : visualState === 'pause'
        ? pauseDisabled
          ? '正在暂停生成'
          : pauseAriaLabel
        : visualState === 'resume'
          ? resumeAriaLabel
          : visualState === 'empty'
            ? '发送'
            : '发送'

  const buttonClassName = [
    'composer-send-button',
    visualState === 'resume' ? 'is-resume' : '',
    visualState === 'pause' ? 'is-pause' : '',
    visualState === 'active' && disabled ? 'is-active-disabled' : '',
    leadingContent ? 'has-leading-content' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  const button = (
    <button
      type="button"
      className={buttonClassName}
      aria-label={ariaLabel}
      aria-busy={visualState === 'loading' ? true : undefined}
      disabled={clickDisabled}
      onClick={() => {
        if (visualState === 'pause') {
          onPause?.()
          return
        }
        if (visualState === 'resume') {
          onResume?.()
          return
        }
        onSend()
      }}
    >
      {leadingContent ? <span className="composer-send-button__leading">{leadingContent}</span> : null}
      {visualState === 'loading' ? (
        <span className="composer-send-button__spinner" aria-hidden="true" />
      ) : null}
      {visualState === 'pause' ? (
        <ComposerSendGlyph stop />
      ) : null}
      {visualState === 'resume' ? (
        <ComposerSendGlyph />
      ) : null}
      {visualState === 'empty' || visualState === 'active' ? (
        <>
          <span
            className={`composer-send-button__icon-layer ${
              visualState === 'empty' ? 'is-visible' : 'is-hidden'
            }`}
            aria-hidden="true"
          >
            <ComposerSendGlyph empty />
          </span>
          <span
            className={`composer-send-button__icon-layer ${
              visualState === 'active' ? 'is-visible' : 'is-hidden'
            }`}
            aria-hidden="true"
          >
            <ComposerSendGlyph />
          </span>
        </>
      ) : null}
    </button>
  )

  if (visualState === 'empty' && emptyTooltip) {
    return (
      <Tooltip title={emptyTooltip}>
        <span className="composer-send-button__tooltip-wrap">{button}</span>
      </Tooltip>
    )
  }
  if (visualState === 'pause') {
    return <Tooltip title={pauseDisabled ? pauseBusyTooltip : pauseTooltip}>{button}</Tooltip>
  }
  if (visualState === 'resume') {
    return <Tooltip title={resumeTooltip}>{button}</Tooltip>
  }
  return button
}

export default ComposerSendButton
