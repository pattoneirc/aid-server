'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Drawer, Input, Modal, Tag, message } from 'antd'
import {
  UndoOutlined,
  RedoOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileAddOutlined,
  HistoryOutlined,
  FileTextOutlined,
  CloseOutlined
} from '@ant-design/icons'
import RichTextEditor from '~/components/common/RichTextEditor'
import ImportScriptModal from './ImportScriptModal'
import { SelectAssetImageModal } from './SelectAssetImageModal'
import { importStoryboardReferenceImages } from './edit-storyboard-image/storyboardReferenceImages'
import type { StoryboardImageReference } from '~/types/business-api'
import { fetchUserStoryboardDetailOnce } from '~/utils/storyboardDetailOnce'
import { htmlToPlainText, isHtmlContentEmpty } from '~/utils/htmlPlain'
import './StoryboardScriptModal.css'

interface Props {
  open: boolean
  panelTitle: string
  initialContent?: string
  onOpenChange: (value: boolean) => void
  storyboardId?: number
  onSave?: (payload: { title: string; content: string; scriptImageReferences?: StoryboardImageReference[] }) => void | Promise<boolean>
  /** 原 @update:title：保存时（onSave 之前）回传标题，空标题回退「未命名」 */
  onTitleChange?: (title: string) => void
}

interface HistoryVersion {
  id: string
  content: string
  createdAt: string
}

const maxHistorySize = 50

export function StoryboardScriptModal({
  open,
  panelTitle = '',
  initialContent = '',
  storyboardId,
  onOpenChange,
  onSave,
  onTitleChange
}: Props) {
  const [localTitle, setLocalTitle] = useState(panelTitle)
  const [localContent, setLocalContent] = useState(initialContent)
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [scriptReferences, setScriptReferences] = useState<StoryboardImageReference[]>()
  const [showReferencePicker, setShowReferencePicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const referenceScope = useRef<{ projectId: number; episodeId: number } | null>(null)

  useEffect(() => {
    if (!open || !storyboardId) return
    let active = true
    void fetchUserStoryboardDetailOnce(storyboardId).then(
      (row) => {
        if (!active) return
        referenceScope.current = { projectId: Number(row.projectId), episodeId: Number(row.episodeId ?? 0) }
        setScriptReferences(row.scriptImageReferences ?? [])
      },
      () => { if (active) message.warning('参考图加载失败，请重新打开分镜脚本') }
    )
    return () => {
      active = false
      referenceScope.current = null
    }
  }, [open, storyboardId])

  const [historyStack, setHistoryStack] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [historyVersions, setHistoryVersions] = useState<HistoryVersion[]>([])

  // 事件回调内读取最新栈状态（避免闭包旧值）
  const historyStackRef = useRef(historyStack)
  historyStackRef.current = historyStack
  const historyIndexRef = useRef(historyIndex)
  historyIndexRef.current = historyIndex
  const localContentRef = useRef(localContent)
  localContentRef.current = localContent

  const canUndo = historyIndex > 0
  const canRedo = historyIndex < historyStack.length - 1

  useEffect(() => {
    setLocalTitle(panelTitle ?? '')
  }, [panelTitle])

  useEffect(() => {
    if (!open) setShowHistoryPanel(false)
  }, [open])

  useEffect(() => {
    if (localContentRef.current !== initialContent) {
      setLocalContent(initialContent)
      if (historyStackRef.current.length === 0) {
        setHistoryStack([initialContent])
        setHistoryIndex(0)
      }
    }
    // 对齐原 watch(() => props.initialContent)：仅 prop 变化触发
  }, [initialContent])

  const saveToHistory = (content: string) => {
    const stack = historyStackRef.current
    const index = historyIndexRef.current
    if (stack[index] === content) return
    const next = stack.slice(0, index + 1)
    next.push(content)
    if (next.length > maxHistorySize) {
      next.shift()
      setHistoryStack(next)
    } else {
      setHistoryStack(next)
      setHistoryIndex(next.length - 1)
    }
  }

  const handleContentChange = (value: string) => {
    setLocalContent(value)
    if (
      historyStackRef.current.length === 0 ||
      historyStackRef.current[historyIndexRef.current] !== value
    ) {
      saveToHistory(value)
    }
  }

  const handleUndo = () => {
    if (canUndo) {
      const nextIndex = historyIndexRef.current - 1
      setHistoryIndex(nextIndex)
      setLocalContent(historyStackRef.current[nextIndex])
    }
  }

  const handleRedo = () => {
    if (canRedo) {
      const nextIndex = historyIndexRef.current + 1
      setHistoryIndex(nextIndex)
      setLocalContent(historyStackRef.current[nextIndex])
    }
  }

  const handleCopy = async () => {
    if (isHtmlContentEmpty(localContentRef.current)) {
      message.warning('没有内容可复制')
      return
    }
    try {
      await navigator.clipboard.writeText(htmlToPlainText(localContentRef.current))
      message.success('已复制到剪贴板')
    } catch {
      message.error('复制失败')
    }
  }

  const handleClear = () => {
    if (isHtmlContentEmpty(localContentRef.current)) return
    Modal.confirm({
      title: '确认清空',
      content: '确定要清空全部分镜脚本内容吗？此操作不可撤销。',
      onOk: () => {
        setLocalContent('')
        saveToHistory('')
        message.success('已清空')
      }
    })
  }

  const selectHistoryVersion = (_version: HistoryVersion) => {
    // 仅用于高亮，恢复用 restoreVersion
  }

  const restoreVersion = (version: HistoryVersion) => {
    setLocalContent(version.content)
    saveToHistory(version.content)
    message.success('已恢复此版本')
    setShowHistoryPanel(false)
  }

  const deleteVersion = (id: string) => {
    setHistoryVersions((prev) => prev.filter((v) => v.id !== id))
    if (selectedHistoryId === id) setSelectedHistoryId(null)
    message.success('已删除')
  }

  const formatTime = (time: string) => {
    return new Date(time).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getPreview = (content: string) => {
    const plain = htmlToPlainText(content)
    if (!plain) return '空内容'
    return plain.length > 100 ? plain.substring(0, 100) + '...' : plain
  }

  const handleImport = (content: string) => {
    setLocalContent(content)
    saveToHistory(content)
    message.success('导入成功')
    setShowImportModal(false)
  }

  const handleSave = async () => {
    const title = localTitle?.trim() || '未命名'
    setSaving(true)
    try {
      const saved = await onSave?.({ title, content: localContentRef.current, scriptImageReferences: scriptReferences })
      if (saved !== false) {
        onTitleChange?.(title)
        onOpenChange(false)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  return (
    <Modal
      open={open}
      width={1000}
      footer={null}
      title={null}
      closable={false}
      className="storyboard-script-modal"
      wrapClassName="create-flow-modal storyboard-script-modal-wrap"
      onCancel={handleCancel}
    >
      <div className="setting-modal-shell">
        <header className="setting-modal-header">
          <div className="modal-title-row">
            <span className="modal-title-prefix">分镜脚本：</span>
            <Input
              value={localTitle}
              onChange={(e) => setLocalTitle(e.target.value)}
              className="modal-title-input"
              placeholder="未命名"
            />
          </div>
          <button type="button" className="setting-modal-close" aria-label="关闭" onClick={handleCancel}>
            <CloseOutlined />
          </button>
        </header>

        <div className="setting-modal-body">
          <div className="modal-content">
            {/* 工具栏 */}
            <div className="toolbar">
              <div className="toolbar-left">
                <button
                  className="toolbar-btn"
                  type="button"
                  disabled={!canUndo}
                  title="撤销"
                  onClick={handleUndo}
                >
                  <UndoOutlined />
                  <span>撤销</span>
                </button>
                <button
                  className="toolbar-btn"
                  type="button"
                  disabled={!canRedo}
                  title="重做"
                  onClick={handleRedo}
                >
                  <RedoOutlined />
                  <span>重做</span>
                </button>
                <button className="toolbar-btn" type="button" title="复制" onClick={handleCopy}>
                  <CopyOutlined />
                  <span>复制</span>
                </button>
                <button className="toolbar-btn" type="button" title="清空" onClick={handleClear}>
                  <DeleteOutlined />
                  <span>清空</span>
                </button>
              </div>
              <div className="toolbar-right">
                <Button icon={<FileAddOutlined />} onClick={() => setShowImportModal(true)}>
                  导入文档
                </Button>
                <Button icon={<HistoryOutlined />} onClick={() => setShowHistoryPanel(true)}>
                  历史版本
                </Button>
              </div>
            </div>

            {/* 文本编辑器（Quill 无工具栏，存 HTML） */}
            <div className="editor-container">
              <RichTextEditor
                value={localContent}
                onChange={handleContentChange}
                className="script-editor"
                placeholder={'可直接输入分镜脚本内容，或点击右上角"导入文档"导入'}
                minHeight="0"
                maxLength={10000}
              />
            </div>
            {storyboardId && (
              <div className="toolbar">
                <Button type="default" loading={importing} disabled={!scriptReferences} onClick={() => setShowReferencePicker(true)}>
                  添加分镜参考图
                </Button>
                {scriptReferences?.map((reference, index) => (
                  <Tag key={reference.imageId ?? reference.sourceUrl} closable
                    onClose={() => setScriptReferences((items) => items?.filter((_, position) => position !== index))}>
                    {reference.name}
                  </Tag>
                ))}
              </div>
            )}
          </div>

          {/* 底部操作栏 */}
          <div className="modal-footer">
            <Button onClick={handleCancel}>
              <div className="text-gradient">取消</div>
            </Button>
            <Button type="primary" loading={saving} disabled={importing} onClick={handleSave}>
              保存
            </Button>
          </div>
        </div>
      </div>

      {/* 历史版本侧边栏 */}
      <Drawer
        open={showHistoryPanel}
        onClose={() => setShowHistoryPanel(false)}
        destroyOnHidden
        placement="right"
        size={400}
        rootClassName="storyboard-script-history-drawer"
        rootStyle={{ pointerEvents: 'none' }}
        styles={{ mask: { pointerEvents: showHistoryPanel ? 'auto' : 'none' } }}
        title={
          <div className="drawer-title">
            <HistoryOutlined />
            <span>历史版本</span>
          </div>
        }
      >
        {historyVersions.length === 0 ? (
          <div className="empty-history">
            <FileTextOutlined className="empty-icon" />
            <p>暂无历史记录</p>
          </div>
        ) : (
          <div className="history-list">
            {historyVersions.map((version, index) => (
              <div
                key={version.id}
                className={
                  selectedHistoryId === version.id ? 'history-item active' : 'history-item'
                }
                onClick={() => selectHistoryVersion(version)}
              >
                <div className="history-header">
                  <span className="history-title">版本 {historyVersions.length - index}</span>
                  <span className="history-time">{formatTime(version.createdAt)}</span>
                </div>
                <div className="history-preview">{getPreview(version.content)}</div>
                <div className="history-actions">
                  <Button
                    size="small"
                    type="link"
                    onClick={(e) => {
                      e.stopPropagation()
                      restoreVersion(version)
                    }}
                  >
                    恢复此版本
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    danger
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteVersion(version.id)
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      {/* 导入文档弹窗 */}
      <ImportScriptModal
        open={showImportModal}
        acceptAssetType="script"
        onOpenChange={setShowImportModal}
        onImport={handleImport}
      />
      {showReferencePicker && (
        <SelectAssetImageModal
          open
          type="reference"
          onOpenChange={setShowReferencePicker}
          onConfirm={async (items) => {
            const scope = referenceScope.current
            if (!scope?.projectId) return
            setImporting(true)
            try {
              const result = await importStoryboardReferenceImages(scope, items, () => referenceScope.current === scope)
              if (referenceScope.current !== scope) return
              setScriptReferences((current) => {
                const selected = new Map((current ?? []).map(ref => [String(ref.imageId ?? ref.sourceUrl), ref]))
                for (const image of result.images) {
                  selected.set(image.id, { index: 0, name: image.promptReferenceName, imageId: image.id, sourceUrl: image.url })
                }
                return [...selected.values()].map((reference, index) => ({ ...reference, index: index + 1 }))
              })
              if (result.failures.length) message.error(result.failures.join('；'))
            } catch (cause) {
              if (referenceScope.current === scope) message.error(cause instanceof Error ? cause.message : '参考图导入失败')
            } finally {
              if (referenceScope.current === scope) setImporting(false)
            }
          }}
        />
      )}
    </Modal>
  )
}

export default StoryboardScriptModal
