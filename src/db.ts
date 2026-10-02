// IndexedDB 多仓封装：项目、设备身份、练习包 outbox、录音库、同步断点。
// 录音 Blob 与项目文档分开存放，避免每次保存标注都序列化整段录音。

const DB_NAME = 'sologsb-1018-prosody-v2'
export const DB_VERSION = 2

export const STORES = {
  meta: 'meta', // 单条杂项（设备身份、同步断点、拉取水位）
  project: 'project', // 练习项目文档（不含录音 Blob）
  outbox: 'outbox', // 待上传练习包（含录音 Blob）
  audio: 'audio' // hash -> Blob，所有设备共用的去重录音库
} as const

export const META_KEYS = {
  device: 'device',
  projectKey: 'projectKey',
  pullCursor: 'pullCursor'
} as const

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // v1 旧库（单仓 practice）不在这里迁移；storage.ts 单独做一次性搬移。
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta)
      if (!db.objectStoreNames.contains(STORES.project)) db.createObjectStore(STORES.project)
      if (!db.objectStoreNames.contains(STORES.outbox)) db.createObjectStore(STORES.outbox, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.audio)) db.createObjectStore(STORES.audio)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
    request.onblocked = () => reject(new Error('数据库被其他标签页占用'))
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const request = run(transaction.objectStore(store))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T>)
}

export function idbPut<T>(store: string, value: T, key?: IDBValidKey): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => (key !== undefined ? s.put(value, key) : s.put(value)))
}

export function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  return tx(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
}

export function idbGetAll<T>(store: string): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

export function idbClear(store: string): Promise<void> {
  return tx(store, 'readwrite', (s) => s.clear()).then(() => undefined)
}

/** localStorage 退化方案的键（IndexedDB 不可用时使用，不保存录音 Blob）。 */
export const FALLBACK_KEY = 'sologsb-1018-fallback-v2'
export const LEGACY_DB_NAME = 'sologsb-1018-prosody'
export const LEGACY_STORE = 'practice'
export const LEGACY_KEY = 'current'
