'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Modal, message } from 'antd'
import { BulbOutlined, CheckOutlined, CopyOutlined, LoadingOutlined } from '@ant-design/icons'
import { StudioChromeIcon } from '@/components/studio/theme/StudioChromeIcon'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'
import { useStudioModels } from '@/hooks/studio/useStudioCatalog'
import { useCanvasQuote } from '@/hooks/studio/useCanvasQuote'
import { useCanvasGatewayIdentity } from '@/hooks/studio/useCanvasGatewayIdentity'
import { useStudioUiStore } from '@/stores/studioUi'
import { userGenerationQuote } from '@/utils/business/generation'
import { promptOptimizationRequest, streamPromptOptimization } from '@/utils/studio/studioPromptOptimization'
import { pickStudioComposerDefaultModel } from '@/utils/studio/studioComposerDefaultModel'
import { billingQuoteCreditsForDisplay } from '@/utils/billingQuoteDisplay'
import { StudioModelPicker } from './StudioModelPicker'
import { StudioCreditSendButton } from './StudioCreditSendButton'
import './studio-prompt-assistant.css'

type Props = { prompt: string; nodeId?: string; mediaKind?: 'image' | 'video' | 'text'; onApply: (value: string) => void }

export function StudioPromptAssistant(props: Props) {
  const scope = useStudioUiStore(state => state.scopeKey)
  const { identity } = useCanvasGatewayIdentity()
  return <PromptAssistantEntry key={JSON.stringify([scope, identity, props.nodeId])} {...props} />
}

function PromptAssistantEntry(props: Props) {
  const [open, setOpen] = useState(false)
  return <>
    <StudioCanvasTooltip title="提示词优化助手">
      <button type="button" className="studio-composer__assistant" aria-label="提示词助手" onClick={() => setOpen(true)}>
        <StudioChromeIcon name="idea" fallback={<BulbOutlined />} />
      </button>
    </StudioCanvasTooltip>
    {open ? <PromptAssistantDialog {...props} onClose={() => setOpen(false)} /> : null}
  </>
}

/** Unmounting on close discards drafts, prices and results immediately. */
function PromptAssistantDialog({ prompt, mediaKind = 'image', onApply, onClose }: Props & { onClose: () => void }) {
  const [input, setInput] = useState(prompt)
  const [submitted, setSubmitted] = useState('')
  const [modelCode, setModelCode] = useState('')
  const [preview, setPreview] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sourcePrompt] = useState(prompt)
  const active = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const models = useStudioModels('text', { enabled: true, canvas: true })
  const selectedModel = modelCode ? models.data.find(item => item.modelCode === modelCode) : pickStudioComposerDefaultModel(models.data, [models.defaultModelCode])
  const request = selectedModel && input.trim() ? promptOptimizationRequest(selectedModel.modelCode, input, mediaKind) : null
  const quote = useCanvasQuote('prompt-optimization', request, (body, signal) => userGenerationQuote('text', body, signal))
  const disabledReason = loading ? '正在优化提示词' : models.loading ? '正在读取文本模型' : models.error
    || (!selectedModel ? '请选择可用的文本模型' : !input.trim() ? '请输入需要优化的提示词' : quote.status !== 'READY' ? quote.error || '请等待报价完成' : '')

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; active.current?.abort() }
  }, [])

  useLayoutEffect(() => {
    const textarea = inputRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [input])

  const close = () => { alive.current = false; active.current?.abort(); onClose() }
  const optimize = async () => {
    if (active.current || disabledReason || !request) return
    const controller = new AbortController()
    active.current = controller
    const submittedInput = input
    setSubmitted(submittedInput)
    setInput('')
    setLoading(true); setError(''); setPreview(''); setResult('')
    try {
      const output = await streamPromptOptimization({ ...request, clientRequestId: globalThis.crypto?.randomUUID?.() ?? `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}` }, controller.signal,
        text => { if (alive.current && !controller.signal.aborted) setPreview(text) })
      if (alive.current && !controller.signal.aborted) { setPreview(output); setResult(output) }
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) {
        setInput(submittedInput)
        setError(reason instanceof Error ? reason.message : '提示词优化失败')
      }
    } finally {
      if (active.current === controller) active.current = null
      if (alive.current) setLoading(false)
    }
  }
  const apply = () => {
    if (!result || loading || error) return
    if (prompt !== sourcePrompt) { message.warning('节点提示词已变化，请关闭后重新优化'); return }
    onApply(result)
    close()
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(result); message.success('已复制提示词') }
    catch { message.error('浏览器未允许访问剪贴板') }
  }

  return <Modal open title={<span className="studio-prompt-assistant__title"><StudioChromeIcon name="idea" fallback={<BulbOutlined />} /> 提示词优化助手</span>}
    footer={null} width="min(820px, calc(100vw - 32px))" centered onCancel={close}
    className="studio-prompt-assistant-modal studio-prompt-assistant-modal--canvas">
    <div className="studio-prompt-assistant">
      <div className="studio-prompt-assistant__dialog">
        {submitted ? <article className="studio-prompt-message studio-prompt-message--user"><p>{submitted}</p></article> : null}
        {!submitted ? <div className="studio-prompt-assistant__empty">
          <StudioChromeIcon name="idea" fallback={<BulbOutlined />} />
          <strong>一次性提示词优化</strong>
          <p>点击应用后，优化结果才会保存到节点。关闭弹窗会清空本次对话。</p>
        </div> : null}
        {loading && !preview ? <div className="studio-prompt-assistant__pending" role="status">
          <LoadingOutlined aria-hidden="true" /> 正在优化…
        </div> : null}
        {preview ? <article className="studio-prompt-message studio-prompt-message--assistant" aria-busy={loading}>
          <div className="studio-prompt-message__result">{preview}</div>
          {result && !loading && !error ? <div className="studio-prompt-message__actions">
            <Button icon={<CheckOutlined />} onClick={apply}>应用提示词</Button>
            <Button icon={<CopyOutlined />} onClick={() => void copy()}>复制</Button>
          </div> : null}
        </article> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <div className="studio-prompt-assistant__request">
        <textarea ref={inputRef} value={input} rows={5} aria-label="待优化提示词" placeholder="输入需要优化的提示词，Enter 发送，Shift + Enter 换行" disabled={loading}
          onChange={event => { setInput(event.target.value); setResult(''); setPreview(''); setError('') }}
          onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void optimize() } }} />
        <div className="studio-prompt-assistant__toolbar">
          <StudioModelPicker value={selectedModel?.modelCode} mediaKind="text" popupPlacement="topRight" options={models.data}
            disabled={loading} optionsLoading={models.loading} optionsError={models.error} syncDefaults={false} preserveInvalidSelection
            ariaLabel="选择提示词优化模型" onChange={value => { if (active.current) return; setModelCode(value); setError(''); setResult(''); setPreview('') }} />
          <StudioCreditSendButton credits={billingQuoteCreditsForDisplay(quote.quote) ?? 0} isFree={quote.quote?.isFree === true}
            authoritative={quote.status === 'READY'} estimateLoading={quote.loading} estimateError={quote.error}
            quoteStatus={quote.status}
            hasContent={Boolean(input.trim())} mode="agent" loading={loading} disabled={Boolean(disabledReason)} disabledReason={disabledReason}
            className="studio-prompt-assistant__send" onSend={() => void optimize()} />
        </div>
      </div>

    </div>
  </Modal>
}
