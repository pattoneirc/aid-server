'use client'

import { useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import { useCreationStore } from '~/stores/creation'
import { normalizeCreationMode } from '~/utils/creationModeUiRules'
import { resolveStoryScriptSaveContext } from '~/utils/storyScriptSaveContext'
import {
  mergePromptAssets, parseApiImagePlaceholders, storyboardPromptPlainToHtml, formatAssetApiPlaceholder,
  type PromptAssetItem
} from '~/utils/storyboardPromptAssetRef'
import {
  importStoryboardReferenceImages, storyboardReferenceImageKey, type StoryboardReferencePick
} from './storyboardReferenceImages'
import type { EditStoryboardImageModalCtx } from './types'

export function useStoryboardReferenceImport(ctx: EditStoryboardImageModalCtx, dialogOpen: boolean) {
  const enabled = useCreationStore(state => {
    const mode = normalizeCreationMode(state.formData.globalSetting?.creationMode)
    return mode === 'i2v' || mode === 'auto_grid'
  })
  const [importState, setImportState] = useState<{ storyboardId: number; status: 'picking' | 'importing' } | null>(null)
  const requestRef = useRef<{ storyboardId: number; importing: boolean } | null>(null)
  const storyboardId = ctx.currentStoryboardId()
  const allowed = dialogOpen && enabled && ctx.leftActiveTab.value === 'generate'

  useEffect(() => {
    if (!allowed) return
    return () => {
      requestRef.current = null
      setImportState(null)
    }
  }, [allowed, storyboardId])

  const openPicker = () => {
    if (!allowed || !storyboardId || requestRef.current?.importing) return
    requestRef.current = { storyboardId, importing: false }
    setImportState({ storyboardId, status: 'picking' })
  }

  const onOpenChange = (open: boolean) => {
    if (open || requestRef.current?.importing) return
    requestRef.current = null
    setImportState(null)
  }

  const onConfirm = async (items: StoryboardReferencePick[]) => {
    const pending = requestRef.current
    if (!pending || pending.importing || !items.length) return
    pending.importing = true
    setImportState({ storyboardId: pending.storyboardId, status: 'importing' })
    const current = () => requestRef.current === pending && ctx.props().open &&
      ctx.currentStoryboardId() === pending.storyboardId && ctx.leftActiveTab.get() === 'generate'

    try {
      const scope = await resolveStoryScriptSaveContext(ctx.store(), ctx.route())
      if (!current()) return
      if (!scope) throw new Error('缺少项目信息，无法登记参考图')
      const before = () => {
        const references = [...ctx.sceneImages.get(), ...ctx.characterImages.get(), ...ctx.propImages.get(), ...ctx.otherImages.get()]
        return new Set([
          ...references.map(item => storyboardReferenceImageKey(item.url || item.thumbnail)),
          ...ctx.storyboardPromptAssets().map(item => storyboardReferenceImageKey(item.url))
        ])
      }
      const previouslyAdded = before()
      const picks = items.filter(item => !previouslyAdded.has(storyboardReferenceImageKey(item.url || item.thumbnail)))
      if (!picks.length) {
        message.info('所选图片已在参考列表中')
        return
      }
      const result = await importStoryboardReferenceImages(scope, picks, current)
      if (!current()) return
      const currentUrls = before()
      const newImages = result.images.filter(item => !currentUrls.has(storyboardReferenceImageKey(item.url)))
      if (newImages.length) {
        const existingAssets = ctx.storyboardPromptAssets()
        const plain = ctx.storyboardPromptPlainText()
        const maxIndex = Math.max(
          0, ...existingAssets.map(item => item.imageIndex), ...parseApiImagePlaceholders(plain).map(item => item.imageIndex)
        )
        const assets: PromptAssetItem[] = newImages.map((item, index) => ({
          assetId: item.id, assetType: 'other', name: item.promptReferenceName, label: '@' + item.title,
          imageIndex: maxIndex + index + 1, url: item.url
        }))
        const allAssets = mergePromptAssets(existingAssets, assets)
        ctx.otherImages.set([...ctx.otherImages.get(), ...newImages])
        ctx.resolvedPromptAssets.set(mergePromptAssets(ctx.resolvedPromptAssets.get(), assets))
        const panel = ctx.storyboardGeneratePanelRef.current
        const inInspiration = Boolean(panel?.isParamSettingsOpen())
        if (inInspiration) panel?.applyParamDraftAssets('other', newImages, false)
        if (!panel?.insertPromptAssetRefsAtCaret(assets, !inInspiration)) {
          const inserts = assets.map(item => formatAssetApiPlaceholder(item.imageIndex, item.name)).join(' ')
          ctx.handleStoryboardPromptEditorChange(storyboardPromptPlainToHtml(
            [plain.trimEnd(), inserts].filter(Boolean).join(' '), allAssets, ctx.storyboardPromptParamGroups(),
            { enableImageLabeledParams: true }
          ))
        }
        message.success(`已导入 ${newImages.length} 张参考图`)
      }
      if (result.failures.length) message.error(result.failures.join('；'))
      else if (!newImages.length) message.warning('没有可导入的新图片')
    } catch (cause: unknown) {
      const error = cause as { msg?: string; message?: string }
      if (current()) message.error(error?.msg || error?.message || '参考图导入失败')
    } finally {
      if (requestRef.current === pending) {
        requestRef.current = null
        setImportState(null)
      }
    }
  }

  return {
    enabled,
    pickerOpen: allowed && importState?.storyboardId === storyboardId && importState?.status === 'picking',
    busy: allowed && importState?.storyboardId === storyboardId && importState?.status === 'importing',
    openPicker, onOpenChange, onConfirm
  }
}
