import type { Attempt, GroupVersion, OrderVersion, PersistedPractice, PracticeProject, SegmentFeedback, SenseGroup, SyncState } from './types'

const DB_NAME = 'sologsb-1018-prosody'
const DB_VERSION = 2
const STORE = 'practice'
const KEY = 'current'
const CHUNK_STORE = 'sync-chunks'
const FALLBACK_KEY = 'sologsb-1018-fallback'
const DEVICE_KEY = 'sologsb-1018-device-id'
export const INITIAL_ORDER_VERSION_ID = 'order-version-initial'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function createDeviceId() {
  const stored = localStorage.getItem(DEVICE_KEY)
  if (stored) return stored
  const id = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  localStorage.setItem(DEVICE_KEY, id)
  return id
}

function entriesFor(groups: SenseGroup[]) {
  return groups.map((group) => ({ groupId: group.id, groupVersionId: group.versionId ?? '', order: group.order }))
}

function migrateV1(value: { project: PracticeProject }): PersistedPractice {
  const now = new Date().toISOString()
  const project = normalizeProject(value.project)
  return { project, sync: createSyncState(project.deviceId), version: 2 }
}

function migrateFeedback(feedback: Omit<SegmentFeedback, 'status' | 'updatedAt' | 'attemptId'> & Partial<SegmentFeedback>, attemptId: string, versionId: string): SegmentFeedback {
  return {
    ...feedback,
    attemptId: feedback.attemptId ?? attemptId,
    groupVersionId: feedback.groupVersionId ?? versionId,
    status: feedback.status ?? 'active',
    updatedAt: feedback.updatedAt ?? feedback.createdAt
  }
}

export function createSyncState(deviceId = createDeviceId()): SyncState {
  return { deviceId, packages: [], feedbackQueue: [], pendingFeedback: [], cursor: '0', lastMessage: '尚未提交练习包', syncing: false }
}

export function normalizeProject(project: PracticeProject): PracticeProject {
  const now = new Date().toISOString()
  const groups: SenseGroup[] = project.groups.map((group, index) => ({
    ...group,
    order: group.order ?? index,
    createdAt: group.createdAt ?? now,
    versionId: group.versionId ?? `group-version-initial-${group.id}`,
    parentVersionId: group.parentVersionId ?? null
  }))
  const groupVersions: GroupVersion[] = project.groupVersions?.length
    ? project.groupVersions
    : groups.map((group) => ({ id: `group-version-initial-${group.id}`, groupId: group.id, parentVersionId: null, order: group.order, savedAt: now }))
  const orderVersions: OrderVersion[] = project.orderVersions?.length
    ? project.orderVersions
    : [{ id: INITIAL_ORDER_VERSION_ID, parentVersionId: null, savedAt: now, entries: entriesFor(groups) }]
  const currentOrderVersionId = project.currentOrderVersionId || orderVersions.at(-1)?.id || INITIAL_ORDER_VERSION_ID
  return {
    ...project,
    id: project.id || 'practice-harbor-letter',
    deviceId: project.deviceId || createDeviceId(),
    groups,
    groupVersions,
    orderVersions,
    currentOrderVersionId,
    attempts: project.attempts.map((attempt) => {
      const orderVersionId = (attempt as Partial<Attempt>).orderVersionId ?? (attempt as Partial<Attempt> & { groupVersionId?: string }).groupVersionId ?? currentOrderVersionId
      return {
        ...attempt,
        clientUpdatedAt: attempt.clientUpdatedAt ?? attempt.createdAt,
        orderVersionId,
        feedback: attempt.feedback.map((feedback) => migrateFeedback(feedback, attempt.id, feedback.groupVersionId ?? orderVersionId))
      }
    })
  }
}

export async function loadPractice(): Promise<PersistedPractice | null> {
  try {
    const db = await openDb()
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (!value) return null
    const stored = value as PersistedPractice | { project: PracticeProject; version?: number; sync?: SyncState }
    if (stored.version === 2 && stored.project && stored.sync) {
      return { ...(stored as PersistedPractice), project: normalizeProject(stored.project), sync: { ...createSyncState(stored.sync.deviceId), ...stored.sync, syncing: false } }
    }
    return migrateV1(stored as { project: PracticeProject })
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PracticeProject
    const project = normalizeProject({ ...parsed, attempts: parsed.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined })) })
    return { project, sync: createSyncState(project.deviceId), version: 2 }
  }
}

export async function savePractice(project: PracticeProject, sync?: SyncState): Promise<'indexeddb' | 'localstorage'> {
  const previous = await loadPractice().catch(() => null)
  const value: PersistedPractice = {
    project,
    sync: sync ?? previous?.sync ?? createSyncState(project.deviceId),
    version: 2
  }
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(value, KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
    return 'indexeddb'
  } catch {
    const fallback = { ...project, attempts: project.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined })) }
    localStorage.setItem(FALLBACK_KEY, JSON.stringify({ project: fallback, sync: value.sync, version: 2 }))
    return 'localstorage'
  }
}

export async function putAudioChunk(key: string, chunk: Blob): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(CHUNK_STORE, 'readwrite')
    transaction.objectStore(CHUNK_STORE).put(chunk, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

export async function getAudioChunk(key: string): Promise<Blob | undefined> {
  const db = await openDb()
  const value = await new Promise<Blob | undefined>((resolve, reject) => {
    const transaction = db.transaction(CHUNK_STORE, 'readonly')
    const request = transaction.objectStore(CHUNK_STORE).get(key)
    request.onsuccess = () => resolve(request.result as Blob | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return value
}

export async function deleteAudioChunk(key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(CHUNK_STORE, 'readwrite')
    transaction.objectStore(CHUNK_STORE).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
  })
  db.close()
}

export async function clearPractice(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE, CHUNK_STORE], 'readwrite')
      transaction.objectStore(STORE).clear()
      transaction.objectStore(CHUNK_STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // Ignore cleanup errors and clear the fallback below.
  }
  localStorage.removeItem(FALLBACK_KEY)
}
