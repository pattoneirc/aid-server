'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CompressOutlined, ExpandAltOutlined, SlidersOutlined } from '@ant-design/icons'
import { Tooltip, message } from 'antd'
import { useBillingQuote } from '@/hooks/useBillingQuote'
import { useCanvasBillingQuote } from '@/hooks/studio/useCanvasBillingQuote'
import { useCanvasGenerationQuote } from '@/hooks/studio/useCanvasGenerationQuote'
import { useCanvasQuoteReferencePreparation } from '@/hooks/studio/useCanvasQuoteReferencePreparation'
import { CanvasQuoteReferenceNotReadyError } from '@/utils/studio/studioCanvasGenerationQuote'
import { canvasModelPromptPolicy } from '@/utils/studio/canvasModelInputValidation'
import { canvasComposerInputFeedback } from '@/utils/studio/canvasComposerInputFeedback'
import type { CanvasQuoteState } from '@/hooks/studio/useCanvasQuote'
import { requestCanvasImageQuote, useCanvasImageQuote } from '@/hooks/studio/useCanvasImageQuote'
import type { UserImageGenerationRequest } from '@/types/generation-api'
import { useStudioUiStore } from '@/stores/studioUi'
import { markStudioQuoteReferences } from '@/stores/studioQuoteReferenceIssues'
import type { BillingQuoteRequest, BillingQuoteVO, UserModelListItem } from '@/types/business-api'
import type { StudioCanvasNode, StudioComposerRef } from '@/types/studio'
import { billingQuoteCreditsForDisplay } from '@/utils/billingQuoteDisplay'
import { studioCanvasQuoteCredits } from '@/utils/studio/studioCanvasQuoteDisplay'
import {
  applyStudioAutoLink,
  collectStudioAutoLinkCandidates,
  isStudioAutoLinkEnabled
} from '@/utils/studio/studioAutoLink'
import { buildStudioCanvasLiveQuote } from '@/utils/studio/studioCanvasLiveQuote'
import { estimateStudioCredits } from '@/utils/studio/studioCreditEstimate'
import {
  appendComposerRefInstance,
  isComposerRefFrameEligible,
  isComposerRefStripVisible,
  replaceStudioVideoReference,
  revokeStudioComposerRefPreview,
  sourceKeyOfRef
} from '@/utils/studio/studioComposerRefs'
import {
  listStudioComposerUpstreamThumbs,
  studioComposerUpstreamSignature
} from '@/utils/studio/studioComposerUpstream'
import type { StudioMentionPanelAnchor } from '@/utils/studio/studioMentionAnchor'
import { StudioComposerAdvancedSettings } from './StudioComposerAdvancedSettings'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'
import { StudioIconGlyph } from '@/components/studio/theme/StudioIconGlyph'
import { StudioChromeIcon } from '@/components/studio/theme/StudioChromeIcon'
import { useStudioComposerPresentation } from './studioComposerPresentationContext'
import {
  StudioComposerPromptEditor,
  type StudioComposerPromptEditorHandle
} from './StudioComposerPromptEditor'
import { StudioComposerAttachmentStrip } from './StudioComposerAttachmentStrip'
import { StudioVideoReferenceErrors, type VideoReferenceIssueGroup } from './StudioVideoReferenceErrors'
import { StudioCreditSendButton } from './StudioCreditSendButton'
import { StudioComposerVoiceInput } from './StudioComposerVoiceInput'
import { useStudioSpeechInput } from '@/hooks/studio/useStudioSpeechInput'
import { StudioComposerUploadButton } from './StudioComposerUploadButton'
import { StudioMentionPanel } from './StudioMentionPanel'
import { useStudioPanelPresence } from '@/hooks/studio/useStudioPanelPresence'
import { StudioCameraLibraryProvider, type StudioCameraLibraryRequest } from './studioCameraLibraryContext'
import { createStudioCameraMarkId, type StudioCameraMarkDraft } from '@/utils/studio/studioCameraMark'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { apiErrorMessage } from '@/utils/apiError'
import { canvasErrorMessage } from '@/utils/canvas/canvasErrorMessage'
import { canvasResourceMatchesNodeMedia } from '@/utils/canvas/canvasCurrentResultResource'
import { fullCropRect } from '@/utils/studio/studioImageAiTools'
import {
  canApplyStudioComposerPromptChange,
  resolveStudioComposerPromptCharacterLimit
} from '@/utils/studio/studioPromptCharacterLimit'

type MentionPanelState = {
  /** trigger：输入 @；chip：点击正文 mention */
  mode: 'trigger' | 'chip'
  query: string
  anchor: StudioMentionPanelAnchor
}

export function StudioComposerFrame({
  node,
  topLeft,
  topRight,
  headerTools,
  bottomLeft,
  promptLeading,
  promptTrailing,
  placeholder = '描述你想要生成的画面内容，@引用素材',
  showCredits,
  pricingModel,
  pricingLoading = false,
  showSend = true,
  readOnly = false,
  allowEmptySubmit = false,
  onSubmit,
  submitDisabledReason,
  resolveBillingRequest,
  resolveCanvasQuoteRequest,
  quoteOverride,
  onPromptDraftChange,
  cameraLibrary = false,
  attachmentControl
}: {
  node: StudioCanvasNode
  topLeft?: ReactNode
  topRight?: ReactNode
  /** Persistent tools remain available in the centered editor as well as the node composer. */
  headerTools?: ReactNode
  bottomLeft?: ReactNode
  promptLeading?: ReactNode
  /** 正文下方的附属输入。音频歌词放在这里，才能跟着输入面板一起放大。 */
  promptTrailing?: ReactNode
  placeholder?: string
  showCredits?: boolean
  /** 当前目录匹配的模型；画布节点展示价格以它为准，避免旧节点元数据残留。 */
  pricingModel?: UserModelListItem
  pricingLoading?: boolean
  showSend?: boolean
  readOnly?: boolean
  allowEmptySubmit?: boolean
  onSubmit?: (prompt: string) => unknown | Promise<unknown>
  submitDisabledReason?: string | null
  resolveBillingRequest?: (prompt: string) => BillingQuoteRequest | null
  resolveCanvasQuoteRequest?: (prompt: string) => UserImageGenerationRequest | null
  quoteOverride?: { quote: BillingQuoteVO | null; loading: boolean; error: string; preparingReferences?: boolean } & Partial<Pick<CanvasQuoteState, 'status' | 'refresh'>>
  onPromptDraftChange?: (prompt: string) => void
  /** 默认视频节点才把运镜和拍摄手法写进正文。 */
  cameraLibrary?: boolean
  attachmentControl?: ReactNode
}) {
  const canvasRuntime = useCanvasProjectRuntime()
  const presentation = useStudioComposerPresentation()
  const [rejectedInput, setRejectedInput] = useState<{ node: string; model?: string; capability?: string | null; prompt: string; message: string } | null>(null)
  const [draft, setDraft] = useState(() => ({ nodeId: node.id, source: node.data.prompt, value: node.data.prompt }))
  const [submitting, setSubmitting] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [mentionPanel, setMentionPanel] = useState<MentionPanelState | null>(null)
  const mentionVisible = Boolean(mentionPanel && !presentation?.expandOnly)
  const mentionPresence = useStudioPanelPresence(mentionVisible)
  const [lastMentionPanel, setLastMentionPanel] = useState(mentionPanel)
  if (mentionPanel && mentionPanel !== lastMentionPanel) setLastMentionPanel(mentionPanel)
  const displayedMentionPanel = mentionPanel || lastMentionPanel
  const [cameraRequest, setCameraRequest] = useState<StudioCameraLibraryRequest | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const advancedPanelRef = useRef<HTMLDivElement>(null)
  const advancedPanelId = useId()
  const cameraRequestSerial = useRef(0)
  const submittingRef = useRef(false)
  const promptEditorRef = useRef<StudioComposerPromptEditorHandle>(null)
  const expandOnly = Boolean(presentation?.expandOnly)
  const [viewportTransition, setViewportTransition] = useState({ expandOnly, restoreMentionFocus: false })
  if (viewportTransition.expandOnly !== expandOnly) {
    setViewportTransition({ expandOnly, restoreMentionFocus: expandOnly && mentionPanel !== null })
    if (expandOnly) {
      setMentionPanel(null)
      setCameraRequest(null)
      setAdvancedOpen(false)
    }
  }
  useLayoutEffect(() => {
    if (!expandOnly || !viewportTransition.restoreMentionFocus) return
    // The portal has already unmounted at this commit; restore its focus to the
    // surviving entry instead of leaving focus on document.body.
    frameRef.current?.querySelector<HTMLButtonElement>('[aria-label="放大输入面板"]')?.focus({ preventScroll: true })
  }, [expandOnly, viewportTransition.restoreMentionFocus])
  useLayoutEffect(() => {
    const panel = advancedPanelRef.current
    if (!advancedOpen || !panel || presentation?.expandOnly) return
    panel.scrollIntoView({ block: 'nearest' })
    panel.querySelector<HTMLButtonElement>('[role="switch"]')?.focus({ preventScroll: true })
  }, [advancedOpen, presentation?.expandOnly])
  const updateNodeData = useStudioUiStore((state) => state.updateNodeData)
  const removeComposerReference = useStudioUiStore((state) => state.removeComposerReference)
  const studioMode = useStudioUiStore((state) => state.studioMode)
  const scopeKey = useStudioUiStore((state) => state.scopeKey)
  const voiceDraftRef = useRef<{
    nodeId: string
    scopeKey: string
    base: string
    expected: string
    value: string
    previous: string
    refs: StudioComposerRef[]
  } | null>(null)
  /** 仅订上游媒体签名，避免跟整表 nodes/edges 抖动。 */
  const upstreamSignature = useStudioUiStore((state) => (
    studioComposerUpstreamSignature(node.id, state.nodes, state.edges)
  ))
  const task = useStudioUiStore((state) => state.tasks.find(
    (item) => item.nodeId === node.id && (item.status === 'running' || item.status === 'queued')
  ))
  const options = node.data.generationOptions ?? {}
  const autoLinkEnabled = isStudioAutoLinkEnabled(options)
  const richPrompt = !readOnly && (node.data.kind === 'image' || node.data.kind === 'video')
  const showAdvanced = richPrompt
  const useCatalogPricing = Boolean(canvasRuntime && ['text', 'image', 'video'].includes(node.data.kind))
  const localIsFree = useCatalogPricing ? Boolean(pricingModel?.isFree) : Boolean(node.data.modelIsFree)
  const modelCostCredits = useCatalogPricing ? pricingModel?.costCredits : node.data.modelCostCredits
  const modelPricingPending = Boolean(useCatalogPricing && (!pricingModel || (!localIsFree && modelCostCredits == null)))
  const localCredits = localIsFree
    ? 0
    : modelPricingPending ? 0 : estimateStudioCredits({
      costCredits: modelCostCredits,
      mediaKind: node.data.mediaKind,
      count: options.count,
      durationSeconds: options.duration
    })
  const promptDraft = draft.nodeId === node.id && draft.source === node.data.prompt
    ? draft.value
    : node.data.prompt
  const selectedCapability = node.data.generationOptions?.videoCapability || pricingModel?.capabilityCode
  const resolvePromptMaxLength = useCallback(
    (prompt: string) => resolveStudioComposerPromptCharacterLimit(pricingModel, prompt, selectedCapability),
    [pricingModel, selectedCapability]
  )
  const promptLimit = resolvePromptMaxLength(promptDraft)
  const promptPolicy = canvasModelPromptPolicy(pricingModel, selectedCapability)
  const ordinaryMedia = Boolean(canvasRuntime && !resolveCanvasQuoteRequest && !quoteOverride && (node.data.kind === 'image' || node.data.kind === 'video'))
  const canSendEmpty = allowEmptySubmit || (ordinaryMedia && promptPolicy.optional)
  const promptError = ordinaryMedia && !promptPolicy.acceptsText && promptDraft.trim()
    ? '当前模型能力不接受提示词，请清空文字或选择支持文本输入的模型。'
    : canvasRuntime && promptDraft.length > promptLimit
    ? `当前模型的提示词最多支持 ${promptLimit.toLocaleString('zh-CN')} 个字符，已输入 ${promptDraft.length.toLocaleString('zh-CN')} 个，请缩短内容。`
    : ''
  // 引用源节点变化也必须重新报价；只订阅当前引用，避免订阅整个画布节点表。
  const quoteReferenceSignature = useStudioUiStore(state => JSON.stringify(
    [...new Set([...(node.data.composerRefs ?? []).flatMap(ref => ref.nodeId ? [ref.nodeId] : []), ...(node.data.imageDescribe ? [node.data.imageDescribe.sourceNodeId] : [])])]
      .map(id => { const source = state.nodes.find(item => item.id === id); return [id, source?.data.mediaUrl,
        source?.data.canvasPrimaryResourceId, source?.data.canvasResourceIds, source?.data.documentContent, source?.data.prompt] })
  ))
  const ordinaryKind = node.data.kind === 'text' || node.data.kind === 'image' || node.data.kind === 'video' ? node.data.kind : null
  const usesGenerationQuote = Boolean(canvasRuntime && ordinaryKind && !resolveCanvasQuoteRequest && !quoteOverride)
  const ordinaryQuote = (() => {
    // The subscription above invalidates the pure snapshot preparation on source edits.
    void quoteReferenceSignature
    if (showCredits === false || !usesGenerationQuote || !canvasRuntime || !ordinaryKind || !pricingModel || pricingLoading
      || ordinaryKind === 'text' && !promptDraft.trim()) return { input: null, error: '', requiresPreparation: false }
    if (promptError) return { input: null, error: promptError, requiresPreparation: false }
    try {
      return { input: { kind: ordinaryKind, request: canvasRuntime.prepareGenerationQuote(ordinaryKind, node, pricingModel, promptDraft) }, error: '', requiresPreparation: false }
    } catch (error) {
      return {
        input: null,
        error: canvasErrorMessage(error, '当前引用暂不可报价'),
        requiresPreparation: error instanceof CanvasQuoteReferenceNotReadyError
      }
    }
  })()
  const referencePreparation = useCanvasQuoteReferencePreparation(node, canvasRuntime, {
    auto: Boolean(!task && !readOnly && ordinaryQuote.requiresPreparation)
  })
  const ordinaryCanvasQuote = useCanvasGenerationQuote(ordinaryQuote.input, ordinaryQuote.error)
  const canvasLiveQuote = showCredits === false || !canvasRuntime || pricingLoading || resolveCanvasQuoteRequest || quoteOverride
    || usesGenerationQuote
    || ((node.data.kind === 'image' || node.data.kind === 'video') && !pricingModel)
    ? null
    : buildStudioCanvasLiveQuote({
      node,
      modelCode: String(pricingModel?.modelCode || node.data.model || ''),
      model: pricingModel,
      prompt: promptDraft,
      promptOptional: pricingModel?.capability?.promptOptional === true
    })
  const creditsVisible = showCredits ?? Boolean(resolveBillingRequest || resolveCanvasQuoteRequest || canvasRuntime || canvasLiveQuote)
  const parentBillingRequest = creditsVisible && resolveBillingRequest && promptDraft.trim()
    ? resolveBillingRequest(promptDraft.trim())
    : null
  const billingRequest = parentBillingRequest ?? (creditsVisible ? canvasLiveQuote : null)
  const billingQuote = useBillingQuote(canvasRuntime ? null : billingRequest)
  const canvasBillingQuote = useCanvasBillingQuote(canvasRuntime && !quoteOverride && !resolveCanvasQuoteRequest && !usesGenerationQuote ? billingRequest : null)
  const canvasQuoteRequest = creditsVisible && resolveCanvasQuoteRequest
    ? resolveCanvasQuoteRequest(promptDraft.trim()) : null
  const canvasQuote = useCanvasImageQuote(canvasQuoteRequest)
  const activeQuote = quoteOverride ?? (resolveCanvasQuoteRequest ? canvasQuote : usesGenerationQuote ? ordinaryCanvasQuote : canvasRuntime ? canvasBillingQuote : billingQuote)
  const activeCanvasQuote = quoteOverride ?? (resolveCanvasQuoteRequest ? canvasQuote : usesGenerationQuote ? ordinaryCanvasQuote : canvasBillingQuote)
  const quotedCredits = canvasRuntime
    ? studioCanvasQuoteCredits(activeQuote.quote)
    : billingQuoteCreditsForDisplay(activeQuote.quote)
  const referencePreparationBlocked = Boolean(referencePreparation.busy || referencePreparation.error || quoteOverride?.preparingReferences)
  const authoritativeQuote = quotedCredits != null && !referencePreparationBlocked
  const serverQuoteExpected = Boolean(canvasRuntime && creditsVisible)
  const quoteInputReason = serverQuoteExpected && !pricingLoading && activeCanvasQuote.status === 'IDLE'
    ? ordinaryQuote.error || submitDisabledReason || (node.data.kind === 'text' && !promptDraft.trim() ? '输入要求后获取报价'
      : !pricingModel && (node.data.kind === 'image' || node.data.kind === 'video') ? '请选择当前业务可用的模型'
        : '请完善当前模型所需的报价参数') : ''
  const isFree = authoritativeQuote
    ? Boolean(activeQuote.quote?.isFree || (!canvasRuntime && quotedCredits === 0))
    : !serverQuoteExpected && localIsFree
  const credits = authoritativeQuote ? quotedCredits : serverQuoteExpected ? 0 : localCredits
  const setPromptDraft = useCallback((value: string, source = node.data.prompt) => {
    setRejectedInput(null)
    setDraft({ nodeId: node.id, source, value })
    onPromptDraftChange?.(value)
  }, [node.data.prompt, node.id, onPromptDraftChange])


  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMentionPanel(null)
      setExpanded(false)
      setAdvancedOpen(false)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [node.id])

  const commitPrompt = useCallback((value = promptDraft) => {
    if (value !== node.data.prompt) updateNodeData(node.id, { prompt: value })
  }, [node.data.prompt, node.id, promptDraft, updateNodeData])

  const dismissMentionPanel = useCallback((mode: MentionPanelState['mode']) => {
    if (mode === 'trigger') {
      const nextPrompt = promptEditorRef.current?.discardPendingMention()
      if (nextPrompt != null) {
        setPromptDraft(nextPrompt, nextPrompt)
        commitPrompt(nextPrompt)
      }
    }
    setMentionPanel(null)
  }, [commitPrompt, setPromptDraft])

  const voiceEnabled = studioMode === 'free' && !readOnly && (!canvasRuntime || (canvasRuntime.canEdit && canvasRuntime.canMutate))
    && !task && !submitting
  const isVoiceCurrent = () => {
    const snapshot = voiceDraftRef.current
    const state = useStudioUiStore.getState()
    const currentNode = state.nodes.find((item) => item.id === snapshot?.nodeId)
    return Boolean(snapshot && state.scopeKey === snapshot.scopeKey && state.studioMode === 'free'
      && state.activeNodeId === snapshot.nodeId && currentNode?.data.prompt === snapshot.expected)
  }
  const saveVoicePrompt = (value: string) => {
    const snapshot = voiceDraftRef.current
    if (!snapshot || !isVoiceCurrent() || value === snapshot.expected) return
    snapshot.expected = value
    updateNodeData(snapshot.nodeId, { prompt: value })
  }
  const voice = useStudioSpeechInput({
    scopeKey: `${scopeKey}:${node.id}`,
    enabled: voiceEnabled,
    isCurrent: isVoiceCurrent,
    onText: (text, confirmed) => {
      const snapshot = voiceDraftRef.current
      if (!snapshot || !isVoiceCurrent()) return
      const prefix = snapshot.base && !/\s$/.test(snapshot.base) ? `${snapshot.base}\n` : snapshot.base
      const candidate = prefix + text
      const limit = resolvePromptMaxLength(candidate)
      // Never trim existing content or split a UTF-16 surrogate pair at the limit.
      const fit = (suffix: string) => {
        let value = ''
        for (const character of suffix) {
          if (prefix.length + value.length + character.length > limit) break
          value += character
        }
        return value ? prefix + value : snapshot.base
      }
      snapshot.value = text ? fit(text) : snapshot.base
      // Only final results are saved; interim text is shown in the editor and may still be corrected.
      saveVoicePrompt(confirmed ? fit(confirmed) : snapshot.base)
      setPromptDraft(snapshot.value, snapshot.expected)
      promptEditorRef.current?.setFromPrompt(snapshot.value, snapshot.refs)
      promptEditorRef.current?.scrollToEnd()
      if (candidate.length > limit) {
        voice.stop()
        message.warning(`提示词已达到 ${limit.toLocaleString('zh-CN')} 个字符，语音输入已停止`)
      }
    },
    onFinish: () => {
      const snapshot = voiceDraftRef.current
      if (!snapshot || !isVoiceCurrent()) return
      if (!snapshot.value) snapshot.value = snapshot.previous
      saveVoicePrompt(snapshot.value)
      setPromptDraft(snapshot.value, snapshot.expected)
      promptEditorRef.current?.setFromPrompt(snapshot.value, snapshot.refs)
    }
  })
  useEffect(() => {
    if (voice.error) message.error(voice.error)
  }, [voice.error])
  const startVoice = () => {
    if (voice.active || !voiceEnabled) return
    if (mentionPanel) dismissMentionPanel(mentionPanel.mode)
    setAdvancedOpen(false)
    const refs = node.data.composerRefs ?? []
    const previous = promptEditorRef.current?.getPrompt() ?? promptDraft
    // 先清空正文。空文档才会显示「聆听中…」，后续识别结果从空文档写入。
    // 没识别到文字就结束时，把清空前的正文放回去。
    voiceDraftRef.current = {
      nodeId: node.id, scopeKey, base: '', expected: '', value: '', previous, refs
    }
    updateNodeData(node.id, { prompt: '' })
    setPromptDraft('', '')
    promptEditorRef.current?.setFromPrompt('', refs)
    voice.start()
  }
  // Stop immediately on store changes, rather than waiting for the next browser event.
  useEffect(() => {
    if (!voice.active) return
    return useStudioUiStore.subscribe(() => {
      if (!isVoiceCurrent()) voice.stop()
    })
    // The guard reads the fixed session identity and the live store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.active, voice.stop])

  /** 正文 @ / 点缩略图 / 点 chip 再选：只写 mention 通道，不上缩略图条、不改首尾帧。 */
  const insertInlineMention = useCallback((base: StudioComposerRef) => {
    const editor = promptEditorRef.current
    if (!editor) return
    const current = useStudioUiStore.getState().nodes.find(item => item.id === node.id)
    if (!current) return
    const appended = appendComposerRefInstance(current.data.composerRefs, {
      kind: base.kind,
      nodeId: base.nodeId,
      assetId: base.assetId,
      title: base.title,
      mediaKind: base.mediaKind,
      previewUrl: base.previewUrl,
      sourceKey: base.sourceKey ?? sourceKeyOfRef(base),
      channel: 'mention'
    })
    editor.insertMention(appended.ref)
    editor.focus()
    const nextPrompt = editor.getPrompt()
    updateNodeData(node.id, {
      prompt: nextPrompt,
      composerRefs: appended.refs
    })
    setPromptDraft(nextPrompt, nextPrompt)
    setMentionPanel(null)
  }, [node.id, setPromptDraft, updateNodeData])

  const removeReference = useCallback((ref: StudioComposerRef) => {
    promptEditorRef.current?.removeMentionById(ref.id)
    const nextPrompt = promptEditorRef.current?.getPrompt() ?? promptDraft
    const removedRef = removeComposerReference(node.id, ref.id, nextPrompt)
    if (!removedRef) return
    setPromptDraft(nextPrompt, nextPrompt)
    revokeStudioComposerRefPreview(removedRef)
  }, [node.id, promptDraft, removeComposerReference, setPromptDraft])

  const runAutoLink = useCallback((rawPrompt: string): string => {
    if (!showAdvanced || !isStudioAutoLinkEnabled(node.data.generationOptions)) return rawPrompt

    const size = {
      width: node.measured?.width ?? node.width ?? 280,
      height: node.measured?.height ?? node.height ?? 196
    }
    const targetCenter = {
      x: node.position.x + size.width / 2,
      y: node.position.y + size.height / 2
    }
    const nodes = useStudioUiStore.getState().nodes
    const candidates = collectStudioAutoLinkCandidates({ target: node, nodes })
    const existingRefIds = new Set((node.data.composerRefs ?? []).map((ref) => ref.id))
    const existingSourceKeys = new Set((node.data.composerRefs ?? []).map((ref) => sourceKeyOfRef(ref)))
    const result = applyStudioAutoLink({
      prompt: rawPrompt,
      targetNodeId: node.id,
      targetKind: node.data.kind === 'video' ? 'video' : 'image',
      targetCenter,
      candidates,
      existingRefIds,
      existingSourceKeys
    })
    if (!result.changed) return rawPrompt

    let nextRefs = node.data.composerRefs
    let nextOptions = node.data.generationOptions ?? {}
    for (const item of result.refs) {
      const appended = appendComposerRefInstance(nextRefs, {
        kind: 'node',
        nodeId: item.nodeId,
        title: item.title,
        mediaKind: item.mediaKind,
        previewUrl: item.previewUrl,
        sourceKey: item.sourceKey,
        channel: 'mention'
      })
      nextRefs = appended.refs
      if (node.data.kind === 'video' && isComposerRefFrameEligible(appended.ref)) {
        const replacement = replaceStudioVideoReference(nextRefs, nextOptions, appended.ref)
        nextRefs = replacement.composerRefs
        nextOptions = replacement.generationOptions
      }
    }
    updateNodeData(node.id, {
      prompt: result.prompt,
      composerRefs: nextRefs,
      generationOptions: nextOptions
    })
    setPromptDraft(result.prompt, result.prompt)
    promptEditorRef.current?.setFromPrompt(result.prompt, nextRefs ?? [])
    return result.prompt
  }, [node, setPromptDraft, showAdvanced, updateNodeData])

  const reportRejectedLength = (length: number, limit: number) => {
    setRejectedInput({ node: node.id, model: node.data.model, capability: selectedCapability, prompt: promptDraft,
      message: `本次输入共 ${length.toLocaleString('zh-CN')} 个字符，超过当前模型的 ${limit.toLocaleString('zh-CN')} 字符上限，已保留原文。` })
  }
  const rejectedMessage = rejectedInput?.node === node.id && rejectedInput.model === node.data.model
    && rejectedInput.capability === selectedCapability && rejectedInput.prompt === promptDraft ? rejectedInput.message : ''
  const generationBlockReason = !task && canvasRuntime ? canvasComposerInputFeedback({
    ruleError: promptError,
    referenceError: referencePreparation.error,
    quoteError: activeQuote.error || ordinaryQuote.error,
    disabledReason: submitDisabledReason || (!onSubmit ? '当前节点尚未接入真实提交接口，请使用节点工具完成操作' : ''),
    idleReason: quoteInputReason,
    missingPrompt: !promptDraft.trim() && !canSendEmpty,
    unmatched: activeQuote.quote?.matched === false,
    loading: Boolean(pricingLoading || activeQuote.loading || referencePreparation.busy)
  }) : ''

  const submit = async () => {
    if (voice.active) return
    const latest = promptEditorRef.current?.getPrompt() ?? promptDraft
    const raw = latest.trim()
    if ((!raw && !canSendEmpty) || submittingRef.current) return
    if (!onSubmit || submitDisabledReason || referencePreparationBlocked) return
    if (serverQuoteExpected && !authoritativeQuote) {
      activeCanvasQuote.refresh?.()
      return
    }
    if (canvasRuntime) {
      const promptMaxLength = resolvePromptMaxLength(latest)
      if (latest.length > promptMaxLength) {
        message.warning(`提示词不能超过 ${promptMaxLength.toLocaleString('zh-CN')} 个字符`)
        return
      }
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      commitPrompt(latest)
      const linked = resolveCanvasQuoteRequest ? latest : runAutoLink(latest)
      const submittedPrompt = canvasRuntime ? linked : linked.trim()
      if (!submittedPrompt.trim() && !canSendEmpty) return
      if (usesGenerationQuote && canvasRuntime && ordinaryKind && pricingModel) {
        const current = useStudioUiStore.getState().nodes.find(item => item.id === node.id)
        if (!current) throw new Error('节点已变化，请重新选择')
        const projected = !current.data.model && node.data.model ? { ...current, data: { ...current.data, model: node.data.model,
          generationOptions: node.data.generationOptions } } : current
        const request = canvasRuntime.prepareGenerationQuote(ordinaryKind, projected, pricingModel, submittedPrompt)
        if (JSON.stringify(request) !== JSON.stringify(ordinaryQuote.input?.request)) {
          activeCanvasQuote.refresh?.()
          return
        }
      }
      if (resolveCanvasQuoteRequest) {
        const currentRequest = resolveCanvasQuoteRequest(submittedPrompt.trim())
        if (!currentRequest) throw new Error('当前图片 Skill 报价参数已失效，请重新选择')
        if (!canvasQuote.quote || JSON.stringify(currentRequest) !== JSON.stringify(canvasQuoteRequest)) {
          await requestCanvasImageQuote(currentRequest)
        }
      }
      await onSubmit(submittedPrompt)
    } catch (error: unknown) {
      message.error(canvasRuntime ? canvasErrorMessage(error, '生成失败') : apiErrorMessage(error, '生成失败'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const openMentionPanelAt = useCallback((
    mode: MentionPanelState['mode'],
    query: string,
    rect: DOMRect | null
  ) => {
    if (!rect) return
    setMentionPanel({
      mode,
      query,
      anchor: {
        top: rect.bottom + 6,
        left: rect.left,
        maxHeight: Math.max(180, window.innerHeight - rect.bottom - 24),
        placement: 'below'
      }
    })
  }, [])

  const requestOpenCamera = useCallback((input: Omit<StudioCameraLibraryRequest, 'seq'>) => {
    cameraRequestSerial.current += 1
    setCameraRequest({ ...input, seq: cameraRequestSerial.current })
  }, [])
  const writeCameraPrompt = useCallback(() => {
    const nextPrompt = promptEditorRef.current?.getPrompt()
    if (nextPrompt == null) return
    setPromptDraft(nextPrompt, nextPrompt)
    if (nextPrompt !== node.data.prompt) updateNodeData(node.id, { prompt: nextPrompt })
  }, [node.data.prompt, node.id, setPromptDraft, updateNodeData])
  const insertCameraMark = useCallback((draft: StudioCameraMarkDraft) => {
    promptEditorRef.current?.insertCameraMark({ ...draft, id: createStudioCameraMarkId() })
    writeCameraPrompt()
  }, [writeCameraPrompt])
  const replaceCameraMark = useCallback((id: string, draft: StudioCameraMarkDraft) => {
    promptEditorRef.current?.replaceCameraMark(id, { ...draft, id })
    writeCameraPrompt()
  }, [writeCameraPrompt])
  const cameraLibraryController = useMemo(() => cameraLibrary ? {
    request: cameraRequest,
    requestOpen: requestOpenCamera,
    insertMark: insertCameraMark,
    replaceMark: replaceCameraMark
  } : null, [cameraLibrary, cameraRequest, insertCameraMark, replaceCameraMark, requestOpenCamera])

  const upstreamThumbs = useMemo(() => {
    if (!richPrompt) return []
    void upstreamSignature
    const { nodes, edges } = useStudioUiStore.getState()
    const attachedNodeIds = new Set((node.data.composerRefs ?? [])
      .filter((ref) => isComposerRefStripVisible(ref))
      .map((ref) => ref.nodeId)
      .filter(Boolean))
    return listStudioComposerUpstreamThumbs(node.id, nodes, edges)
      .filter((item) => !attachedNodeIds.has(item.nodeId))
      .map((item) => ({
      key: item.key,
      previewUrl: item.previewUrl,
      title: item.title,
      mediaKind: item.mediaKind,
      nodeId: item.nodeId,
      onInsert: () => insertInlineMention({
        id: `node:${item.nodeId}`,
        kind: 'node',
        nodeId: item.nodeId,
        title: item.title,
        mediaKind: item.mediaKind,
        previewUrl: item.previewUrl,
        sourceKey: `node:${item.nodeId}`
      })
      }))
  }, [insertInlineMention, node.data.composerRefs, node.id, richPrompt, upstreamSignature])

  const quoteFeedbackError = pricingLoading ? '' : referencePreparation.error || activeQuote.error || quoteInputReason
    || (activeQuote.quote?.matched === false ? '当前参数没有可用计费规则' : '')
  const quoteFeedbackStatus = serverQuoteExpected ? pricingLoading ? 'LOADING' : activeCanvasQuote.status : undefined
  const quoteFeedbackLoading = Boolean(serverQuoteExpected && (pricingLoading || activeQuote.loading))
  const imageIssues = ordinaryCanvasQuote.referenceIssues
  const quoteReferenceIds = ordinaryQuote.input?.request.references?.map(ref => ref.resourceId).join(',') ?? ''
  const groups = useMemo(() => {
    const result = new Map<string, VideoReferenceIssueGroup>()
    if (!usesGenerationQuote || pricingLoading || !imageIssues?.length) return result
    const allowed = new Set(quoteReferenceIds.split(','))
    for (const issue of imageIssues) {
      if (!allowed.has(issue.resourceId)) continue
      const existing = result.get(issue.resourceId)
      if (existing) existing.issues.push(issue)
      else result.set(issue.resourceId, { resourceId: issue.resourceId, index: issue.index, issues: [issue] })
    }
    return result
  }, [imageIssues, quoteReferenceIds, pricingLoading, usesGenerationQuote])

  const referenceIndex = useMemo(() => {
    const ids = [...new Set(quoteReferenceIds.split(','))].filter(id => canvasRuntime?.resourceById(id)?.mediaType === 'IMAGE')
    return new Map(ids.map((id, index) => [id, index + 1]))
  }, [canvasRuntime, quoteReferenceIds])

  const issueForRef = useCallback((ref: Pick<StudioComposerRef, 'nodeId' | 'assetId' | 'kind' | 'mediaKind' | 'previewUrl'>) => {
    if (!groups.size || ref.mediaKind !== 'image') return undefined
    const get = (id: string) => {
      const index = groups.get(id)?.index ?? referenceIndex.get(id)
      return index ? { resourceId: id, index, invalid: groups.has(id) } : undefined
    }
    if (ref.kind !== 'asset' && ref.kind !== 'library' && ref.assetId) {
      const direct = get(String(ref.assetId))
      if (direct) return direct
    }
    const source = useStudioUiStore.getState().nodes.find(item => item.id === ref.nodeId)
    if (!source) return undefined
    const ids = [source.data.canvasPrimaryResourceId, ...(source.data.canvasResourceIds ?? [])]
    for (const id of ids) {
      if (!id) continue
      if (canvasResourceMatchesNodeMedia(canvasRuntime?.resourceById(id), source.data)) {
        const match = get(id)
        if (match) return match
      }
    }
    return undefined
  }, [canvasRuntime, groups, referenceIndex])

  const linkedIssueCount = useMemo(() => {
    if (!groups.size) return 0
    const { nodes, edges } = useStudioUiStore.getState()
    return new Set(listStudioComposerUpstreamThumbs(node.id, nodes, edges)
      .map(item => issueForRef({ ...item, kind: 'node', mediaKind: item.mediaKind ?? 'image' }))
      .map(item => item?.invalid ? item.resourceId : undefined)
      .filter(Boolean)).size
  }, [groups.size, issueForRef, node.id, upstreamSignature])
  useEffect(() => {
    if (linkedIssueCount) return markStudioQuoteReferences(node.id, linkedIssueCount)
  }, [linkedIssueCount, node.id])

  const locateReference = (id: string) => {
    const thumb = frameRef.current?.querySelector<HTMLButtonElement>(
      `[data-invalid-reference="${id}"] .studio-composer-thumbs__hit`
    )
    thumb?.focus()
    thumb?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const referenceIssueAction = (group: VideoReferenceIssueGroup) => {
    if (readOnly || !canvasRuntime?.canMutate) return null
    const state = useStudioUiStore.getState()
    const ref = node.data.composerRefs?.find(item => issueForRef(item)?.resourceId === group.resourceId)
    if (ref && !ref.nodeId && ref.kind === 'upload') return <StudioComposerUploadButton node={node} replaceRef={ref} />
    const sources = state.edges.filter(edge => edge.target === node.id).map(edge => edge.source)
    const source = state.nodes.find(item => (item.id === ref?.nodeId || sources.includes(item.id))
      && issueForRef({ kind: 'node', nodeId: item.id, mediaKind: 'image' })?.resourceId === group.resourceId)
    if (!source) return null
    const crop = group.issues.some(issue => issue.kind === 'ASPECT_RATIO')
    return <button type="button" onClick={() => {
      state.selectNodes([source.id])
      if (crop) state.openImageEditSession({
        mode: 'crop', nodeId: source.id, aspectRatio: 'original', rect: fullCropRect()
      })
      window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('studio:focus-node', {
        detail: { nodeId: source.id }
      })))
    }}>{crop ? '裁剪原图' : '定位原图'}</button>
  }

  return (
    <StudioCameraLibraryProvider value={cameraLibraryController}>
    <div
      ref={frameRef}
      className={`studio-composer${expanded ? ' is-expanded' : ''}${presentation?.centered ? ' is-centered' : ''}`}
      onContextMenu={studioMode === 'free' && node.data.status === 'empty' && !node.data.mediaUrl?.trim()
        ? (event) => {
            event.preventDefault()
            event.stopPropagation()
          }
        : undefined}
    >
      <div className="studio-composer__top">
        <div>{!presentation?.expandOnly ? topLeft : null}</div>
        <div className="studio-composer__top-end">
          {!presentation?.expandOnly ? headerTools : null}
          {!presentation?.centered && !presentation?.expandOnly ? topRight : null}
          {presentation?.centered ? <StudioCanvasTooltip title="还原到节点底部">
            <button type="button" className="studio-composer__expand is-active" aria-label="缩小输入面板" onClick={presentation.toggleCentered}>
              <StudioIconGlyph name="composerRestore" />
            </button>
          </StudioCanvasTooltip> : <>
          {!presentation?.expandOnly && (studioMode === 'free' ? <StudioCanvasTooltip title={expanded ? '还原输入框高度' : '拉高输入框'}>
            <button type="button" className={`studio-composer__expand${expanded ? ' is-active' : ''}`} aria-label={expanded ? '还原输入框高度' : '拉高输入框'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>
              <StudioIconGlyph name={expanded ? 'composerShorten' : 'composerGrow'} />
            </button>
          </StudioCanvasTooltip> : <Tooltip title={expanded ? '还原输入框' : '放大输入框'}>
            <button
              type="button"
              className={`studio-composer__expand${expanded ? ' is-active' : ''}`}
              aria-label={expanded ? '还原输入框' : '放大输入框'}
              aria-pressed={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <CompressOutlined /> : <ExpandAltOutlined />}
            </button>
          </Tooltip>)}
          {presentation ? <StudioCanvasTooltip title="在画布中央放大编辑">
            <button type="button" className="studio-composer__expand" aria-label="放大输入面板" onClick={presentation.toggleCentered}>
              <StudioIconGlyph name="expand" />
            </button>
          </StudioCanvasTooltip> : null}
          </>}
        </div>
      </div>
      <div className="studio-composer__body">
        <StudioComposerAttachmentStrip
          upstream={upstreamThumbs}
          refs={node.data.composerRefs}
          onInsert={insertInlineMention}
          showMention={richPrompt}
          onRemove={removeReference}
          issueForRef={issueForRef}
        />
        {!readOnly ? (
          <div className={`studio-composer__prompt-wrap${promptLeading ? ' has-leading' : ''}${expanded ? ' is-expanded' : ''}`}>
            {promptLeading ? (
              <div className="studio-composer__prompt-leading">{promptLeading}</div>
            ) : null}
            {richPrompt ? (
              <StudioComposerPromptEditor
                key={node.id}
                ref={promptEditorRef}
                placeholder={voice.active ? '聆听中…' : placeholder}
                readOnly={voice.active}
                initialPrompt={voice.active ? promptDraft : node.data.prompt}
                initialRefs={node.data.composerRefs ?? []}
                onPromptChange={(prompt) => {
                  // 一期：按键只改本地 draft，禁止每键 updateNodeData 打满整图。
                  setPromptDraft(prompt)
                }}
                onBlurCommit={(prompt) => {
                  const state = useStudioUiStore.getState()
                  if (voice.active || state.scopeKey !== scopeKey || !state.nodes.some(item => item.id === node.id)) return
                  commitPrompt(prompt)
                  runAutoLink(prompt)
                }}
                onMentionTrigger={(query, rect) => {
                  openMentionPanelAt('trigger', query, rect)
                }}
                onMentionDismiss={() => {
                  setMentionPanel((current) => (current?.mode === 'trigger' ? null : current))
                }}
                onMentionChipClick={(_attrs, rect) => {
                  openMentionPanelAt('chip', '', rect)
                }}
                onCameraMarkClick={cameraLibrary ? (mark) => requestOpenCamera({
                  tab: mark.kind,
                  replaceId: mark.id,
                  optionKey: mark.optionKey
                }) : undefined}
                onSubmit={() => void submit()}
                onRejectedLength={reportRejectedLength}
                resolveMaxLength={canvasRuntime ? resolvePromptMaxLength : undefined}
              />
            ) : (
              <textarea
                value={promptDraft}
                readOnly={voice.active}
                rows={3}
                placeholder={voice.active ? '聆听中…' : placeholder}
                onChange={(event) => {
                  const nextPrompt = event.target.value
                  if (canvasRuntime && !canApplyStudioComposerPromptChange(
                    promptDraft,
                    nextPrompt,
                    resolvePromptMaxLength
                  )) {
                    reportRejectedLength(nextPrompt.length, resolvePromptMaxLength(nextPrompt))
                    return
                  }
                  setPromptDraft(nextPrompt)
                }}
                onBlur={() => { if (!voice.active) commitPrompt() }}
              />
            )}
            {richPrompt && mentionPresence.rendered && displayedMentionPanel ? (
              <StudioMentionPanel
                target={node}
                query={displayedMentionPanel.query}
                anchor={displayedMentionPanel.anchor}
                exiting={mentionPresence.exiting}
                onSelect={(ref) => insertInlineMention(ref)}
                onDismiss={() => {
                  if (mentionPanel) dismissMentionPanel(mentionPanel.mode)
                }}
                onQueryChange={(query) => {
                  setMentionPanel((current) => (current ? { ...current, query } : current))
                }}
              />
            ) : null}
          </div>
        ) : null}
        {promptTrailing}
        {showAdvanced && advancedOpen && !presentation?.expandOnly ? (
          <div ref={advancedPanelRef} id={advancedPanelId} role="region" aria-label="高级设置">
          <StudioComposerAdvancedSettings
            autoLinkEnabled={autoLinkEnabled}
            onAutoLinkChange={(autoLink) => {
              updateNodeData(node.id, {
                generationOptions: { ...node.data.generationOptions, autoLink }
              })
            }}
          />
          </div>
        ) : null}
      </div>
      {groups.size > 0 ? (
        <StudioVideoReferenceErrors groups={[...groups.values()]} onLocate={locateReference} renderAction={referenceIssueAction} />
      ) : null}
      <div className="studio-composer__footer">
        <div className="studio-composer__tools">{attachmentControl === undefined ? <StudioComposerUploadButton node={node} /> : attachmentControl}{bottomLeft}</div>
        <div className="studio-composer__actions">
          <StudioComposerVoiceInput
            visible={studioMode === 'free' && !readOnly}
            active={voice.active}
            state={voice.state}
            level={voice.level}
            disabledReason={!voiceEnabled ? '当前节点不可编辑或任务正在运行' : voice.unavailable}
            onStart={startVoice}
            onStop={voice.stop}
            leading={showAdvanced ? (
              <Tooltip title="高级设置">
                <button
                  type="button"
                  className={`studio-composer__advanced-trigger${advancedOpen ? ' is-active' : ''}`}
                  aria-label="高级设置"
                  aria-pressed={advancedOpen}
                  aria-expanded={advancedOpen}
                  aria-controls={advancedOpen ? advancedPanelId : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const latest = promptEditorRef.current?.getPrompt() ?? promptDraft
                    commitPrompt(latest)
                    runAutoLink(latest)
                    setAdvancedOpen((value) => !value)
                  }}
                >
                  <StudioChromeIcon name="skillSettings" fallback={<SlidersOutlined />} />
                </button>
              </Tooltip>
            ) : null}
            trailing={showSend ? (
              <StudioCreditSendButton
                credits={credits}
                isFree={isFree}
                showCredits={creditsVisible}
                hasContent={Boolean(promptDraft.trim()) || canSendEmpty}
                mode="agent"
                loading={Boolean(task || submitting)}
                className="studio-composer__send"
                onSend={() => void submit()}
                authoritative={authoritativeQuote}
                pendingQuote={Boolean(serverQuoteExpected && !authoritativeQuote)}
                estimateLoading={quoteFeedbackLoading}
                estimateLoadingLabel={pricingLoading ? '读取模型' : undefined}
                estimateError={quoteFeedbackError}
                quoteStatus={quoteFeedbackStatus}

                disabled={Boolean(promptError || submitDisabledReason || !onSubmit || referencePreparationBlocked || (serverQuoteExpected && !authoritativeQuote))}
                disabledReason={rejectedMessage || generationBlockReason || submitDisabledReason || (!onSubmit ? '当前节点尚未接入真实提交接口，请使用节点工具完成操作' : '')}
              />
            ) : null}
          />
        </div>
      </div>
    </div>
    </StudioCameraLibraryProvider>
  )
}
