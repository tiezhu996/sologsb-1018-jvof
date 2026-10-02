// 客户端同步引擎：
// - 每轮练习/顺序调整/错词/反馈都打包成 OutboxBundle，离线也能入队；
// - 录音切成固定大小分片逐片上传，ackedChunk 落库，断网或重开页面从断点续传；
// - 录音按 SHA-256 内容寻址，同一份录音重复提交服务端只存一份；
// - 拉取快照时按 id 合并：顺序版本取并集、反馈墓碑优先、失联反馈进待处理区。

import { getRuntime } from './runtime'
import { mockNetwork, NetworkError } from './mock-server'
import type {
  Attempt,
  OrderVersion,
  OutboxBundle,
  PendingFeedbackItem,
  PracticeProject,
  SegmentFeedback,
  SenseGroup,
  SyncResult,
  WordIssue
} from './types'

export const CHUNK_SIZE = 256 * 1024 // 256 KiB，分片越小，弱网续传代价越低。
export type SyncPhase = 'idle' | 'pushing' | 'downloading' | 'merging' | 'done' | 'error' | 'offline'

export interface SyncProgress {
  phase: SyncPhase
  message: string
  /** 0-100，仅录音上传阶段有意义。 */
  percent: number
  bundleLabel?: string
}

export type ProgressListener = (progress: SyncProgress) => void

export interface BundleContext {
  deviceId: string
  projectId: string
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function chunkBlob(blob: Blob, size: number): Blob[] {
  const chunks: Blob[] = []
  for (let start = 0; start < blob.size; start += size) {
    chunks.push(blob.slice(start, Math.min(blob.size, start + size), blob.type))
  }
  return chunks.length ? chunks : [blob]
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

export async function enqueuePracticeBundle(
  project: PracticeProject,
  attempt: Attempt,
  context: BundleContext
): Promise<OutboxBundle> {
  const orderVersion = project.orderVersions.find((version) => version.id === attempt.orderVersionId) ?? project.orderVersions.at(-1)!
  const groups: SenseGroup[] = orderVersion.groupIds
    .map((id) => project.groups.find((group) => group.id === id))
    .filter((group): group is SenseGroup => Boolean(group))

  const bundle: OutboxBundle = {
    id: uid('bundle'),
    projectId: context.projectId,
    deviceId: context.deviceId,
    kind: 'practice',
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'practice',
      attempt: structuredClone({ ...attempt, audioBlob: undefined }),
      groups: structuredClone(groups),
      orderVersion: structuredClone(orderVersion),
      errorCategories: [...project.errorCategories],
      projectMeta: {
        title: project.title,
        sentence: project.sentence,
        translation: project.translation,
        teacher: project.teacher,
        targetAttempts: project.targetAttempts,
        targetDuration: project.targetDuration
      },
      ...(attempt.audioBlob && attempt.audioHash
        ? {
            audio: {
              hash: attempt.audioHash,
              mime: attempt.audioMime,
              size: attempt.audioBlob.size,
              chunkSize: CHUNK_SIZE,
              totalChunks: Math.ceil(attempt.audioBlob.size / CHUNK_SIZE)
            }
          }
        : {})
    },
    audioBlob: attempt.audioBlob,
    status: 'queued',
    ackedChunk: 0,
    attempts: 0
  }
  await getRuntime().putBundle(bundle)
  return bundle
}

export async function enqueueOrderBundle(
  project: PracticeProject,
  version: OrderVersion,
  context: BundleContext,
  removedGroupIds: string[] = []
): Promise<OutboxBundle> {
  const bundle: OutboxBundle = {
    id: uid('bundle'),
    projectId: context.projectId,
    deviceId: context.deviceId,
    kind: 'order',
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'order',
      orderVersion: structuredClone(version),
      groups: structuredClone(project.groups.filter((group) => version.groupIds.includes(group.id))),
      removedGroupIds
    },
    status: 'queued',
    ackedChunk: 0,
    attempts: 0
  }
  await getRuntime().putBundle(bundle)
  return bundle
}

export async function enqueueFeedbackBundle(
  feedback: SegmentFeedback,
  attemptId: string | null,
  context: BundleContext
): Promise<OutboxBundle> {
  const bundle: OutboxBundle = {
    id: uid('bundle'),
    projectId: context.projectId,
    deviceId: context.deviceId,
    kind: 'feedback',
    createdAt: new Date().toISOString(),
    payload: { kind: 'feedback', feedback: structuredClone(feedback), attemptId },
    status: 'queued',
    ackedChunk: 0,
    attempts: 0
  }
  await getRuntime().putBundle(bundle)
  return bundle
}

export async function enqueueWordIssueBundle(
  issue: WordIssue,
  attemptId: string,
  context: BundleContext
): Promise<OutboxBundle> {
  const bundle: OutboxBundle = {
    id: uid('bundle'),
    projectId: context.projectId,
    deviceId: context.deviceId,
    kind: 'wordIssue',
    createdAt: new Date().toISOString(),
    payload: { kind: 'wordIssue', issue: structuredClone(issue), attemptId },
    status: 'queued',
    ackedChunk: 0,
    attempts: 0
  }
  await getRuntime().putBundle(bundle)
  return bundle
}

// ---------------------------------------------------------------------------
// 上传（断点续传）
// ---------------------------------------------------------------------------

async function pushOneBundle(bundle: OutboxBundle, onProgress: ProgressListener): Promise<boolean> {
  bundle.attempts += 1
  onProgress({ phase: 'pushing', message: '正在提交练习包清单…', percent: 0, bundleLabel: describeBundle(bundle) })

  // practice 包：先续传录音分片（按服务端 ack 定位断点），再提交元数据。
  if (bundle.kind === 'practice' && bundle.audioBlob && bundle.payload.kind === 'practice' && bundle.payload.audio) {
    const manifest = bundle.payload.audio
    let resumeFrom = bundle.ackedChunk
    try {
      // 重开页面后以服务端实际收到的分片为准，避免本机状态与服务端不一致。
      const serverAcked = await getRuntime().getChunkStatus(manifest.hash)
      resumeFrom = Math.max(resumeFrom, serverAcked)
    } catch (error) {
      if (error instanceof NetworkError) throw error
      // 查询失败时按本机断点继续，分片上传本身是幂等的。
    }

    if (resumeFrom < manifest.totalChunks) {
      const chunks = chunkBlob(bundle.audioBlob, manifest.chunkSize)
      for (let index = resumeFrom; index < manifest.totalChunks; index += 1) {
        onProgress({
          phase: 'pushing',
          message: `录音分片 ${index + 1} / ${manifest.totalChunks}（已传部分不会重传）`,
          percent: Math.round((index / manifest.totalChunks) * 100),
          bundleLabel: describeBundle(bundle)
        })
        const ack = await getRuntime().uploadChunk(manifest.hash, index, manifest.totalChunks, manifest.chunkSize, manifest.mime, chunks[index])
        bundle.ackedChunk = Math.max(ack.receivedChunks, index + 1)
        bundle.status = 'uploading'
        await getRuntime().putBundle(bundle) // 每片确认后立即落库断点
      }
    }
  }

  const result = await getRuntime().pushBundle(bundle.payload, bundle.projectId)
  void result
  bundle.status = 'synced'
  bundle.syncedAt = new Date().toISOString()
  bundle.lastError = undefined
  bundle.ackedChunk = bundle.payload.kind === 'practice' && bundle.payload.audio ? bundle.payload.audio.totalChunks : bundle.ackedChunk
  await getRuntime().putBundle(bundle)
  await getRuntime().deleteBundle(bundle.id)
  return true
}

function describeBundle(bundle: OutboxBundle): string {
  switch (bundle.kind) {
    case 'practice':
      return bundle.payload.kind === 'practice' ? `第 ${bundle.payload.attempt.number} 轮练习` : '练习包'
    case 'order':
      return '意群顺序'
    case 'wordIssue':
      return '错词记录'
    case 'feedback':
      return bundle.payload.kind === 'feedback' && bundle.payload.feedback.deletedAt ? '撤回反馈' : '教师反馈'
  }
}

// ---------------------------------------------------------------------------
// 拉取与合并
// ---------------------------------------------------------------------------

function mergeFeedback(existing: SegmentFeedback[], incoming: SegmentFeedback[]): SegmentFeedback[] {
  const map = new Map<string, SegmentFeedback>()
  for (const item of existing) {
    if (!item.deletedAt) map.set(item.id, item)
  }
  for (const item of incoming) {
    if (item.deletedAt) {
      map.delete(item.id)
      continue
    }
    const current = map.get(item.id)
    if (!current || Date.parse(item.createdAt) >= Date.parse(current.createdAt)) map.set(item.id, item)
  }
  return Array.from(map.values())
}

/** 合并待处理区；带墓碑的条目用于删除本地反馈，自身不在待处理区保留。 */
function mergePending(local: PendingFeedbackItem[], remote: PendingFeedbackItem[]): { pending: PendingFeedbackItem[]; tombstoneIds: Set<string> } {
  const map = new Map<string, PendingFeedbackItem>()
  for (const item of local) {
    if (!item.feedback.deletedAt) map.set(item.feedback.id, item)
  }
  const tombstoneIds = new Set<string>()
  for (const item of remote) {
    if (item.feedback.deletedAt) {
      tombstoneIds.add(item.feedback.id)
      map.delete(item.feedback.id)
      continue
    }
    const current = map.get(item.feedback.id)
    if (!current || Date.parse(item.arrivedAt) >= Date.parse(current.arrivedAt)) map.set(item.feedback.id, item)
  }
  return { pending: Array.from(map.values()), tombstoneIds }
}

function mergeGroups(local: SenseGroup[], remote: SenseGroup[]): SenseGroup[] {
  const map = new Map<string, SenseGroup>()
  for (const group of local) map.set(group.id, group)
  for (const group of remote) {
    const current = map.get(group.id)
    if (!current || (group.updatedAt ?? '') >= (current.updatedAt ?? '')) map.set(group.id, group)
  }
  return Array.from(map.values())
}

function mergeOrderVersions(local: OrderVersion[], remote: OrderVersion[]): OrderVersion[] {
  const map = new Map<string, OrderVersion>()
  for (const version of local) map.set(version.id, version)
  for (const version of remote) {
    if (!map.has(version.id)) map.set(version.id, version)
  }
  return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * 把服务端快照合并进本机项目。返回新的项目对象（调用方负责保存）和需要下载的录音哈希。
 * 教师撤回的反馈（远程缺失且本机标记 deletedAt）由反馈包先行同步，这里不会把它拉回来。
 */
export async function mergeSnapshot(project: PracticeProject, result: SyncResult): Promise<{ merged: PracticeProject; toDownload: string[] }> {
  const remoteProject = result.snapshot.projects.find((item) => item.id === project.id)
  if (!remoteProject) return { merged: project, toDownload: [] }

  const groups = mergeGroups(project.groups, remoteProject.groups)
  const orderVersions = mergeOrderVersions(project.orderVersions, remoteProject.orderVersions)

  const localAttemptMap = new Map(project.attempts.map((attempt) => [attempt.id, attempt]))
  const mergedAttempts: Attempt[] = []
  const toDownload = new Set<string>()

  for (const remoteAttemptRaw of remoteProject.attempts) {
    // 剥离服务端专有的 audio 引用，客户端 Attempt 只保留 audioHash。
    const { audio: remoteAudioRef, ...remoteAttempt } = remoteAttemptRaw
    void remoteAudioRef
    const localAttempt = localAttemptMap.get(remoteAttempt.id)
    const remoteHash = remoteAudioRef?.hash
    if (!localAttempt) {
      const localBlob = remoteHash ? await getRuntime().getAudio(remoteHash) : undefined
      if (remoteHash && !localBlob && result.snapshot.audioHashes.includes(remoteHash)) toDownload.add(remoteHash)
      mergedAttempts.push({
        ...remoteAttempt,
        audioBlob: localBlob,
        audioHash: remoteHash ?? remoteAttempt.audioHash,
        audioFromRemote: !localBlob,
        audioSynced: Boolean(remoteHash)
      })
      continue
    }

    const useRemoteMeta = (remoteAttempt.revisedAt ?? remoteAttempt.createdAt) >= (localAttempt.revisedAt ?? localAttempt.createdAt)
    const base = useRemoteMeta ? remoteAttempt : localAttempt
    const merged: Attempt = {
      ...base,
      // 错词按 id 并集；本机删除以不再出现在 practice 包为准，这里保守取并集。
      wordIssues: mergeById(localAttempt.wordIssues, remoteAttempt.wordIssues),
      feedback: mergeFeedback(localAttempt.feedback, remoteAttempt.feedback),
      audioMime: localAttempt.audioMime || remoteAttempt.audioMime,
      audioHash: localAttempt.audioHash ?? remoteHash,
      audioSynced: localAttempt.audioSynced || Boolean(remoteHash),
      audioFromRemote: localAttempt.audioFromRemote
    }
    if (localAttempt.audioBlob) merged.audioBlob = localAttempt.audioBlob
    else if (remoteHash) {
      const localBlob = await getRuntime().getAudio(remoteHash)
      if (localBlob) merged.audioBlob = localBlob
      else if (result.snapshot.audioHashes.includes(remoteHash)) toDownload.add(remoteHash)
      merged.audioFromRemote = !localBlob
    }
    mergedAttempts.push(merged)
  }

  // 仅本机存在、还没同步成功的尝试保留。
  for (const localAttempt of project.attempts) {
    if (!remoteProject.attempts.some((attempt) => attempt.id === localAttempt.id)) mergedAttempts.push(localAttempt)
  }
  mergedAttempts.sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt))

  const pendingResult = mergePending(project.pendingFeedback, remoteProject.pendingFeedback)
  // 待处理区里的墓碑同样要清掉所有轮次中残留的旧反馈。
  if (pendingResult.tombstoneIds.size) {
    for (const attempt of mergedAttempts) {
      attempt.feedback = attempt.feedback.filter((feedback) => !pendingResult.tombstoneIds.has(feedback.id))
    }
  }
  const merged: PracticeProject = {
    ...project,
    groups,
    orderVersions,
    attempts: mergedAttempts,
    pendingFeedback: pendingResult.pending,
    errorCategories: Array.from(new Set([...project.errorCategories, ...remoteProject.errorCategories])),
    updatedAt: remoteProject.updatedAt > project.updatedAt ? remoteProject.updatedAt : project.updatedAt
  }
  // 服务端最新顺序作为默认激活版本，但学生在本机的新版本（尚未推送）仍保留可选。
  const remoteLatest = remoteProject.orderVersions.at(-1)
  if (remoteLatest && merged.orderVersions.some((version) => version.id === remoteLatest.id)) {
    merged.activeOrderVersionId = remoteLatest.id
  }
  return { merged, toDownload: Array.from(toDownload) }
}

function mergeById<T extends { id: string }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>()
  for (const item of local) map.set(item.id, item)
  for (const item of remote) if (!map.has(item.id)) map.set(item.id, item)
  return Array.from(map.values())
}

// ---------------------------------------------------------------------------
// 同步主流程
// ---------------------------------------------------------------------------

export async function syncOnce(
  project: PracticeProject,
  saveProject: (next: PracticeProject) => Promise<void>,
  onProgress: ProgressListener = () => undefined
): Promise<SyncResult> {
  if (getRuntime().isOffline() || mockNetwork.isOffline()) {
    onProgress({ phase: 'offline', message: '当前离线：练习包已在本机排队，联网后自动续传。', percent: 0 })
    return { snapshot: { serverNow: new Date().toISOString(), projects: [], audioHashes: [] }, downloadedAudio: [], pushed: 0, pulled: false }
  }

  const bundles = (await getRuntime().listBundles()).filter((bundle) => bundle.status !== 'synced')
  let pushed = 0
  try {
    for (const bundle of bundles) {
      try {
        await pushOneBundle(bundle, onProgress)
        pushed += 1
      } catch (error) {
        bundle.status = 'error'
        bundle.lastError = error instanceof Error ? error.message : String(error)
        await getRuntime().putBundle(bundle) // 保住已传分片断点
        onProgress({
          phase: 'error',
          message: `${describeBundle(bundle)}上传中断：${bundle.lastError} 已传 ${bundle.ackedChunk} 片，恢复后从这里继续。`,
          percent: Math.round((bundle.ackedChunk / Math.max(1, bundle.payload.kind === 'practice' ? bundle.payload.audio?.totalChunks ?? 1 : 1)) * 100),
          bundleLabel: describeBundle(bundle)
        })
        // 继续尝试后面的轻量包（反馈/错词），录音大包下次再续。
        if (bundle.kind === 'practice') continue
      }
    }

    onProgress({ phase: 'downloading', message: '正在获取学校电脑上的反馈…', percent: 0 })
    const snapshot = await getRuntime().fetchSnapshot()
    onProgress({ phase: 'merging', message: '正在合并两端版本…', percent: 0 })
    const { merged, toDownload } = await mergeSnapshot(project, { snapshot, downloadedAudio: [], pushed, pulled: true })
    await saveProject(merged)

    const downloadedAudio: string[] = []
    for (const hash of toDownload) {
      onProgress({ phase: 'downloading', message: '正在下载其他设备的录音…', percent: Math.round((downloadedAudio.length / Math.max(1, toDownload.length)) * 100) })
      try {
        const blob = await getRuntime().downloadAudio(hash)
        await getRuntime().putAudio(hash, blob)
        downloadedAudio.push(hash)
      } catch {
        // 单个录音下载失败不阻塞反馈合并，下次同步再试。
      }
    }
    if (downloadedAudio.length) {
      const rehydrated = await hydrateDownloadedAudio(merged, downloadedAudio)
      await saveProject(rehydrated)
    }

    onProgress({ phase: 'done', message: `同步完成：上传 ${pushed} 个练习包，合并 ${snapshot.projects.reduce((sum, item) => sum + item.pendingFeedback.length + item.attempts.reduce((s, a) => s + a.feedback.length, 0), 0)} 条反馈。`, percent: 100 })
    return { snapshot, downloadedAudio, pushed, pulled: true }
  } catch (error) {
    onProgress({ phase: 'error', message: error instanceof Error ? error.message : String(error), percent: 0 })
    throw error
  }
}

async function hydrateDownloadedAudio(project: PracticeProject, hashes: string[]): Promise<PracticeProject> {
  const next = structuredClone(project)
  await Promise.all(
    next.attempts.map(async (attempt) => {
      if (attempt.audioHash && hashes.includes(attempt.audioHash) && !attempt.audioBlob) {
        attempt.audioBlob = await getRuntime().getAudio(attempt.audioHash)
        attempt.audioFromRemote = false
      }
    })
  )
  return next
}

/** 录音录制结束后计算内容哈希，供去重与打包使用。 */
export async function stampAudioHash(attempt: Attempt, blob: Blob): Promise<Attempt> {
  const audioHash = await getRuntime().hashBlob(blob)
  return { ...attempt, audioHash, audioBlob: blob, audioMime: blob.type || attempt.audioMime }
}
