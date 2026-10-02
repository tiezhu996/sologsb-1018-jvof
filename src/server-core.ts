// 服务端合并规则（纯函数，不依赖 IndexedDB / DOM）。
// mock-server.ts 用它处理状态，Node 测试脚本也可以直接验证规则。
//
// 关键不变量：
// 1. 反馈墓碑（deletedAt）一旦写入就压过任何同 id 的旧内容，撤回不可复活。
// 2. 意群顺序版本只增不删、取并集；反馈锚定 groupId 而非位置。
// 3. 反馈锚定的意群不属于任何顺序版本时，进入待处理区。
// 4. 录音按内容 hash 寻址，分片按序号幂等写入。

import type {
  AudioManifest,
  BundlePayload,
  OrderVersion,
  PendingFeedbackItem,
  PracticePayload,
  SegmentFeedback,
  SenseGroup,
  ServerProject
} from './types'

export interface ServerAudioRecord {
  hash: string
  mime: string
  size: number
  chunkSize: number
  chunks: unknown[]
  received: number
}

export interface ServerCoreState {
  projects: ServerProject[]
  audio: Record<string, ServerAudioRecord>
  revision: number
}

export function createServerState(): ServerCoreState {
  return { projects: [], audio: {}, revision: 0 }
}

export function getProject(state: ServerCoreState, id: string): ServerProject {
  let project = state.projects.find((item) => item.id === id)
  if (!project) {
    project = {
      id,
      title: '',
      sentence: '',
      translation: '',
      teacher: '',
      targetAttempts: 0,
      targetDuration: 0,
      groups: [],
      orderVersions: [],
      attempts: [],
      pendingFeedback: [],
      errorCategories: [],
      updatedAt: new Date(0).toISOString()
    }
    state.projects.push(project)
  }
  return project
}

export function upsertFeedback(list: SegmentFeedback[], incoming: SegmentFeedback): void {
  const index = list.findIndex((item) => item.id === incoming.id)
  if (index < 0) {
    list.push(incoming)
    return
  }
  const current = list[index]
  // 墓碑永不被旧内容覆盖。
  if (current.deletedAt && (!incoming.deletedAt || Date.parse(incoming.deletedAt) <= Date.parse(current.deletedAt))) return
  if (!current.deletedAt && incoming.deletedAt) {
    list[index] = incoming
    return
  }
  const incomingStamp = Math.max(Date.parse(incoming.createdAt), incoming.deletedAt ? Date.parse(incoming.deletedAt) : 0)
  const currentStamp = Math.max(Date.parse(current.createdAt), current.deletedAt ? Date.parse(current.deletedAt) : 0)
  if (incomingStamp >= currentStamp) list[index] = incoming
}

export function reanchorFeedback(project: ServerProject, attemptId: string, feedback: SegmentFeedback, arrivedAt: string, force = false): void {
  const anchorExists = project.groups.some((group) => group.id === feedback.groupId)
  const attempt = project.attempts.find((item) => item.id === attemptId)
  // 主动改指（force）无条件信任新锚点；随练习包到达的反馈需通过锚点校验。
  const anchorable = force || anchorExists
  if (anchorable && attempt && !feedback.deletedAt) {
    upsertFeedback(attempt.feedback, feedback)
    project.pendingFeedback = project.pendingFeedback.filter((item) => item.feedback.id !== feedback.id)
    return
  }
  if (attempt && feedback.deletedAt) upsertFeedback(attempt.feedback, feedback)
  const pending: PendingFeedbackItem = { feedback, attemptId, reason: 'missing-group', arrivedAt }
  const index = project.pendingFeedback.findIndex((item) => item.feedback.id === feedback.id)
  if (index >= 0) project.pendingFeedback[index] = pending
  else project.pendingFeedback.push(pending)
}

/**
 * 依据意群实体重判所有反馈的锚点：
 * - 顺序重排不会让反馈失联：学生改了顺序、教师按旧顺序留的反馈都锚定同一个 groupId；
 * - 只有意群实体被删除（不属于任何版本）时，反馈才进入待处理区；
 * - 待处理区里锚点重新出现（学生恢复意群 / 教师改指）的反馈回归对应轮次。
 */
export function reanchorAttemptFeedback(project: ServerProject): void {
  const knownGroups = new Set(project.groups.map((group) => group.id))

  // 待处理区里的墓碑在对应轮次落地（供快照下发），然后移出待处理区；
  // 非墓碑反馈只要锚点重新出现就回归。
  const resolved: PendingFeedbackItem[] = []
  for (const item of project.pendingFeedback) {
    const attempt = project.attempts.find((entry) => entry.id === item.attemptId)
    if (item.feedback.deletedAt) {
      if (attempt) upsertFeedback(attempt.feedback, item.feedback)
      resolved.push(item)
      continue
    }
    if (knownGroups.has(item.feedback.groupId) && attempt) {
      upsertFeedback(attempt.feedback, item.feedback)
      resolved.push(item)
    }
  }
  if (resolved.length) project.pendingFeedback = project.pendingFeedback.filter((item) => !resolved.includes(item))

  // 轮次中失去锚点（意群实体已删）的反馈转入待处理区。
  for (const attempt of project.attempts) {
    const stranded = attempt.feedback.filter((feedback) => !feedback.deletedAt && !knownGroups.has(feedback.groupId))
    attempt.feedback = attempt.feedback.filter((feedback) => feedback.deletedAt || knownGroups.has(feedback.groupId))
    for (const feedback of stranded) {
      const pending: PendingFeedbackItem = { feedback, attemptId: attempt.id, reason: 'missing-group', arrivedAt: new Date().toISOString() }
      const index = project.pendingFeedback.findIndex((item) => item.feedback.id === feedback.id)
      if (index >= 0) project.pendingFeedback[index] = pending
      else project.pendingFeedback.push(pending)
    }
  }
}

export function mergeGroups(project: ServerProject, groups: SenseGroup[]): void {
  for (const incoming of groups) {
    const current = project.groups.find((group) => group.id === incoming.id)
    if (!current) project.groups.push(incoming)
    else if ((incoming.updatedAt ?? '') >= (current.updatedAt ?? '')) Object.assign(current, incoming)
  }
}

export function mergeOrderVersion(project: ServerProject, version: OrderVersion): void {
  if (!project.orderVersions.some((item) => item.id === version.id)) project.orderVersions.push(version)
  project.orderVersions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function applyPractice(state: ServerCoreState, payload: PracticePayload, projectId: string): void {
  const project = getProject(state, projectId)
  mergeGroups(project, payload.groups)
  mergeOrderVersion(project, payload.orderVersion)

  const attemptData = { ...payload.attempt, audioBlob: undefined }
  let attempt = project.attempts.find((item) => item.id === attemptData.id)
  if (!attempt) {
    project.attempts.push({
      ...attemptData,
      audio: payload.audio
        ? { hash: payload.audio.hash, mime: payload.audio.mime, size: payload.audio.size, chunkSize: payload.audio.chunkSize }
        : undefined
    })
    attempt = project.attempts.at(-1)!
  } else {
    if (attemptData.revisedAt >= (attempt.revisedAt ?? attemptData.createdAt)) {
      Object.assign(attempt, {
        number: attemptData.number,
        label: attemptData.label,
        duration: attemptData.duration,
        audioMime: attemptData.audioMime,
        simulated: attemptData.simulated,
        rangeStart: attemptData.rangeStart,
        rangeEnd: attemptData.rangeEnd,
        revisedAt: attemptData.revisedAt,
        orderVersionId: attemptData.orderVersionId ?? attempt.orderVersionId,
        scores: attemptData.scores,
        selfNote: attemptData.selfNote
      })
    }
    for (const issue of attemptData.wordIssues) {
      const index = attempt.wordIssues.findIndex((item) => item.id === issue.id)
      if (index >= 0) attempt.wordIssues[index] = issue
      else attempt.wordIssues.push(issue)
    }
  }

  for (const feedback of attemptData.feedback) {
    if (feedback.deletedAt) {
      upsertFeedback(attempt.feedback, feedback)
      project.pendingFeedback = project.pendingFeedback.filter((item) => item.feedback.id !== feedback.id)
    } else {
      reanchorFeedback(project, attempt.id, feedback, new Date().toISOString())
    }
  }

  for (const category of payload.errorCategories) {
    if (!project.errorCategories.includes(category)) project.errorCategories.push(category)
  }
  if (!project.title) {
    project.title = payload.projectMeta.title
    project.sentence = payload.projectMeta.sentence
    project.translation = payload.projectMeta.translation
    project.teacher = payload.projectMeta.teacher
    project.targetAttempts = payload.projectMeta.targetAttempts
    project.targetDuration = payload.projectMeta.targetDuration
  }
  reanchorAttemptFeedback(project)
  project.updatedAt = new Date().toISOString()
}

/** 应用一个练习包到内存状态。返回是否已存在完整录音（用于客户端跳过重传）。 */
export function applyBundle(state: ServerCoreState, payload: BundlePayload, projectId: string): { alreadyHasAudio: boolean } {
  if (payload.kind === 'practice') {
    applyPractice(state, payload, projectId)
  } else if (payload.kind === 'order') {
    const project = getProject(state, projectId)
    mergeGroups(project, payload.groups)
    mergeOrderVersion(project, payload.orderVersion)
    // 意群被彻底删除：移除实体后，挂在其上的反馈由重锚逻辑转入待处理区。
    if (payload.removedGroupIds.length) {
      project.groups = project.groups.filter((group) => !payload.removedGroupIds.includes(group.id))
    }
    reanchorAttemptFeedback(project)
    project.updatedAt = new Date().toISOString()
  } else if (payload.kind === 'wordIssue') {
    const project = getProject(state, projectId)
    const attempt = project.attempts.find((item) => item.id === payload.attemptId)
    if (attempt) {
      const index = attempt.wordIssues.findIndex((item) => item.id === payload.issue.id)
      if (index >= 0) attempt.wordIssues[index] = payload.issue
      else attempt.wordIssues.push(payload.issue)
    }
  } else if (payload.kind === 'feedback') {
    const project = getProject(state, projectId)
    if (payload.attemptId) {
      const attempt = project.attempts.find((item) => item.id === payload.attemptId)
      if (attempt) {
        // 先依据当前全部顺序版本收敛存量反馈，再应用这条显式反馈动作，
        // 这样"重新锚定"不会紧接着被全量重锚推回待处理区。
        reanchorAttemptFeedback(project)
        if (payload.feedback.deletedAt) {
          upsertFeedback(attempt.feedback, payload.feedback)
          project.pendingFeedback = project.pendingFeedback.filter((item) => item.feedback.id !== payload.feedback.id)
        } else {
          // 独立反馈包代表教师的显式动作，信任其锚点（含按旧版本顺序留的反馈）。
          reanchorFeedback(project, attempt.id, payload.feedback, new Date().toISOString(), true)
        }
      }
    }
  }
  state.revision += 1
  const alreadyHasAudio =
    payload.kind === 'practice' && payload.audio ? Boolean(state.audio[payload.audio.hash]?.received >= payload.audio.totalChunks) : true
  return { alreadyHasAudio }
}

/** 幂等记录一个录音分片。同一 hash 重复上传只写一份，按序号覆盖。 */
export function recordChunk(
  state: ServerCoreState,
  hash: string,
  index: number,
  totalChunks: number,
  chunkSize: number,
  mime: string,
  chunk: { size: number } | unknown,
  sizeOf: (value: unknown) => number
): { receivedChunks: number; complete: boolean } {
  const audio = state.audio[hash] ?? { hash, mime, size: 0, chunkSize, chunks: [], received: 0 }
  if (!audio.chunks[index]) audio.received += 1
  audio.chunks[index] = chunk as ServerAudioRecord['chunks'][number]
  audio.mime = mime
  audio.size = audio.chunks.reduce<number>((sum, item) => sum + sizeOf(item), 0)
  state.audio[hash] = audio
  return { receivedChunks: audio.received, complete: audio.received >= totalChunks }
}

export function audioComplete(state: ServerCoreState, manifest: AudioManifest): boolean {
  return Boolean(state.audio[manifest.hash]?.received >= manifest.totalChunks)
}
