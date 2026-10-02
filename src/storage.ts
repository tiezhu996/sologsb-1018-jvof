import {
  FALLBACK_KEY,
  idbClear,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  LEGACY_DB_NAME,
  LEGACY_KEY,
  LEGACY_STORE,
  META_KEYS,
  openDb,
  STORES
} from './db'
import type {
  Attempt,
  DeviceIdentity,
  OrderVersion,
  OutboxBundle,
  PersistedPractice,
  PracticeProject
} from './types'

const PROJECT_KEY = 'main'
const FALLBACK_BUNDLE_KEY = 'sologsb-1018-outbox-fallback'

export type SaveTarget = 'indexeddb' | 'localstorage'

// ---------------------------------------------------------------------------
// 录音哈希与录音库
// ---------------------------------------------------------------------------

export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function putAudio(hash: string, blob: Blob): Promise<void> {
  await idbPut(STORES.audio, blob, hash)
}

export async function getAudio(hash: string): Promise<Blob | undefined> {
  return idbGet<Blob>(STORES.audio, hash)
}

export async function hasAudio(hash: string): Promise<boolean> {
  try {
    const blob = await getAudio(hash)
    return Boolean(blob)
  } catch {
    return false
  }
}

/** 把项目文档与录音库对齐：已知哈希的录音补回 Blob，游离 Blob 不重复加载。 */
async function hydrateAudio(project: PracticeProject): Promise<PracticeProject> {
  await Promise.all(
    project.attempts.map(async (attempt) => {
      if (attempt.audioHash && !attempt.audioBlob) {
        attempt.audioBlob = await getAudio(attempt.audioHash)
      }
    })
  )
  return project
}

function stripAudio(project: PracticeProject): PracticeProject {
  return {
    ...project,
    attempts: project.attempts.map((attempt) => {
      const { audioBlob, ...rest } = attempt
      void audioBlob
      return rest
    })
  }
}

// ---------------------------------------------------------------------------
// 项目读写（含 v1 数据迁移）
// ---------------------------------------------------------------------------

function migrateV1(raw: { project: PracticeProject; version?: number } | PracticeProject): PracticeProject {
  // 旧版结构是 { project, version: 1 }
  const old = ('project' in raw ? raw.project : raw) as PracticeProject
  const now = new Date().toISOString()
  const orderVersion: OrderVersion = {
    id: 'order-v1-initial',
    groupIds: old.groups.map((group) => group.id),
    source: 'student',
    createdAt: old.updatedAt ?? now,
    label: '初始顺序（迁移自单设备版本）'
  }
  const groups = old.groups.map((group) => ({ ...group, updatedAt: group.updatedAt ?? old.updatedAt ?? now }))
  const attempts: Attempt[] = old.attempts.map((attempt) => ({
    ...attempt,
    revisedAt: attempt.createdAt,
    orderVersionId: orderVersion.id
  }))
  return {
    id: old.id ?? 'project-main',
    title: old.title,
    sentence: old.sentence,
    translation: old.translation,
    teacher: old.teacher,
    targetAttempts: old.targetAttempts,
    targetDuration: old.targetDuration,
    groups,
    attempts,
    errorCategories: old.errorCategories,
    activeOrderVersionId: orderVersion.id,
    orderVersions: [orderVersion],
    pendingFeedback: old.pendingFeedback ?? [],
    updatedAt: old.updatedAt ?? now
  }
}

function openLegacyDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (indexedDB.databases && typeof indexedDB.databases === 'function') {
      indexedDB
        .databases()
        .then((names) => {
          if (!names.some((item) => item.name === LEGACY_DB_NAME)) return resolve(null)
          doOpen()
        })
        .catch(doOpen)
    } else {
      doOpen()
    }
    function doOpen() {
      const request = indexedDB.open(LEGACY_DB_NAME, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      // 全新环境下旧库不存在，部分浏览器会触发 onupgradeneeded；立即关闭即可。
      request.onupgradeneeded = () => request.result.close()
    }
  })
}

async function migrateLegacyIfNeeded(): Promise<PracticeProject | null> {
  let legacy: IDBDatabase | null = null
  try {
    legacy = await openLegacyDb()
    if (!legacy || !legacy.objectStoreNames.contains(LEGACY_STORE)) return null
    const raw = await new Promise<unknown>((resolve) => {
      const request = legacy!.transaction(LEGACY_STORE, 'readonly').objectStore(LEGACY_STORE).get(LEGACY_KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    if (!raw) return null
    const migrated = migrateV1(raw as { project: PracticeProject })
    // 旧版录音以内联 Blob 存在项目里，搬到录音库并按内容哈希去重。
    for (const attempt of migrated.attempts) {
      const inline = (attempt as Attempt & { audioBlob?: Blob }).audioBlob
      if (inline) {
        attempt.audioHash = await hashBlob(inline)
        await putAudio(attempt.audioHash, inline)
        delete attempt.audioBlob
      }
    }
    await savePractice(migrated)
    // 迁移成功后删除旧库，避免重复搬移。
    legacy.close()
    await new Promise<void>((resolve) => {
      const deleteRequest = indexedDB.deleteDatabase(LEGACY_DB_NAME)
      deleteRequest.onsuccess = () => resolve()
      deleteRequest.onerror = () => resolve()
      deleteRequest.onblocked = () => resolve()
    })
    return migrated
  } catch {
    legacy?.close()
    return null
  }
}

export async function loadPractice(): Promise<PracticeProject | null> {
  try {
    const existing = await idbGet<PersistedPractice>(STORES.project, PROJECT_KEY)
    if (existing?.project) return hydrateAudio(structuredClone(existing.project))
    const migrated = await migrateLegacyIfNeeded()
    if (migrated) return hydrateAudio(structuredClone(migrated))
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (raw) {
      const fallback = JSON.parse(raw) as PracticeProject
      return fallback
    }
  }
  return null
}

export async function savePractice(project: PracticeProject): Promise<SaveTarget> {
  try {
    // 录音单独存 audio 仓；保存前确保新录音已入录音库。
    await Promise.all(
      project.attempts.map(async (attempt) => {
        if (attempt.audioBlob && attempt.audioHash && !(await hasAudio(attempt.audioHash))) {
          await putAudio(attempt.audioHash, attempt.audioBlob)
        }
      })
    )
    const value: PersistedPractice = { project: stripAudio(project), version: 2 }
    await idbPut(STORES.project, value, PROJECT_KEY)
    return 'indexeddb'
  } catch {
    const fallback = {
      ...project,
      attempts: project.attempts.map((attempt) => {
        const { audioBlob: _blob, ...rest } = attempt
        void _blob
        return rest
      })
    }
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(fallback))
    return 'localstorage'
  }
}

// ---------------------------------------------------------------------------
// Outbox 练习包
// ---------------------------------------------------------------------------

export async function listBundles(): Promise<OutboxBundle[]> {
  try {
    const bundles = await idbGetAll<OutboxBundle>(STORES.outbox)
    return bundles.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } catch {
    try {
      return JSON.parse(localStorage.getItem(FALLBACK_BUNDLE_KEY) ?? '[]') as OutboxBundle[]
    } catch {
      return []
    }
  }
}

export async function putBundle(bundle: OutboxBundle): Promise<void> {
  try {
    await idbPut(STORES.outbox, bundle)
  } catch {
    const bundles = await listBundles()
    const index = bundles.findIndex((item) => item.id === bundle.id)
    if (index >= 0) bundles[index] = bundle
    else bundles.push(bundle)
    // 退化存储里不带录音 Blob，断点续传只能重传元数据。
    localStorage.setItem(FALLBACK_BUNDLE_KEY, JSON.stringify(bundles.map((item) => ({ ...item, audioBlob: undefined }))))
  }
}

export async function getBundle(id: string): Promise<OutboxBundle | undefined> {
  const bundles = await listBundles()
  return bundles.find((item) => item.id === id)
}

export async function deleteBundle(id: string): Promise<void> {
  try {
    await idbDelete(STORES.outbox, id)
  } catch {
    const bundles = (await listBundles()).filter((item) => item.id !== id)
    localStorage.setItem(FALLBACK_BUNDLE_KEY, JSON.stringify(bundles))
  }
}

// ---------------------------------------------------------------------------
// 设备身份 / 同步水位 / 清空
// ---------------------------------------------------------------------------

export async function getDevice(): Promise<DeviceIdentity | null> {
  try {
    return (await idbGet<DeviceIdentity>(STORES.meta, META_KEYS.device)) ?? null
  } catch {
    return null
  }
}

export async function saveDevice(device: DeviceIdentity): Promise<void> {
  try {
    await idbPut(STORES.meta, device, META_KEYS.device)
  } catch {
    localStorage.setItem('sologsb-1018-device', JSON.stringify(device))
  }
}

export async function clearAllLocal(): Promise<void> {
  try {
    await Promise.all([idbClear(STORES.project), idbClear(STORES.outbox), idbClear(STORES.audio)])
  } catch {
    // 退化环境走下面的 localStorage 清理；设备身份保留，便于重新同步。
  }
  localStorage.removeItem(FALLBACK_KEY)
  localStorage.removeItem(FALLBACK_BUNDLE_KEY)
}
