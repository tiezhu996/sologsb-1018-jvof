// 模拟服务端：用独立的 IndexedDB 库扮演"学校电脑能访问的云端聚合服务"。
// 合并规则全部来自 server-core.ts（纯函数，可被 Node 测试直接验证）；
// 本文件只负责持久化、模拟网络（断网/抖动/延迟）和 Blob 分片读写。
// 真实接入时只需用同样签名的 HTTP 函数替换这四个导出函数。

import {
  applyBundle,
  audioComplete,
  createServerState,
  recordChunk,
  type ServerAudioRecord,
  type ServerCoreState
} from './server-core'
import type { BundlePayload, SyncSnapshot } from './types'

const SERVER_DB = 'sologsb-1018-mock-server'
const SERVER_VERSION = 1
const STATE_KEY = 'state'

// 网络环境控制（仅模拟用）。
let offline = false
let failRate = 0
let minLatencyMs = 120

export const mockNetwork = {
  setOffline(value: boolean) {
    offline = value
  },
  isOffline() {
    return offline
  },
  setFailRate(rate: number) {
    failRate = Math.min(1, Math.max(0, rate))
  },
  setLatency(ms: number) {
    minLatencyMs = Math.max(0, ms)
  }
}

export class NetworkError extends Error {}

async function maybeFail() {
  await new Promise((resolve) => setTimeout(resolve, minLatencyMs + Math.random() * 180))
  if (offline) throw new NetworkError('当前处于离线状态，练习包已保留在本机，联网后自动续传。')
  if (Math.random() < failRate) throw new NetworkError('模拟网络抖动：请求失败，已保存的上传进度不会丢失。')
}

function openServerDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SERVER_DB, SERVER_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readState(): Promise<ServerCoreState> {
  if (memoryState) return memoryState
  const db = await openServerDb()
  const state = await new Promise<ServerCoreState | undefined>((resolve, reject) => {
    const request = db.transaction('state', 'readonly').objectStore('state').get(STATE_KEY)
    request.onsuccess = () => resolve(request.result as ServerCoreState | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return state ?? createServerState()
}

/**
 * 测试用：把云端状态换成内存对象，绕过 IndexedDB（Node 环境）。
 * 传入 null 可恢复到 IndexedDB 持久化。
 */
let memoryState: ServerCoreState | null = null
export function __useMemoryServer(state: ServerCoreState | null): void {
  memoryState = state
}

async function writeState(state: ServerCoreState): Promise<void> {
  // 内存测试模式下 readState 返回的就是可变引用，无需持久化。
  if (memoryState) return
  const db = await openServerDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('state', 'readwrite')
    transaction.objectStore('state').put(state, STATE_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

export interface ChunkAck {
  hash: string
  receivedChunks: number
  totalChunks: number
  complete: boolean
}

/** 提交练习包元数据。录音内容由 uploadChunk 单独分片上传，重复提交天然幂等。 */
export async function pushBundle(payload: BundlePayload, projectId: string): Promise<{ accepted: boolean; alreadyHasAudio: boolean }> {
  await maybeFail()
  const state = await readState()
  const result = applyBundle(state, payload, projectId)
  await writeState(state)
  return { accepted: true, alreadyHasAudio: result.alreadyHasAudio }
}

/** 幂等上传单个录音分片：同一 hash 重复传只占一份存储，已确认的分片不要求重传。 */
export async function uploadChunk(hash: string, index: number, totalChunks: number, chunkSize: number, mime: string, chunk: Blob): Promise<ChunkAck> {
  await maybeFail()
  const state = await readState()
  const result = recordChunk(
    state,
    hash,
    index,
    totalChunks,
    chunkSize,
    mime,
    chunk,
    (value) => (value instanceof Blob ? value.size : (value as ServerAudioRecord['chunks'][number] & { size?: number })?.size ?? 0)
  )
  await writeState(state)
  return { hash, receivedChunks: result.receivedChunks, totalChunks, complete: result.complete }
}

/** 查询服务端已收到哪些分片，供重开页面后定位断点。 */
export async function getChunkStatus(hash: string): Promise<number> {
  await maybeFail()
  const state = await readState()
  return state.audio[hash]?.received ?? 0
}

export async function fetchSnapshot(sinceRevision = 0): Promise<SyncSnapshot> {
  await maybeFail()
  const state = await readState()
  void sinceRevision
  const projects = state.projects.map((project) => ({
    ...project,
    attempts: project.attempts.map((attempt) => {
      const { audio, ...rest } = attempt
      return { ...rest, audio: state.audio[audio?.hash ?? ''] ? audio : undefined }
    })
  }))
  const audioHashes = Object.values(state.audio)
    .filter(
      (audio) =>
        audio.received > 0 &&
        state.projects.some((project) =>
          project.attempts.some(
            (attempt) => attempt.audio?.hash === audio.hash && audioComplete(state, { hash: audio.hash, mime: audio.mime, size: audio.size, chunkSize: audio.chunkSize, totalChunks: audio.chunks.length })
          )
        )
    )
    .map((audio) => audio.hash)
  return { serverNow: new Date().toISOString(), projects, audioHashes }
}

export async function downloadAudio(hash: string): Promise<Blob> {
  await maybeFail()
  const state = await readState()
  const audio = state.audio[hash]
  if (!audio || !audio.received) throw new NetworkError(`服务端没有这段录音：${hash.slice(0, 8)}`)
  const blobs = audio.chunks.filter((chunk): chunk is Blob => chunk instanceof Blob)
  return new Blob(blobs, { type: audio.mime || 'audio/webm' })
}

/** 测试/演示用：清空模拟云端。 */
export async function resetMockServer(): Promise<void> {
  await writeState(createServerState())
}
