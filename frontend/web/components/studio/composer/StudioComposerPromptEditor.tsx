'use client'

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Placeholder from '@tiptap/extension-placeholder'
import Text from '@tiptap/extension-text'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import type { StudioComposerRef } from '@/types/studio'
import {
  parseStudioPromptToSpans,
  serializeStudioPromptSpans,
  studioPromptSpansToTiptapDoc,
  tiptapDocToStudioPromptSpans
} from '@/utils/studio/studioComposerPromptDoc'
import { detectStudioMention } from '@/utils/studio/studioMention'
import {
  StudioComposerMentionExtension,
  type StudioComposerMentionAttrs
} from './studioComposerMentionExtension'
import { canApplyStudioComposerPromptChange } from '@/utils/studio/studioPromptCharacterLimit'
import type { StudioCameraMark } from '@/utils/studio/studioCameraMark'
import { StudioCameraMarkExtension } from './studioCameraMarkExtension'

export type StudioComposerPromptEditorHandle = {
  focus: () => void
  getPrompt: () => string
  getMentionIds: () => string[]
  setFromPrompt: (prompt: string, refs: StudioComposerRef[]) => void
  scrollToEnd: () => void
  insertMention: (ref: StudioComposerRef) => void
  insertCameraMark: (mark: StudioCameraMark) => void
  replaceCameraMark: (id: string, mark: StudioCameraMark) => void
  discardPendingMention: () => string | null
  removeMentionById: (id: string) => void
}

type PendingMentionRange = {
  from: number
  to: number
}

export const StudioComposerPromptEditor = forwardRef<
  StudioComposerPromptEditorHandle,
  {
    placeholder?: string
    readOnly?: boolean
    initialPrompt: string
    initialRefs: StudioComposerRef[]
    onPromptChange?: (prompt: string, mentionIds: string[]) => void
    onBlurCommit?: (prompt: string) => void
    onMentionTrigger?: (query: string, caretRect: DOMRect | null) => void
    onMentionDismiss?: () => void
    onMentionChipClick?: (attrs: StudioComposerMentionAttrs, rect: DOMRect) => void
    onCameraMarkClick?: (mark: StudioCameraMark) => void
    onSubmit?: () => void
    onRejectedLength?: (length: number, limit: number) => void
    resolveMaxLength?: (prompt: string) => number
  }
>(function StudioComposerPromptEditor(
  {
    placeholder,
    readOnly = false,
    initialPrompt,
    initialRefs,
    onPromptChange,
    onBlurCommit,
    onMentionTrigger,
    onMentionDismiss,
    onMentionChipClick,
    onCameraMarkClick,
    onSubmit,
    resolveMaxLength, onRejectedLength
  },
  ref
) {
  const refsByIdRef = useRef(new Map(initialRefs.map((item) => [item.id, item])))
  const applyingRef = useRef(false)
  const mountedRef = useRef(false)
  const blurSequenceRef = useRef(0)
  const pendingMentionRangeRef = useRef<PendingMentionRange | null>(null)
  const suppressMentionDetectionRef = useRef(false)
  const onPromptChangeRef = useRef(onPromptChange)
  const onBlurCommitRef = useRef(onBlurCommit)
  const onMentionTriggerRef = useRef(onMentionTrigger)
  const onMentionDismissRef = useRef(onMentionDismiss)
  const onMentionChipClickRef = useRef(onMentionChipClick)
  const onCameraMarkClickRef = useRef(onCameraMarkClick)
  const onSubmitRef = useRef(onSubmit)
  const rejectedLengthRef = useRef(onRejectedLength)
  rejectedLengthRef.current = onRejectedLength
  const resolveMaxLengthRef = useRef(resolveMaxLength)
  const placeholderRef = useRef(placeholder ?? '')
  const [contextSelection, setContextSelection] = useState<{ from: number; to: number }>({ from: 0, to: 0 })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      blurSequenceRef.current += 1
    }
  }, [])

  useEffect(() => {
    onPromptChangeRef.current = onPromptChange
    onBlurCommitRef.current = onBlurCommit
    onMentionTriggerRef.current = onMentionTrigger
    onMentionDismissRef.current = onMentionDismiss
    onMentionChipClickRef.current = onMentionChipClick
    onCameraMarkClickRef.current = onCameraMarkClick
    onSubmitRef.current = onSubmit
    resolveMaxLengthRef.current = resolveMaxLength
  }, [onBlurCommit, onCameraMarkClick, onMentionChipClick, onMentionDismiss, onMentionTrigger, onPromptChange, onSubmit, resolveMaxLength])

  useEffect(() => {
    refsByIdRef.current = new Map(initialRefs.map((item) => [item.id, item]))
  }, [initialRefs])

  const initialContent = useMemo(
    () => studioPromptSpansToTiptapDoc(parseStudioPromptToSpans(initialPrompt, initialRefs)),
    // 仅挂载时用初始值；后续由 setFromPrompt / 编辑驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const promptLengthGuard = useMemo(() => Extension.create({
    name: 'studioPromptLengthGuard',
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged || !resolveMaxLengthRef.current) return true
          const previousPrompt = serializeStudioPromptSpans(
            tiptapDocToStudioPromptSpans(state.doc.toJSON(), refsByIdRef.current)
          )
          const nextPrompt = serializeStudioPromptSpans(
            tiptapDocToStudioPromptSpans(transaction.doc.toJSON(), refsByIdRef.current)
          )
          const accepted = canApplyStudioComposerPromptChange(
            previousPrompt,
            nextPrompt,
            resolveMaxLengthRef.current
          )
          if (!accepted) rejectedLengthRef.current?.(nextPrompt.length, resolveMaxLengthRef.current(nextPrompt))
          return accepted
        }
      })]
    }
  }), [])

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      promptLengthGuard,
      StudioComposerMentionExtension.configure({
        onMentionClick: (attrs, rect) => {
          onMentionChipClickRef.current?.(attrs, rect)
        }
      }),
      StudioCameraMarkExtension.configure({
        onCameraMarkClick: (mark) => {
          onCameraMarkClickRef.current?.(mark)
        }
      })
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: 'studio-composer-prompt-editor__tiptap tiptap',
        'aria-multiline': 'true'
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          onSubmitRef.current?.()
          return true
        }
        return false
      }
    },
    onUpdate: ({ editor: current }) => {
      if (applyingRef.current) return
      const spans = tiptapDocToStudioPromptSpans(current.getJSON(), refsByIdRef.current)
      const prompt = serializeStudioPromptSpans(spans)
      const mentionIds = spans
        .filter((span): span is Extract<typeof span, { type: 'mention' }> => span.type === 'mention')
        .map((span) => span.ref.id)
      onPromptChangeRef.current?.(prompt, mentionIds)
      if (!suppressMentionDetectionRef.current) detectMentionTrigger(current)
    },
    onBlur: ({ editor: current }) => {
      if (applyingRef.current) return
      const spans = tiptapDocToStudioPromptSpans(current.getJSON(), refsByIdRef.current)
      const prompt = serializeStudioPromptSpans(spans)
      const document = current.state.doc
      const sequence = ++blurSequenceRef.current
      const commit = onBlurCommitRef.current
      // Modal focus transfer can blur during React's commit. Auto-linking creates
      // React node views, so run the commit after that lifecycle has finished.
      queueMicrotask(() => {
        if (!mountedRef.current || current.isDestroyed || sequence !== blurSequenceRef.current
          || current.state.doc !== document) return
        commit?.(prompt)
      })
    },
    onSelectionUpdate: ({ editor: current }) => {
      if (!applyingRef.current && !suppressMentionDetectionRef.current) detectMentionTrigger(current)
    }
  })

  useEffect(() => {
    if (!editor) return
    let cancelled = false
    const document = editor.state.doc
    // External prompt updates share the same node-view lifecycle boundary.
    queueMicrotask(() => {
      if (cancelled || editor.isDestroyed || applyingRef.current || editor.state.doc !== document) return
      const current = serializeStudioPromptSpans(
        tiptapDocToStudioPromptSpans(editor.getJSON(), refsByIdRef.current)
      )
      if (current === initialPrompt) return
      applyingRef.current = true
      try {
        editor.commands.setContent(studioPromptSpansToTiptapDoc(
          parseStudioPromptToSpans(initialPrompt, [...refsByIdRef.current.values()])
        ))
      } finally {
        applyingRef.current = false
      }
    })
    return () => { cancelled = true }
  }, [editor, initialPrompt])

  function detectMentionTrigger(current: NonNullable<typeof editor>) {
    if (!onMentionTriggerRef.current) return
    const { selection } = current.state
    if (!selection.empty) {
      pendingMentionRangeRef.current = null
      onMentionDismissRef.current?.()
      return
    }
    const { $from, from } = selection
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\0')
    const mention = detectStudioMention(textBefore, textBefore.length)
    if (!mention) {
      pendingMentionRangeRef.current = null
      onMentionDismissRef.current?.()
      return
    }
    pendingMentionRangeRef.current = {
      from: $from.start() + mention.start,
      to: from
    }
    const coords = current.view.coordsAtPos(from)
    onMentionTriggerRef.current(mention.query, new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top))
  }

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    getPrompt: () => {
      if (!editor) return ''
      const spans = tiptapDocToStudioPromptSpans(editor.getJSON(), refsByIdRef.current)
      return serializeStudioPromptSpans(spans)
    },
    getMentionIds: () => {
      if (!editor) return []
      const spans = tiptapDocToStudioPromptSpans(editor.getJSON(), refsByIdRef.current)
      return spans
        .filter((span): span is Extract<typeof span, { type: 'mention' }> => span.type === 'mention')
        .map((span) => span.ref.id)
    },
    setFromPrompt: (prompt, refs) => {
      if (!editor) return
      refsByIdRef.current = new Map(refs.map((item) => [item.id, item]))
      pendingMentionRangeRef.current = null
      applyingRef.current = true
      try {
        editor.commands.setContent(studioPromptSpansToTiptapDoc(parseStudioPromptToSpans(prompt, refs)))
      } finally {
        applyingRef.current = false
      }
    },
    scrollToEnd: () => {
      const scrolling = editor?.view.dom.parentElement
      if (!scrolling) return
      scrolling.scrollTop = scrolling.scrollHeight
    },
    insertMention: (mentionRef) => {
      if (!editor) return
      refsByIdRef.current.set(mentionRef.id, mentionRef)
      const pendingRange = pendingMentionRangeRef.current
      pendingMentionRangeRef.current = null
      applyingRef.current = true
      try {
        if (pendingRange) editor.commands.deleteRange(pendingRange)
        editor.commands.insertStudioMention({
          id: mentionRef.id,
          label: mentionRef.title,
          previewUrl: mentionRef.previewUrl ?? null,
          mediaKind: mentionRef.mediaKind,
          sourceKey: mentionRef.sourceKey ?? null
        })
      } finally {
        applyingRef.current = false
      }
    },
    discardPendingMention: () => {
      if (!editor) return null
      const pendingRange = pendingMentionRangeRef.current
      pendingMentionRangeRef.current = null
      if (!pendingRange) return null
      suppressMentionDetectionRef.current = true
      try {
        editor.commands.deleteRange(pendingRange)
      } finally {
        suppressMentionDetectionRef.current = false
      }
      const spans = tiptapDocToStudioPromptSpans(editor.getJSON(), refsByIdRef.current)
      return serializeStudioPromptSpans(spans)
    },
    insertCameraMark: (mark) => {
      if (!editor) return
      applyingRef.current = true
      try {
        editor.chain().focus().insertStudioCameraMark(mark).run()
      } finally {
        applyingRef.current = false
      }
    },
    replaceCameraMark: (id, mark) => {
      if (!editor) return
      applyingRef.current = true
      try {
        editor.commands.replaceStudioCameraMark(id, mark)
      } finally {
        applyingRef.current = false
      }
    },
    removeMentionById: (id) => {
      if (!editor) return
      const { doc } = editor.state
      let found: { from: number; to: number } | null = null
      doc.descendants((node, pos) => {
        if (found) return false
        if (node.type.name === 'studioMention' && node.attrs.id === id) {
          found = { from: pos, to: pos + node.nodeSize }
          return false
        }
        return true
      })
      if (found) {
        editor.chain().focus().deleteRange(found).run()
        refsByIdRef.current.delete(id)
      }
    }
  }), [editor])

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  useEffect(() => {
    placeholderRef.current = placeholder ?? ''
    // Placeholder decorations only recompute on a transaction.
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  }, [editor, placeholder])

  if (!editor) return <div className="studio-composer-prompt-editor is-loading" />

  const copySelection = async (range: { from: number; to: number }) => {
    if (range.from === range.to) return false
    const text = editor.state.doc.textBetween(range.from, range.to, '\n', '\ufffc')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      editor.chain().focus().setTextSelection(range).run()
      try {
        return document.execCommand('copy')
      } catch {
        return false
      }
    }
  }

  const handleContextMenuAction: NonNullable<MenuProps['onClick']> = async ({ key }) => {
    onMentionDismissRef.current?.()
    if (key === 'select-all') {
      editor.chain().focus().selectAll().run()
      return
    }
    if (key === 'copy' || key === 'cut') {
      const copied = await copySelection(contextSelection)
      if (!copied) {
        message.warning('未能写入剪贴板，请使用键盘快捷键')
        return
      }
      if (key === 'cut') {
        editor.chain().focus().setTextSelection(contextSelection).deleteSelection().run()
      }
      return
    }
    if (key === 'paste') {
      try {
        const text = await navigator.clipboard.readText()
        const content = text.split('\n').flatMap((line, index) => [
          ...(index > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : [])
        ])
        editor.chain().focus().setTextSelection(contextSelection).insertContent(content).run()
      } catch {
        message.warning('浏览器未授权读取剪贴板，请使用 Ctrl+V')
      }
    }
  }

  const hasSelection = contextSelection.from !== contextSelection.to
  const contextMenu: MenuProps = {
    items: [
      { key: 'copy', label: '复制', extra: 'Ctrl+C', disabled: !hasSelection },
      { key: 'cut', label: '剪切', extra: 'Ctrl+X', disabled: readOnly || !hasSelection },
      { key: 'paste', label: '粘贴', extra: 'Ctrl+V', disabled: readOnly },
      { type: 'divider' },
      { key: 'select-all', label: '全选', extra: 'Ctrl+A' }
    ],
    onClick: (info) => { void handleContextMenuAction(info) }
  }

  return (
    <Dropdown
      trigger={['contextMenu']}
      placement="bottomLeft"
      menu={contextMenu}
      classNames={{ root: 'studio-canvas-menu-overlay studio-canvas-menu-overlay--canvas studio-composer-context-menu' }}
    >
      <div
        className={`studio-composer-prompt-editor${readOnly ? ' is-readonly' : ''}`}
        onContextMenuCapture={() => {
          const { from, to } = editor.state.selection
          setContextSelection({ from, to })
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <EditorContent className="studio-composer-prompt-editor__viewport" editor={editor} />
      </div>
    </Dropdown>
  )
})
