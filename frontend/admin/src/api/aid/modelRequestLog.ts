import { request } from '@/utils/request';
import type { ApiResponse } from '@/types/common';

export interface ModelLogRecord {
  id: string;
  modelCode: string;
  providerCode?: string;
  modelType: string;
  operation: string;
  taskId?: string;
  businessId?: string;
  businessType?: string;
  startedAt: string;
  elapsedMs: number;
  status: string;
}

export interface ModelLogQuery {
  type?: string;
  provider?: string;
  model?: string;
  before?: string;
  size?: number;
}

export interface ModelLogSettings {
  enabledTypes: string[];
  retentionDays: number;
  maxMiB: number;
  customStorage: boolean;
  storageDirectory?: string;
}

export interface ModelLogStatus {
  settings: ModelLogSettings;
  effectiveDirectory: string;
  dropped: number;
  failed: number;
}

const url = '/aid/model-request-log';

export function listModelLogs(params: ModelLogQuery): Promise<ApiResponse<{ records: ModelLogRecord[]; nextCursor?: string }>> {
  return request({ url, params });
}

export function getModelLog(id: string): Promise<ApiResponse<string>> {
  return request({ url: `${url}/${encodeURIComponent(id)}` });
}

export function getModelLogSettings(): Promise<ApiResponse<ModelLogStatus>> {
  return request({ url: `${url}/settings` });
}

export function saveModelLogSettings(data: ModelLogSettings): Promise<ApiResponse<ModelLogStatus>> {
  return request({ url: `${url}/settings`, method: 'put', data });
}
