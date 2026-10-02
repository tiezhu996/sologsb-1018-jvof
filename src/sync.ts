import { deleteAudioChunk, getAudioChunk, putAudioChunk } from './storage'
import type {
  Attempt,
  AttemptPayload,
  GroupVersion,
  OrderVersion,
  PartStatus,
  PracticePackage,
  PracticeProject,
  SegmentFeedback,
  SyncBatch,
  SyncState
} from './types'

const REMOTE_DB = 'sologsb-1018-remote-relay'
const REMOTE_STORE = 'records'
const CHUNK_SIZE = 256 * 1024

// 浏览器内 relay 用于无服务端仓库演示：同一浏览器的两个“设备/资料”共用 IndexedDB。
// 接入学校服务端时，保持这些方法的签名并把实现替换为 /api/sync/* 即可。

interface RemoteRecord {
  kind: 'groupVersion' | 'orderVersion' | 'package' | 'feedback' | 'audioMeta' | 'audioChunk'
  id: string
  updatedAt: string
  value: unknown
}

export interface SyncResult {
  project: PracticeProject
  sync: SyncState
}

type Checkpoint = (project: PracticeProject, sync: SyncState) => Promise<void>

export function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export async function hashBlob(blob?: Blob): Promise<string | undefined> {
  if (!blob) return undefined
  const buffer = await blob.arrayBuffer()
  if (!crypto.subtle) return undefined
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function openRemote(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REMOTE_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(REMOTE_STORE)) {
        const store = db.createObjectStore(REMOTE_STORE, { keyPath: 'id' })
        store.createIndex('kind', 'kind', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function remoteGet<T>(id: string): Promise<T | undefined> {
  const db = await openRemote()
  const record = await new Promise<RemoteRecord | undefined>((resolve, reject) => {
    const transaction = db.transaction(REMOTE_STORE, 'readonly')
    const request = transaction.objectStore(REMOTE_STORE).get(id)
    request.onsuccess = () => resolve(request.result as RemoteRecord | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return record?.value as T | undefined
}

async function remotePut(kind: RemoteRecord['kind'], id: string, value: unknown, updatedAt: string) {
  const db = await openRemote()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(REMOTE_STORE, 'readwrite')
    transaction.objectStore(REMOTE_STORE).put({ kind, id, value, updatedAt } satisfies RemoteRecord)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function remoteList(kind: RemoteRecord['kind']): Promise<RemoteRecord[]> {
  const db = await openRemote()
  const records = await new Promise<RemoteRecord[]>((resolve, reject) => {
    const transaction = db.transaction(REMOTE_STORE, 'readonly')
    const request = transaction.objectStore(REMOTE_STORE).index('kind').getAll(IDBKeyRange.only(kind))
    request.onsuccess = () => resolve(request.result as RemoteRecord[])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
}

type CursorMap = Record<string, string>

function decodeCursor(cursor: string): CursorMap {
  if (!cursor || cursor === '0') return {}
  try { return JSON.parse(cursor) as CursorMap } catch { return {} }
}

async function remoteListAfter(kind: RemoteRecord['kind'], cursor: string): Promise<{ records: RemoteRecord[]; next: string }> {
  const records = await remoteList(kind)
  const selected = records.filter((record) => `${record.updatedAt} ${record.id}` > cursor)
  const next = selected.at(-1) ? `${selected.at(-1)!.updatedAt} ${selected.at(-1)!.id}` : cursor
  return { records: selected, next }
}

const adapter = {
  async pull(cursor: string): Promise<SyncBatch> {
    const kinds = ['groupVersion', 'orderVersion', 'package', 'feedback'] as const
    const cursors = decodeCursor(cursor)
    const result: SyncBatch = { groupVersions: [], orderVersions: [], packages: [], feedback: [], cursor, serverTime: new Date().toISOString() }
    for (const kind of kinds) {
      const { records, next } = await remoteListAfter(kind, cursors[kind] ?? '0')
      cursors[kind] = next
      for (const record of records) {
        if (kind === 'groupVersion') result.groupVersions.push(record.value as GroupVersion)
        if (kind === 'orderVersion') result.orderVersions.push(record.value as OrderVersion)
        if (kind === 'package') result.packages.push(record.value as PracticePackage)
        if (kind === 'feedback') result.feedback.push(record.value as SegmentFeedback)
      }
    }
    result.cursor = JSON.stringify(cursors)
    return result
  },

  async putGroupVersion(version: GroupVersion) {
    const existing = await remoteGet<{ savedAt: string }>(`groupVersion:${version.id}`)
    if (!existing || existing.savedAt < version.savedAt) await remotePut('groupVersion', `groupVersion:${version.id}`, version, version.savedAt)
  },

  async putOrderVersion(version: OrderVersion) {
    const existing = await remoteGet<{ savedAt: string }>(`orderVersion:${version.id}`)
    if (!existing || existing.savedAt < version.savedAt) await remotePut('orderVersion', `orderVersion:${version.id}`, version, version.savedAt)
  },

  async putPackage(pkg: PracticePackage) {
    const updatedAt = pkg.checkpointAt || pkg.enqueuedAt
    const existing = await remoteGet<PracticePackage>(`package:${pkg.id}`)
    if (!existing || (existing.checkpointAt || existing.enqueuedAt) < updatedAt || existing.revision < pkg.revision) {
      await remotePut('package', `package:${pkg.id}`, pkg, updatedAt)
    }
    return remoteGet<PracticePackage>(`package:${pkg.id}`) as Promise<PracticePackage>
  },

  async putFeedback(feedback: SegmentFeedback): Promise<SegmentFeedback> {
    const id = `feedback:${feedback.id}`
    const existing = await remoteGet<SegmentFeedback>(id)
    const winner = !existing || existing.updatedAt < feedback.updatedAt ? feedback : existing
    await remotePut('feedback', id, winner, winner.updatedAt)
    return winner
  },

  async audioMeta(hash: string) {
    return remoteGet<{ size: number; chunks: number; chunkSize: number; mime: string }>(`audioMeta:${hash}`)
  },

  async hasAudioChunk(hash: string, index: number) {
    return Boolean(await remoteGet<Blob>(`audioChunk:${hash}:${index}`))
  },

  async putAudioChunk(hash: string, index: number, chunk: Blob, meta: { size: number; chunks: number; chunkSize: number; mime: string }) {
    await remotePut('audioChunk', `audioChunk:${hash}:${index}`, chunk, new Date().toISOString())
    await remotePut('audioMeta', `audioMeta:${hash}`, meta, new Date().toISOString())
  },

  async getAudioChunk(hash: string, index: number) {
    return remoteGet<Blob>(`audioChunk:${hash}:${index}`)
  }
}

export function currentOrderSnapshot(project: PracticeProject) {
  return project.groups.map((group) => ({ groupId: group.id, groupVersionId: group.versionId ?? '', order: group.order }))
}

export function commitOrderVersion(project: PracticeProject, draft: PracticeProject, reason?: string) {
  const before = project.currentOrderVersionId
  const now = new Date().toISOString()
  const snapshot = currentOrderSnapshot(draft)
  const same = project.orderVersions.find((version) =>
    version.id !== before &&
    version.entries.length === snapshot.length &&
    version.entries.every((entry) => snapshot.some((item) => item.groupId === entry.groupId && item.groupVersionId === entry.groupVersionId && item.order === entry.order))
  )
  if (same) {
    draft.currentOrderVersionId = same.id
    return same
  }
  const version: OrderVersion = { id: uid('order-version'), parentVersionId: before, savedAt: now, entries: snapshot }
  draft.orderVersions.push(version)
  draft.currentOrderVersionId = version.id
  if (reason) draft.updatedAt = now
  return version
}

export function commitGroupVersion(project: PracticeProject, groupId: string) {
  const current = project.groups.find((group) => group.id === groupId)
  if (!current) return
  const version: GroupVersion = {
    id: uid('group-version'),
    groupId,
    parentVersionId: current.versionId ?? null,
    order: current.order,
    savedAt: new Date().toISOString(),
    snapshot: structuredClone(current)
  }
  const draft = project
  const group = draft.groups.find((item) => item.id === groupId)
  if (group) group.versionId = version.id
  draft.groupVersions.push(version)
  return version
}

function toPayload(attempt: Attempt): AttemptPayload {
  const { audioBlob: _audioBlob, originDeviceId: _origin, feedback: _feedback, ...payload } = attempt
  return payload
}

function statusFor(uploaded: number[], total: number): PartStatus {
  if (uploaded.length >= total) return 'done'
  if (uploaded.length > 0) return 'uploading'
  return 'pending'
}

export async function enqueuePackage(project: PracticeProject, sync: SyncState, attemptId: string): Promise<SyncResult> {
  const attempt = project.attempts.find((item) => item.id === attemptId)
  if (!attempt) return { project, sync }
  const hash = attempt.audioHash ?? await hashBlob(attempt.audioBlob)
  if (attempt.audioBlob && hash) attempt.audioHash = hash
  const size = attempt.audioBlob?.size ?? 0
  const chunks = attempt.audioBlob ? Math.max(1, Math.ceil(size / CHUNK_SIZE)) : 0
  const existing = sync.packages.find((pkg) => pkg.attemptId === attemptId)
  const payload = toPayload({ ...attempt, audioHash: hash })
  const orderVersion = project.orderVersions.find((version) => version.id === attempt.orderVersionId) ?? project.orderVersions.at(-1)
  const next: PracticePackage = existing
    ? {
        ...existing,
        revision: existing.revision + 1,
        orderVersionId: attempt.orderVersionId,
        attemptPayload: payload,
        orderSnapshot: orderVersion?.entries ?? currentOrderSnapshot(project),
        audioHash: hash,
        audioSize: size,
        audioChunks: chunks,
        chunkSize: CHUNK_SIZE,
        status: 'pending',
        order: 'pending',
        issues: 'pending',
        manifest: 'pending',
        audio: chunks ? 'pending' : 'done',
        uploadedChunks: existing.audioHash === hash ? existing.uploadedChunks : [],
        lastError: undefined,
        checkpointAt: new Date().toISOString()
      }
    : {
        id: uid('package'),
        attemptId,
        originDeviceId: project.deviceId,
        revision: 1,
        orderVersionId: attempt.orderVersionId,
        createdAt: new Date().toISOString(),
        enqueuedAt: new Date().toISOString(),
        attemptPayload: payload,
        orderSnapshot: orderVersion?.entries ?? currentOrderSnapshot(project),
        audioHash: hash,
        audioSize: size,
        audioChunks: chunks,
        chunkSize: CHUNK_SIZE,
        status: 'pending',
        audio: chunks ? 'pending' : 'done',
        order: 'pending',
        issues: 'pending',
        manifest: 'pending',
        uploadedChunks: [],
        downloadedChunks: [],
        direction: 'outbox'
      }
  return { project, sync: { ...sync, packages: [...sync.packages.filter((pkg) => pkg.id !== next.id), next] } }
}

function replacePackage(sync: SyncState, next: PracticePackage): SyncState {
  return { ...sync, packages: sync.packages.map((pkg) => pkg.id === next.id ? next : pkg) }
}

function updateFeedbackInProject(project: PracticeProject, feedback: SegmentFeedback) {
  const attempt = project.attempts.find((item) => item.id === feedback.attemptId)
  if (!attempt) return
  const index = attempt.feedback.findIndex((item) => item.id === feedback.id)
  if (index === -1) attempt.feedback.push(structuredClone(feedback))
  else if ((attempt.feedback[index].updatedAt ?? '') <= feedback.updatedAt) attempt.feedback[index] = structuredClone(feedback)
}

function mergePackageIntoProject(project: PracticeProject, pkg: PracticePackage): PracticeProject {
  const incomingPayload = pkg.attemptPayload
  const existing = project.attempts.find((attempt) => attempt.id === incomingPayload.id)
  const preserveAudio = existing?.audioBlob
  const preserveFeedback = existing?.feedback ? structuredClone(existing.feedback) : []
  const mergedFeedback = Array.from(new Map(preserveFeedback.map((feedback) => [feedback.id, feedback])).values())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const attempt: Attempt = {
    ...incomingPayload,
    originDeviceId: pkg.originDeviceId,
    audioBlob: preserveAudio,
    feedback: mergedFeedback
  }
  if (!existing) project.attempts.push(attempt)
  else if (existing.clientUpdatedAt <= incomingPayload.clientUpdatedAt || !existing.audioBlob) Object.assign(existing, attempt)
  project.attempts.sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt))
  return project
}

function feedbackHasAnchor(project: PracticeProject, feedback: SegmentFeedback) {
  return Boolean(
    project.attempts.some((attempt) => attempt.id === feedback.attemptId) &&
    (project.groups.some((group) => group.id === feedback.groupId) ||
      project.groupVersions.some((version) => version.groupId === feedback.groupId))
  )
}

function placeFeedback(project: PracticeProject, sync: SyncState, feedback: SegmentFeedback): SyncState {
  if (!feedbackHasAnchor(project, feedback) && !sync.pendingFeedback.some((item) => item.id === feedback.id)) {
    return { ...sync, pendingFeedback: [...sync.pendingFeedback, structuredClone(feedback)] }
  }
  updateFeedbackInProject(project, feedback)
  return { ...sync, pendingFeedback: sync.pendingFeedback.filter((item) => item.id !== feedback.id) }
}

function applyOrderVersion(project: PracticeProject, version: OrderVersion, incomingOnly: GroupVersion[]) {
  const currentVersion = project.orderVersions.find((item) => item.id === project.currentOrderVersionId)
  if (currentVersion && currentVersion.savedAt > version.savedAt && version.id !== project.currentOrderVersionId) return
  const versionsById = new Map([...project.groupVersions, ...incomingOnly].map((item) => [item.id, item]))
  const activeIds = new Set(version.entries.map((entry) => entry.groupId))
  for (const entry of version.entries) {
    let group = project.groups.find((item) => item.id === entry.groupId)
    const snapshot = versionsById.get(entry.groupVersionId)?.snapshot
    if (!group && snapshot) {
      project.groups.push(structuredClone(snapshot))
      group = project.groups.at(-1)
    }
    if (group) {
      group.order = entry.order
      group.versionId = entry.groupVersionId
      if (snapshot) Object.assign(group, structuredClone(snapshot), { order: entry.order })
    }
  }
  const localUnsynced = project.groups.filter((group) => !activeIds.has(group.id) && !project.groupVersions.some((version) => version.groupId === group.id))
  project.groups = project.groups.filter((group) => activeIds.has(group.id) || localUnsynced.includes(group))
  project.groups.sort((a, b) => a.order - b.order)
  project.currentOrderVersionId = version.id
}

function mergeBatch(project: PracticeProject, sync: SyncState, batch: SyncBatch): SyncResult {
  const draft = structuredClone(project)
  let nextSync = structuredClone(sync)
  const pendingById = new Map(nextSync.pendingFeedback.map((feedback) => [feedback.id, feedback]))
  for (const feedback of batch.feedback) pendingById.set(feedback.id, structuredClone(feedback))
  nextSync.pendingFeedback = Array.from(pendingById.values())
  const incomingGroupVersions = batch.groupVersions.filter((version) => !draft.groupVersions.some((item) => item.id === version.id))
  draft.groupVersions.push(...incomingGroupVersions.map((version) => structuredClone(version)))
  const incomingOrderVersions = batch.orderVersions.filter((version) => !draft.orderVersions.some((item) => item.id === version.id))
  draft.orderVersions.push(...incomingOrderVersions.map((version) => structuredClone(version)))
  const latestOrder = [...incomingOrderVersions].sort((a, b) => a.savedAt.localeCompare(b.savedAt)).at(-1)
  if (latestOrder) applyOrderVersion(draft, latestOrder, incomingGroupVersions)
  for (const pkg of batch.packages) {
    mergePackageIntoProject(draft, pkg)
    const local = nextSync.packages.find((item) => item.id === pkg.id)
    if (!local) nextSync.packages.push({ ...pkg, direction: pkg.originDeviceId === draft.deviceId ? 'outbox' : 'inbox' })
    else {
      const merged: PracticePackage = {
        ...pkg,
        direction: local.direction,
        uploadedChunks: Array.from(new Set([...local.uploadedChunks, ...pkg.uploadedChunks])).sort((a, b) => a - b),
        downloadedChunks: Array.from(new Set([...local.downloadedChunks, ...pkg.downloadedChunks])).sort((a, b) => a - b)
      }
      Object.assign(local, merged)
    }
  }
  for (const feedback of nextSync.pendingFeedback) nextSync = placeFeedback(draft, nextSync, feedback)
  nextSync.cursor = batch.cursor || nextSync.cursor
  return { project: draft, sync: nextSync }
}

async function uploadOutbox(project: PracticeProject, sync: SyncState, checkpoint: Checkpoint): Promise<SyncResult> {
  let nextProject = project
  let nextSync = sync
  for (const groupVersion of project.groupVersions) await adapter.putGroupVersion(groupVersion)
  for (const orderVersion of project.orderVersions) await adapter.putOrderVersion(orderVersion)

  for (const feedback of sync.feedbackQueue) {
    const winner = await adapter.putFeedback(feedback)
    nextSync.pendingFeedback = nextSync.pendingFeedback.filter((item) => item.id !== feedback.id)
    nextSync = placeFeedback(nextProject, nextSync, winner)
    nextSync = { ...nextSync, feedbackQueue: nextSync.feedbackQueue.filter((item) => item.id !== feedback.id) }
  }

  for (const original of sync.packages.filter((pkg) => pkg.direction === 'outbox' && pkg.status !== 'done')) {
    let pkg = structuredClone(original)
    pkg = { ...pkg, status: 'uploading', lastError: undefined }
    nextSync = replacePackage(nextSync, pkg)
    await checkpoint(nextProject, nextSync)
    const attempt = nextProject.attempts.find((item) => item.id === pkg.attemptId)
    const blob = attempt?.audioBlob
    pkg.attemptPayload = attempt ? toPayload(attempt) : pkg.attemptPayload
    pkg.audioHash = attempt?.audioHash ?? pkg.audioHash
    if (blob && pkg.audioHash) {
      const audioHash = pkg.audioHash
      const meta = await adapter.audioMeta(audioHash)
      if (meta && meta.size === blob.size) {
        pkg = { ...pkg, audioChunks: meta.chunks, chunkSize: meta.chunkSize, audioSize: meta.size, uploadedChunks: Array.from({ length: meta.chunks }, (_, index) => index), audio: 'done' }
      } else for (let index = 0; index < pkg.audioChunks; index += 1) {
        if (pkg.uploadedChunks.includes(index)) continue
        const chunk = blob.slice(index * pkg.chunkSize, Math.min(blob.size, (index + 1) * pkg.chunkSize), blob.type)
        await adapter.putAudioChunk(
          audioHash,
          index,
          chunk,
          { size: blob.size, chunks: pkg.audioChunks, chunkSize: pkg.chunkSize, mime: blob.type || pkg.attemptPayload.audioMime }
        )
        pkg = { ...pkg, uploadedChunks: [...pkg.uploadedChunks, index].sort((a, b) => a - b), audio: 'uploading', checkpointAt: new Date().toISOString() }
        nextSync = replacePackage(nextSync, pkg)
        await checkpoint(nextProject, nextSync)
      }
      pkg = { ...pkg, audio: 'done' }
    }
    pkg = { ...pkg, order: 'done', issues: 'done' }
    const remote = await adapter.putPackage({ ...pkg, status: 'uploading', manifest: 'uploading' })
    pkg = {
      ...remote,
      direction: 'outbox',
      status: 'done',
      audio: pkg.audio,
      order: 'done',
      issues: 'done',
      manifest: 'done',
      checkpointAt: new Date().toISOString()
    }
    nextSync = replacePackage(nextSync, pkg)
    await checkpoint(nextProject, nextSync)
  }
  return { project: nextProject, sync: nextSync }
}

async function downloadInboxAudio(project: PracticeProject, sync: SyncState, checkpoint: Checkpoint): Promise<SyncResult> {
  let nextProject = project
  let nextSync = sync
  for (const original of sync.packages.filter((pkg) => pkg.direction === 'inbox' && pkg.status === 'done')) {
    const pkg = structuredClone(original)
    const attempt = nextProject.attempts.find((item) => item.id === pkg.attemptId)
    if (attempt?.audioBlob) continue
    if (!pkg.audioHash || pkg.audioChunks === 0) continue
    for (let index = 0; index < pkg.audioChunks; index += 1) {
      if (pkg.downloadedChunks.includes(index)) continue
      const key = `${pkg.audioHash}:${index}`
      let chunk = await getAudioChunk(key).catch(() => undefined)
      if (!chunk) {
        chunk = await adapter.getAudioChunk(pkg.audioHash, index)
        if (chunk) await putAudioChunk(key, chunk).catch(() => undefined)
      }
      if (!chunk) throw new Error(`录音分片 ${index + 1} 暂不可用`)
      pkg.downloadedChunks = [...pkg.downloadedChunks, index].sort((a, b) => a - b)
      pkg.audio = statusFor(pkg.downloadedChunks, pkg.audioChunks)
      pkg.checkpointAt = new Date().toISOString()
      nextSync = replacePackage(nextSync, pkg)
      await checkpoint(nextProject, nextSync)
    }
    const chunks: Blob[] = []
    for (let index = 0; index < pkg.audioChunks; index += 1) {
      const chunk = await getAudioChunk(`${pkg.audioHash}:${index}`)
      if (!chunk) throw new Error('本地断点录音缺失')
      chunks.push(chunk)
    }
    const audioBlob = new Blob(chunks, { type: pkg.attemptPayload.audioMime })
    const target = nextProject.attempts.find((item) => item.id === pkg.attemptId)
    if (target) {
      target.audioBlob = audioBlob
      target.audioHash = pkg.audioHash
      target.audioMime = pkg.attemptPayload.audioMime
    }
    pkg.audio = 'done'
    nextSync = replacePackage(nextSync, pkg)
    await checkpoint(nextProject, nextSync)
    for (let index = 0; index < pkg.audioChunks; index += 1) await deleteAudioChunk(`${pkg.audioHash}:${index}`).catch(() => undefined)
  }
  return { project: nextProject, sync: nextSync }
}

export async function synchronize(project: PracticeProject, sync: SyncState, checkpoint: Checkpoint): Promise<SyncResult> {
  if (!navigator.onLine) {
    return { project, sync: { ...sync, syncing: false, lastMessage: '当前离线：练习包已保存在本机，联网后从断点继续' } }
  }
  let nextSync: SyncState = { ...sync, syncing: true, lastMessage: '正在合并两端版本…' }
  let nextProject = project
  await checkpoint(nextProject, nextSync)
  try {
    const batch = await adapter.pull(nextSync.cursor)
    ;({ project: nextProject, sync: nextSync } = mergeBatch(nextProject, nextSync, batch))
    await checkpoint(nextProject, { ...nextSync, lastMessage: '正在上传录音分片…' })
    ;({ project: nextProject, sync: nextSync } = await uploadOutbox(nextProject, nextSync, checkpoint))
    ;({ project: nextProject, sync: nextSync } = await downloadInboxAudio(nextProject, nextSync, checkpoint))
    nextSync = { ...nextSync, syncing: false, lastSyncAt: new Date().toISOString(), lastMessage: '同步完成：已传部分已保留，重复录音只保存一份' }
    await checkpoint(nextProject, nextSync)
    return { project: nextProject, sync: nextSync }
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步中断'
    nextSync = { ...nextSync, syncing: false, lastMessage: `已保留断点：${message}` }
    await checkpoint(nextProject, nextSync).catch(() => undefined)
    return { project: nextProject, sync: nextSync }
  }
}

export function queueFeedback(sync: SyncState, feedback: SegmentFeedback): SyncState {
  return {
    ...sync,
    feedbackQueue: [...sync.feedbackQueue.filter((item) => item.id !== feedback.id), feedback]
  }
}

export function packageProgress(pkg: PracticePackage) {
  const total = Math.max(pkg.audioChunks, 0) + 3
  const uploaded = pkg.direction === 'inbox' ? pkg.downloadedChunks.length : pkg.uploadedChunks.length
  const audioDone = pkg.audio === 'done' ? Math.max(pkg.audioChunks, 0) : uploaded
  const done = audioDone + (pkg.order === 'done' ? 1 : 0) + (pkg.issues === 'done' ? 1 : 0) + (pkg.manifest === 'done' ? 1 : 0)
  return Math.round(done / total * 100)
}

export function reassignPendingFeedback(project: PracticeProject, sync: SyncState, feedbackId: string, groupId: string): SyncResult {
  const feedback = sync.pendingFeedback.find((item) => item.id === feedbackId)
  if (!feedback) return { project, sync }
  const nextFeedback: SegmentFeedback = { ...feedback, groupId, groupVersionId: project.groups.find((group) => group.id === groupId)?.versionId }
  const nextProject = structuredClone(project)
  updateFeedbackInProject(nextProject, nextFeedback)
  return {
    project: nextProject,
    sync: queueFeedback({ ...sync, pendingFeedback: sync.pendingFeedback.filter((item) => item.id !== feedbackId) }, nextFeedback)
  }
}

export function feedbackIsAnchored(project: PracticeProject, feedback: SegmentFeedback) {
  const order = project.orderVersions.find((version) => version.entries.some((entry) => entry.groupId === feedback.groupId))
  const group = project.groups.some((item) => item.id === feedback.groupId)
  const attempt = project.attempts.some((item) => item.id === feedback.attemptId)
  return Boolean(order && group && attempt)
}
