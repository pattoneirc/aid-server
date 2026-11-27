import type { ApiEnvelope } from '~/types/business-api'
import { request } from '~/utils/api'
import { unwrap } from '~/utils/business/shared'

export interface PersonalVoiceAsset {
  id: string | number
  assetTitle: string
  audioUrl: string
  avatarUrl?: string
  durationMs: number
}

export async function listPersonalVoices(pageNum: number, pageSize: number) {
  const response = await request.post<ApiEnvelope<PersonalVoiceAsset[]> & { total: number }>(
    '/api/user/audio-asset/list', { pageNum, pageSize, personalVoiceOnly: true }
  )
  return { items: unwrap(response), total: Number(response.total) }
}

export async function savePersonalVoice(input: {
  id?: string
  name: string
  file?: File
  avatar?: File
  resetAvatar: boolean
}) {
  const body = new FormData()
  body.append('name', input.name)
  if (input.id) body.append('id', input.id)
  if (input.file) body.append('file', input.file)
  if (input.avatar) body.append('avatar', input.avatar)
  if (input.resetAvatar) body.append('resetAvatar', 'true')
  const response = await request.post<ApiEnvelope<PersonalVoiceAsset>>(
    '/api/user/audio-asset/personal/' + (input.id ? 'update' : 'upload'), body,
    { timeout: 180_000, headers: { 'Content-Type': false } as unknown as Record<string, string> }
  )
  return unwrap(response)
}
