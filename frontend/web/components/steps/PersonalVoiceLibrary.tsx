'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Button, Input, Pagination, Spin, Upload } from 'antd'
import { AudioOutlined, CheckOutlined, CloudUploadOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { ShimmerImage } from '~/components/common/ShimmerImage'
import { listPersonalVoices, savePersonalVoice, type PersonalVoiceAsset } from '~/utils/business/personalVoice'
import { useAuthPublicConfig } from '~/hooks/useAuthPublicConfig'
import { checkFileAgainstUploadLimits, getUploadMaxSizeMb } from '~/utils/uploadLimitCheck'
import './PersonalVoiceLibrary.css'

const PAGE_SIZE = 12
const AVATAR_EXTENSIONS = ['jpg', 'jpeg', 'png']

function describeFileSize(file: File) {
  const kilobytes = file.size / 1024
  if (kilobytes < 1024) return Math.ceil(kilobytes) + ' KB'
  return (kilobytes / 1024).toFixed(1) + ' MB'
}

function Avatar({ src }: { src?: string }) {
  return (
    <div className="personal-voice-library__avatar" aria-hidden="true">
      {src ? <ShimmerImage src={src} alt="" objectFit="cover" /> : <AudioOutlined />}
    </div>
  )
}

function errorText(error: unknown, fallback: string) {
  const details = error as { message?: string; msg?: string }
  return details?.msg || details?.message || fallback
}

export function PersonalVoiceLibrary({ selectedId, onSelect, onEditorTitleChange }: {
  selectedId?: string
  onEditorTitleChange?: (title: string | null) => void
  onSelect: (voice: PersonalVoiceAsset) => void
}) {
  const { config } = useAuthPublicConfig()
  const uploadConfig = config?.upload
  const avatarLimits = AVATAR_EXTENSIONS.map(ext => getUploadMaxSizeMb(uploadConfig, ext))
  const avatarMaxMb = avatarLimits.every(limit => limit === avatarLimits[0]) ? avatarLimits[0] : null
  const avatarFormatHint = avatarMaxMb === null ? 'JPG / PNG' : `JPG / PNG · 最大 ${avatarMaxMb} MB`
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [items, setItems] = useState<PersonalVoiceAsset[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [editor, setEditor] = useState<{ voice?: PersonalVoiceAsset; name: string; recording?: File; avatar?: File; resetAvatar?: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [playing, setPlaying] = useState<string>()
  const [previewError, setPreviewError] = useState('')
  const audioRef = useRef<HTMLAudioElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const isEditing = editor !== null

  useEffect(() => {
    if (isEditing) formRef.current?.focus({ preventScroll: true })
  }, [isEditing])

  const pickedAvatar = editor?.avatar
  const [avatarPreview, setAvatarPreview] = useState<string>()
  useEffect(() => {
    if (!pickedAvatar) {
      setAvatarPreview(undefined)
      return
    }
    const objectUrl = URL.createObjectURL(pickedAvatar)
    setAvatarPreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [pickedAvatar])
  const editorAvatar = pickedAvatar ? avatarPreview : editor?.resetAvatar ? undefined : editor?.voice?.avatarUrl


  useEffect(() => {
    let active = true
    setLoading(true)
    setListError('')
    listPersonalVoices(page, PAGE_SIZE).then(result => {
      if (!active) return
      setItems(result.items)
      setTotal(result.total)
    }).catch(error => {
      if (active) setListError(errorText(error, '音色列表加载失败'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [page, revision])

  useEffect(() => {
    const audio = audioRef.current
    return () => audio?.pause()
  }, [])

  function stopPreview() {
    audioRef.current?.pause()
    setPlaying(undefined)
  }

  async function preview(voice: PersonalVoiceAsset) {
    const audio = audioRef.current
    if (!audio) return
    const id = String(voice.id)
    stopPreview()
    setPreviewError('')
    if (id === playing) return
    audio.src = voice.audioUrl
    setPlaying(id)
    try {
      await audio.play()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setPlaying(current => current === id ? undefined : current)
      setPreviewError('录音暂时无法播放，请重试')
    }
  }

  function edit(voice?: PersonalVoiceAsset) {
    stopPreview()
    setFormError('')
    setEditor({ voice, name: voice?.assetTitle ?? '' })
    onEditorTitleChange?.(voice ? '编辑音色' : '上传原录音')
  }

  function closeEditor() {
    setEditor(null)
    onEditorTitleChange?.(null)
  }

  function chooseFile(field: 'recording' | 'avatar', file: File) {
    const isRecording = field === 'recording'
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    const allowed = isRecording ? ['mp3', 'wav'] : AVATAR_EXTENSIONS
    if (!file.name.includes('.') || !allowed.includes(extension) || !file.size || (isRecording && file.size > 32 * 1024 * 1024)) {
      setFormError(isRecording ? '请选择不超过 32 MB 的 MP3 或 WAV 文件' : '请选择 JPG 或 PNG 图片')
      return Upload.LIST_IGNORE
    }
    if (!isRecording) {
      const result = checkFileAgainstUploadLimits(file, uploadConfig)
      if (!result.ok) {
        setFormError(result.message)
        return Upload.LIST_IGNORE
      }
    }
    setFormError('')
    setEditor(current => current && { ...current, [field]: file })
    return Upload.LIST_IGNORE
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor || saving) return
    const name = editor.name.trim()
    if (!name || (!editor.voice && !editor.recording)) {
      setFormError(!name ? '请输入展示名称' : '请选择原录音文件')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      await savePersonalVoice({
        id: editor.voice && String(editor.voice.id),
        name,
        file: editor.recording,
        avatar: editor.avatar,
        resetAvatar: Boolean(editor.voice?.avatarUrl && editor.resetAvatar && !editor.avatar)
      })
      if (!editor.voice) setPage(1)
      setRevision(current => current + 1)
      closeEditor()
    } catch (error) {
      setFormError(errorText(error, '保存音色失败'))
    } finally {
      setSaving(false)
    }
  }


  return (
    <section className="personal-voice-library" aria-label="我的音色">
      {editor ? (
        <form ref={formRef} tabIndex={-1} className="personal-voice-library__form" onSubmit={submit}>
          {!onEditorTitleChange && <h3>{editor.voice ? '编辑音色' : '上传原录音'}</h3>}
          <div className="personal-voice-library__fields">
            {!editor.voice && (
              <div className="personal-voice-library__field">
                <span>录音文件</span>
                <Upload.Dragger
                  className={`personal-voice-library__dropzone${editor.recording ? ' has-file' : ''}`}
                  accept=".mp3,.wav" maxCount={1} showUploadList={false} disabled={saving}
                  beforeUpload={file => chooseFile('recording', file)}
                >
                  {editor.recording ? (
                    <div className="personal-voice-library__file-row">
                      <span className="personal-voice-library__file-icon" aria-hidden="true"><AudioOutlined /></span>
                      <div className="personal-voice-library__file-copy">
                        <strong title={editor.recording.name}>{editor.recording.name}</strong>
                        <small>{describeFileSize(editor.recording)}</small>
                      </div>
                      <span className="personal-voice-library__replace">更换文件</span>
                    </div>
                  ) : (
                    <div className="personal-voice-library__dropzone-prompt">
                      <CloudUploadOutlined aria-hidden="true" />
                      <strong>选择录音文件</strong>
                      <small>也可拖到这里 · MP3 / WAV · 最大 32 MB</small>
                    </div>
                  )}
                </Upload.Dragger>
              </div>
            )}
            <label className="personal-voice-library__field">
              <span>展示名称</span>
              <Input aria-required="true" disabled={saving} value={editor.name} maxLength={128}
                placeholder="例如：角色旁白"
                onChange={event => setEditor({ ...editor, name: event.target.value })} />
            </label>
            <div className="personal-voice-library__avatar-field">
              <Avatar src={editorAvatar} />
              <div className="personal-voice-library__avatar-copy">
                <span>头像 <small>选填</small></span>
                {editor.avatar ? (
                  <small className="personal-voice-library__avatar-name" title={editor.avatar.name}>{editor.avatar.name}</small>
                ) : <small>{avatarFormatHint}</small>}
              </div>
              <div className="personal-voice-library__avatar-actions">
                <Upload accept=".jpg,.jpeg,.png" maxCount={1} showUploadList={false} disabled={saving}
                  beforeUpload={file => chooseFile('avatar', file)}>
                  <Button size="small">{editorAvatar ? '更换头像' : '上传头像'}</Button>
                </Upload>
                {editorAvatar && <Button type="text" size="small" className="personal-voice-library__reset" disabled={saving}
                  onClick={() => setEditor({ ...editor, avatar: undefined, resetAvatar: true })}>恢复默认头像</Button>}
              </div>
            </div>
          </div>
          {formError && <Alert type="error" showIcon message={formError} />}
          <footer className="personal-voice-library__form-actions">
            <Button autoInsertSpace={false} onClick={closeEditor} disabled={saving}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>保存音色</Button>
          </footer>
        </form>
      ) : listError ? (
        <Alert type="error" showIcon message={listError} action={
          <Button type="link" onClick={() => setRevision(current => current + 1)}>重试</Button>
        } />
      ) : loading ? (
        <div className="personal-voice-library__empty" role="status">
          <Spin size="small" />
          <span>正在加载音色…</span>
        </div>
      ) : items.length ? (
        <>
          <div className="personal-voice-library__header">
            <p>这些录音可以在流程和画布中跨项目使用。</p>
            <Button icon={<PlusOutlined />} onClick={() => edit()}>上传录音</Button>
          </div>
          {previewError && <Alert type="warning" showIcon message={previewError} />}
          <ul className="personal-voice-library__list">
            {items.map(voice => {
              const id = String(voice.id)
              const seconds = Math.ceil(voice.durationMs / 1000)
              const active = id === selectedId
              const isPlaying = id === playing
              return (
                <li key={id} className={active ? 'is-selected' : undefined}>
                  <Avatar src={voice.avatarUrl} />
                  <div className="personal-voice-library__identity">
                    <strong title={voice.assetTitle}>{voice.assetTitle}</strong>
                    <small>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</small>
                  </div>
                  <div className="personal-voice-library__actions">
                    <Button type="text" title={isPlaying ? '暂停' : '试听'}
                      aria-label={(isPlaying ? '暂停 ' : '试听 ') + voice.assetTitle}
                      icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                      onClick={() => void preview(voice)} />
                    <Button type="text" title="编辑音色" aria-label={'编辑 ' + voice.assetTitle}
                      icon={<EditOutlined />} onClick={() => edit(voice)} />
                    <Button className="personal-voice-library__select" size="small" autoInsertSpace={false}
                      icon={active ? <CheckOutlined /> : undefined}
                      onClick={() => { stopPreview(); onSelect(voice) }}>{active ? '已选用' : '使用'}</Button>
                  </div>
                </li>
              )
            })}
          </ul>
          {total > PAGE_SIZE && <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total}
            showSizeChanger={false} onChange={value => { stopPreview(); setPage(value) }} />}
        </>
      ) : (
        <div className="personal-voice-library__empty">
          <span className="personal-voice-library__empty-icon" aria-hidden="true"><AudioOutlined /></span>
          <div className="personal-voice-library__empty-copy">
            <strong>还没有个人音色</strong>
            <p>上传一段原录音，可在流程和画布中跨项目选用。</p>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>上传录音</Button>
        </div>
      )}
      <audio ref={audioRef} onEnded={() => setPlaying(undefined)} preload="none" hidden />
    </section>
  )
}
