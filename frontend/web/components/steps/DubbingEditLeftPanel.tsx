'use client'

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState
} from 'react'
import { Button, Upload, message } from 'antd'
import type { UploadFile, UploadProps } from 'antd'
import {
  CaretRightOutlined,
  DeleteOutlined,
  UserOutlined,
  RightOutlined,
  DownOutlined,
  UpOutlined,
  InboxOutlined
} from '@ant-design/icons'
import RichTextEditor from '~/components/common/RichTextEditor'
import { BillingQuoteHint } from '~/components/common/BillingQuoteHint'
import { useBillingQuote } from '~/hooks/useBillingQuote'
import type { BillingQuoteRequest } from '~/types/business-api'
import { htmlPlainTextLength, isHtmlContentEmpty } from '~/utils/htmlPlain'
import { userReferenceAudioUploadFile } from '~/utils/business/voice'
import './DubbingEditLeftPanel.css'

export interface DubbingEditLeftPanelProps {
  dialogue: string
  emotion: string
  /** 情绪选项（由父弹窗拉取 tags 后下发，避免重复请求） */
  emotionOptions?: string[]
  lipSync: boolean
  voiceName: string
  voiceAvatarUrl?: string
  /** 试听接口请求中 */
  ttsPreviewLoading?: boolean
  /** 试听音频播放中（展示动效） */
  ttsPreviewPlaying?: boolean
  /** 最近一次试听成功后的音频时长（秒） */
  ttsPreviewDurationSec?: number | null
  billingRequest?: BillingQuoteRequest | null
  storyboardId?: number
  projectId: number
  episodeId: number
  onDialogueChange: (v: string) => void
  onEmotionChange: (v: string) => void
  onLipSyncChange: (v: boolean) => void
  onVoiceNameChange: (v: string) => void
  onPreviewListen: () => void
  onPickVoice: () => void
  onStartDubbing: (payload: { mode: 'tts' | 'upload'; localFile: File | null; referenceAudioId?: number }) => void
}

/** 原 defineExpose({ leftTab, getLocalAudioFile }) 契约 */
export interface DubbingEditLeftPanelHandle {
  readonly leftTab: 'tts' | 'upload'
  getLocalAudioFile: () => File | null
}

const EMOTION_GRID_COLS = 3
const EMOTION_COLLAPSED_ROWS = 4
const EMOTION_COLLAPSED_COUNT = EMOTION_GRID_COLS * EMOTION_COLLAPSED_ROWS

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function formatPreviewDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  return `${sec.toFixed(1)} 秒`
}

export const DubbingEditLeftPanel = forwardRef<
  DubbingEditLeftPanelHandle,
  DubbingEditLeftPanelProps
>(function DubbingEditLeftPanel(
  {
    dialogue,
    emotion,
    emotionOptions = [],
    lipSync,
    voiceName,
    voiceAvatarUrl,
    ttsPreviewLoading = false,
    ttsPreviewPlaying = false,
    ttsPreviewDurationSec = null,
    billingRequest = null,
    storyboardId,
    projectId,
    episodeId,
    onDialogueChange,
    onEmotionChange,
    onLipSyncChange,
    onPreviewListen,
    onPickVoice,
    onStartDubbing
  },
  ref
) {
  const lipSyncLabelId = useId()
  const EMOTIONS = emotionOptions?.length
    ? emotionOptions
    : ['中性', '开心', '悲伤', '愤怒', '激动']

  const [emotionExpanded, setEmotionExpanded] = useState(false)
  const [emotionModel, setEmotionModel] = useState(emotion || '中性')

  const emotionOverflowCount = Math.max(0, EMOTIONS.length - EMOTION_COLLAPSED_COUNT)

  /** 折叠时固定 4 行；若当前选中不在前 12 项，替换末位以保证选中可见 */
  const visibleEmotions = (() => {
    const all = EMOTIONS
    if (emotionExpanded || all.length <= EMOTION_COLLAPSED_COUNT) return all
    const head = all.slice(0, EMOTION_COLLAPSED_COUNT)
    const selected = String(emotionModel || '').trim()
    if (!selected || head.includes(selected)) return head
    const next = head.slice(0, EMOTION_COLLAPSED_COUNT - 1)
    next.push(selected)
    return next
  })()

  const [leftTab, setLeftTab] = useState<'tts' | 'upload'>('tts')
  const leftTabRef = useRef(leftTab)
  leftTabRef.current = leftTab
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([])
  const localAudioFileRef = useRef<File | null>(null)
  const [localFile, setLocalFile] = useState<File | null>(null)
  const [localAudioUrl, setLocalAudioUrl] = useState('')
  const [referenceAudioId, setReferenceAudioId] = useState<number>()
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const uploadFlight = useRef<Promise<void> | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!localFile) {
      setLocalAudioUrl('')
      return
    }
    const url = URL.createObjectURL(localFile)
    setLocalAudioUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [localFile])

  const [dialogueModel, setDialogueModel] = useState(dialogue)
  const dialoguePlainLen = htmlPlainTextLength(dialogueModel)
  const [lipSyncModel, setLipSyncModel] = useState(lipSync)
  const [voiceNameModel, setVoiceNameModel] = useState(voiceName)
  const voiceNameModelRef = useRef(voiceNameModel)
  voiceNameModelRef.current = voiceNameModel
  const dialogueModelRef = useRef(dialogueModel)
  dialogueModelRef.current = dialogueModel
  const [viewportHeight, setViewportHeight] = useState(1080)
  const usingRecording = leftTab === 'upload'
  const needsRecordingQuote = usingRecording && lipSyncModel
  const request: BillingQuoteRequest | null = usingRecording
    ? needsRecordingQuote && storyboardId && referenceAudioId
      ? { quoteType: 'STORYBOARD_LIP_SYNC', payload: { storyboardId, referenceAudioId } }
      : null
    : billingRequest
  const dubbingQuote = useBillingQuote(request)
  const billingError = usingRecording ? uploadError || dubbingQuote.error : dubbingQuote.error
  const estimatePending = uploading || dubbingQuote.loading
  const quoteRequired = !usingRecording || lipSyncModel
  const quoteReady = Boolean(request && dubbingQuote.quote && !estimatePending && !billingError)

  const dubbingEditorHeight = (() => {
    const vp = clamp(viewportHeight, 768, 1400)
    const ratio = (vp - 768) / (1400 - 768)
    const height = Math.round(96 + ratio * (190 - 96))
    return `${height}px`
  })()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const updateViewportHeight = () => {
      setViewportHeight(window.innerHeight)
    }
    updateViewportHeight()
    window.addEventListener('resize', updateViewportHeight)
    return () => {
      window.removeEventListener('resize', updateViewportHeight)
    }
  }, [])

  // 原 watch(props.*)：父级回写时同步本地模型
  useEffect(() => {
    setDialogueModel(dialogue)
  }, [dialogue])
  useEffect(() => {
    setEmotionModel(emotion || '中性')
  }, [emotion])
  useEffect(() => {
    setLipSyncModel(!!lipSync)
  }, [lipSync])
  useEffect(() => {
    setVoiceNameModel(voiceName || '')
  }, [voiceName])

  // 原 watch(xxxModel) → emit('update:xxx')：本地变更时通知父级
  function updateDialogueModel(v: string) {
    setDialogueModel(v)
    onDialogueChange(v)
  }
  function updateEmotionModel(v: string) {
    setEmotionModel(v)
    onEmotionChange(v)
  }
  function updateLipSyncModel(v: boolean) {
    setLipSyncModel(v)
    onLipSyncChange(v)
  }

  function selectRecording(file: File | null) {
    localAudioFileRef.current = file
    uploadFlight.current = null
    setLocalFile(file)
    setReferenceAudioId(undefined)
    setUploadError('')
    setUploading(false)
  }

  const beforeUploadAudio: UploadProps['beforeUpload'] = (file) => {
    selectRecording(file)
    return false
  }

  useEffect(() => {
    if (!needsRecordingQuote || !localFile || referenceAudioId || uploadError || uploadFlight.current) return
    const file = localFile
    const isCurrent = () => mounted.current && localAudioFileRef.current === file
    const register = async () => {
      setUploading(true)
      try {
        const recording = await userReferenceAudioUploadFile(file, projectId, episodeId)
        if (isCurrent()) setReferenceAudioId(recording.id)
      } catch (e) {
        const error = e as { msg?: string; message?: string }
        if (isCurrent()) setUploadError(error.msg || error.message || '录音登记失败，请重试。')
      } finally {
        if (isCurrent()) {
          uploadFlight.current = null
          setUploading(false)
        }
      }
    }
    uploadFlight.current = register()
  }, [episodeId, localFile, needsRecordingQuote, projectId, referenceAudioId, uploadError])

  function onRemoveUpload() {
    selectRecording(null)
  }

  function onStartDubbingClick() {
    if (leftTabRef.current === 'upload') {
      if (!localAudioFileRef.current) {
        message.warning('请先上传音频文件')
        return
      }
      onStartDubbing({
        mode: 'upload',
        localFile: localAudioFileRef.current,
        ...(lipSyncModel ? { referenceAudioId } : {})
      })
      return
    }
    if (isHtmlContentEmpty(dialogueModelRef.current)) {
      message.warning('请先为分镜添加台词')
      return
    }
    const vn = (voiceNameModelRef.current || '').trim()
    if (!vn || vn === '无音色') {
      message.warning('请先选择配音音色')
      return
    }
    onStartDubbing({ mode: 'tts', localFile: null })
  }

  useImperativeHandle(ref, () => ({
    get leftTab() {
      return leftTabRef.current
    },
    getLocalAudioFile: () => localAudioFileRef.current
  }))

  return (
    <div className="dubbing-edit-left">
      <div className="config-tabs config-tabs--two">
        <button
          type="button"
          className={`config-tab${leftTab === 'tts' ? ' active' : ''}`}
          onClick={() => setLeftTab('tts')}
        >
          文本朗读
        </button>
        <button
          type="button"
          className={`config-tab${leftTab === 'upload' ? ' active' : ''}`}
          onClick={() => setLeftTab('upload')}
        >
          上传本地配音
        </button>
      </div>

      <div className="dubbing-edit-scroll">
        {leftTab === 'tts' ? (
          <div className="dubbing-left-tts">
            <RichTextEditor
              value={dialogueModel}
              onChange={updateDialogueModel}
              minHeight={dubbingEditorHeight}
              maxHeight={dubbingEditorHeight}
              maxLength={50}
              placeholder="请输入要配音的台词"
              className="dubbing-dialogue-input"
            />
            <div className="dubbing-tts-actions">
              <Button
                type="link"
                className={`dubbing-preview-btn${ttsPreviewPlaying ? ' is-playing' : ''}`}
                loading={ttsPreviewLoading}
                disabled={ttsPreviewLoading}
                onClick={() => onPreviewListen()}
              >
                <span className="dubbing-preview-btn__inner">
                  {ttsPreviewPlaying && !ttsPreviewLoading ? (
                    <span className="voice-preview-eq" aria-hidden="true">
                      <span className="voice-preview-eq-bar voice-preview-eq-bar-1" />
                      <span className="voice-preview-eq-bar voice-preview-eq-bar-2" />
                      <span className="voice-preview-eq-bar voice-preview-eq-bar-3" />
                    </span>
                  ) : !ttsPreviewLoading ? (
                    <CaretRightOutlined />
                  ) : null}
                  <span>
                    {ttsPreviewLoading ? '生成中…' : ttsPreviewPlaying ? '播放中' : '试听'}
                  </span>
                </span>
              </Button>
              <span className="dubbing-tts-hint">试听音色可获取准确的语调时长</span>
              {ttsPreviewDurationSec != null && !ttsPreviewLoading ? (
                <span className="dubbing-tts-duration">
                  时长 {formatPreviewDuration(ttsPreviewDurationSec)}
                </span>
              ) : null}
            </div>
            <div className="dubbing-dialogue-footer">
              <span className="dubbing-char-count">{dialoguePlainLen}/50</span>
              <button
                type="button"
                className="dubbing-clear-btn"
                aria-label="清空"
                onClick={() => updateDialogueModel('')}
              >
                <DeleteOutlined />
              </button>
            </div>

            <div className="dubbing-field dubbing-voice-field">
              <div className="dubbing-field-label">配音音色：</div>
              <button type="button" className="dubbing-voice-picker" onClick={() => onPickVoice()}>
                <div className="dubbing-voice-avatar">
                  {!voiceAvatarUrl ? <UserOutlined /> : <img src={voiceAvatarUrl} alt="" />}
                </div>
                <span className="dubbing-voice-name">{voiceNameModel || '无音色'}</span>
                <RightOutlined className="dubbing-voice-arrow" />
              </button>
            </div>

            <div className="dubbing-field dubbing-emotion-field">
              <div className="dubbing-emotion-header">
                <div className="dubbing-field-label">情感</div>
                {emotionOverflowCount > 0 ? (
                  <span className="dubbing-emotion-count">共 {EMOTIONS.length}</span>
                ) : null}
              </div>
              <div
                className={`dubbing-emotion-shell${
                  !emotionExpanded && emotionOverflowCount > 0 ? ' is-collapsed' : ''
                }`}
              >
                <div className="dubbing-emotion-grid">
                  {visibleEmotions.map((emo) => (
                    <button
                      key={emo}
                      type="button"
                      className={`dubbing-emotion-btn${emotionModel === emo ? ' active' : ''}`}
                      onClick={() => updateEmotionModel(emo)}
                    >
                      {emo}
                    </button>
                  ))}
                </div>
                {!emotionExpanded && emotionOverflowCount > 0 ? (
                  <div className="dubbing-emotion-fade" aria-hidden="true" />
                ) : null}
              </div>
              {emotionOverflowCount > 0 ? (
                <button
                  type="button"
                  className="dubbing-emotion-toggle"
                  aria-expanded={emotionExpanded}
                  onClick={() => setEmotionExpanded((v) => !v)}
                >
                  <span>{emotionExpanded ? '收起' : `展开全部（+${emotionOverflowCount}）`}</span>
                  {emotionExpanded ? (
                    <UpOutlined className="dubbing-emotion-toggle-icon" />
                  ) : (
                    <DownOutlined className="dubbing-emotion-toggle-icon" />
                  )}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="dubbing-left-upload">
            <Upload.Dragger
              fileList={uploadFileList}
              onChange={({ fileList }) => setUploadFileList(fileList)}
              name="file"
              maxCount={1}
              accept="audio/*,.mp3,.wav,.m4a,.aac"
              beforeUpload={beforeUploadAudio}
              onRemove={onRemoveUpload}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽音频文件到此区域</p>
              <p className="ant-upload-hint">支持常见音频格式，将用于本段分镜配音</p>
            </Upload.Dragger>
            {localAudioUrl ? (
              <audio className="dubbing-recording-player" controls preload="metadata" src={localAudioUrl}
                aria-label="试听本地录音" />
            ) : null}
          </div>
        )}
      </div>

      <div className="dubbing-bottom-actions">
        <div className="dubbing-lip-row">
          <span className="dubbing-lip-label" id={lipSyncLabelId}>对口型</span>
          <button
            type="button"
            className="dubbing-lip-switch"
            role="switch"
            aria-labelledby={lipSyncLabelId}
            aria-checked={lipSyncModel}
            onClick={() => updateLipSyncModel(!lipSyncModel)}
          >
            <span className="dubbing-lip-switch__track" aria-hidden="true" />
          </button>
        </div>
        {billingError ? (
          <div className="workflow-quote-error" role="status">
            {billingError}{' '}
            <button type="button" onClick={() => uploadError ? setUploadError('') : dubbingQuote.refresh()}>
              {uploadError ? '重试上传' : '重新报价'}
            </button>
          </div>
        ) : (
          <BillingQuoteHint
            quote={dubbingQuote.quote}
            loading={dubbingQuote.loading}
            active={Boolean(request) || needsRecordingQuote}
            idleText={needsRecordingQuote
              ? (uploading ? '正在上传录音…' : '上传录音后显示对口型报价')
              : ''}
            className="billing-quote-hint--submit"
          />
        )}
        <Button
          type="primary"
          size="large"
          className="dubbing-start-btn"
          disabled={(usingRecording && !localFile) || (quoteRequired && !quoteReady)}
          onClick={onStartDubbingClick}
        >
          {needsRecordingQuote ? '开始对口型' : usingRecording ? '使用本地配音' : '开始配音'}
        </Button>
      </div>
    </div>
  )
})

/** 原 emit('update:voiceName') 契约在 React 侧由 onVoiceNameChange 承接（父级选完音色后回写 props） */
export default DubbingEditLeftPanel
