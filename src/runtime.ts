// 同步引擎依赖的运行时适配层。
// 生产环境直接转发到 IndexedDB / 模拟服务端实现；测试可注入内存替身。
// 这样 sync.ts 只依赖本模块的稳定接口，不直接耦合存储与网络。

import {
  deleteBundle as idbDeleteBundle,
  getAudio as idbGetAudio,
  hashBlob as idbHashBlob,
  listBundles as idbListBundles,
  putAudio as idbPutAudio,
  putBundle as idbPutBundle
} from './storage'
import {
  downloadAudio as netDownloadAudio,
  fetchSnapshot as netFetchSnapshot,
  getChunkStatus as netGetChunkStatus,
  pushBundle as netPushBundle,
  uploadChunk as netUploadChunk
} from './mock-server'
import type { BundlePayload, OutboxBundle, SyncSnapshot } from './types'

export interface SyncRuntime {
  hashBlob(blob: Blob): Promise<string>
  putAudio(hash: string, blob: Blob): Promise<void>
  getAudio(hash: string): Promise<Blob | undefined>
  listBundles(): Promise<OutboxBundle[]>
  putBundle(bundle: OutboxBundle): Promise<void>
  deleteBundle(id: string): Promise<void>
  pushBundle(payload: BundlePayload, projectId: string): Promise<{ accepted: boolean; alreadyHasAudio: boolean }>
  uploadChunk(hash: string, index: number, totalChunks: number, chunkSize: number, mime: string, chunk: Blob): Promise<{
    receivedChunks: number
    complete: boolean
  }>
  getChunkStatus(hash: string): Promise<number>
  fetchSnapshot(): Promise<SyncSnapshot>
  downloadAudio(hash: string): Promise<Blob>
  isOffline(): boolean
}

const production: SyncRuntime = {
  hashBlob: idbHashBlob,
  putAudio: idbPutAudio,
  getAudio: idbGetAudio,
  listBundles: idbListBundles,
  putBundle: idbPutBundle,
  deleteBundle: idbDeleteBundle,
  pushBundle: netPushBundle,
  uploadChunk: async (hash, index, total, chunkSize, mime, chunk) => {
    const ack = await netUploadChunk(hash, index, total, chunkSize, mime, chunk)
    return { receivedChunks: ack.receivedChunks, complete: ack.complete }
  },
  getChunkStatus: netGetChunkStatus,
  fetchSnapshot: () => netFetchSnapshot(),
  downloadAudio: netDownloadAudio,
  isOffline: () => !navigator.onLine
}

let active: SyncRuntime = production

export function getRuntime(): SyncRuntime {
  return active
}

/** 注入运行时（测试用）。传 null 恢复生产实现。 */
export function setRuntime(runtime: Partial<SyncRuntime> | null): SyncRuntime {
  active = runtime ? { ...production, ...runtime } : production
  return active
}
