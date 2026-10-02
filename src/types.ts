export type Intonation = 'fall' | 'rise' | 'flat' | 'rise-fall' | 'fall-rise'
export type StressLevel = 0 | 1 | 2 | 3

export interface SenseGroup {
  id: string
  text: string
  stressWords: string[]
  stressLevel: StressLevel
  pauseMs: number
  intonation: Intonation
  note: string
  /** 最后修改时间，多端合并时按它做 last-write-wins。 */
  updatedAt?: string
}

export interface GroupScore {
  groupId: string
  accuracy: number
  rhythm: number
  deviation: number
  note: string
}

export interface WordIssue {
  id: string
  groupId: string
  word: string
  category: string
  note: string
}

export interface SegmentFeedback {
  id: string
  groupId: string
  teacher: string
  text: string
  createdAt: string
  /** 改写/撤回时间；存在表示该反馈已被撤回（墓碑标记）。 */
  deletedAt?: string
}

/**
 * 意群顺序版本。学生调整意群顺序后会生成新版本；教师若按旧顺序留过反馈，
 * 新旧两个版本都会保留，反馈始终锚定它被写下时那版顺序里的意群 id。
 */
export interface OrderVersion {
  id: string
  groupIds: string[]
  source: 'student' | 'teacher'
  createdAt: string
  label: string
}

export interface Attempt {
  id: string
  number: number
  label: string
  createdAt: string
  duration: number
  audioBlob?: Blob
  audioMime: string
  /** 录音内容哈希，去重与断点续传都以它为准。 */
  audioHash?: string
  /** 录音是否已成功上传到服务端。 */
  audioSynced?: boolean
  /** 录音是否本设备录制；false 表示从其他设备同步而来。 */
  audioFromRemote?: boolean
  simulated: boolean
  rangeStart: number
  rangeEnd: number
  /** 本轮内容（分数/自评/范围）最后修改时间，多端合并按它判定新旧。 */
  revisedAt: string
  /** 本轮提交时锚定的意群顺序版本。 */
  orderVersionId?: string
  scores: GroupScore[]
  wordIssues: WordIssue[]
  feedback: SegmentFeedback[]
  selfNote: string
  /** 打包进练习包后写入的 outbox 条目 id，未打包为空。 */
  bundleId?: string
  syncedAt?: string
}

/** 找不到意群锚点的反馈（含教师撤回墓碑）暂存于此，等待重新锚定或撤回。 */
export interface PendingFeedbackItem {
  feedback: SegmentFeedback
  attemptId: string
  reason: 'missing-group'
  arrivedAt: string
}

export interface PracticeProject {
  id: string
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  attempts: Attempt[]
  errorCategories: string[]
  /** 当前生效的意群顺序版本。 */
  activeOrderVersionId: string
  /** 历史上出现过的全部意群顺序版本，两端合并取并集。 */
  orderVersions: OrderVersion[]
  /** 等待重新锚定的反馈。 */
  pendingFeedback: PendingFeedbackItem[]
  updatedAt: string
}

export interface PersistedPractice {
  project: PracticeProject
  version: 2
}

// ---------------------------------------------------------------------------
// 同步层
// ---------------------------------------------------------------------------

export type BundleKind = 'practice' | 'order' | 'wordIssue' | 'feedback'

/** 练习包清单里录音的描述。 */
export interface AudioManifest {
  hash: string
  mime: string
  size: number
  chunkSize: number
  totalChunks: number
}

export interface PracticePayload {
  kind: 'practice'
  attempt: Attempt
  /** 提交时的意群快照（不含录音 Blob）。 */
  groups: SenseGroup[]
  orderVersion: OrderVersion
  audio?: AudioManifest
  /** 提交时的错词分类表，随练习包一并同步。 */
  errorCategories: string[]
  /** 句子/标题等项目级元数据，首包从学生设备建立云端项目。 */
  projectMeta: Pick<PracticeProject, 'title' | 'sentence' | 'translation' | 'teacher' | 'targetAttempts' | 'targetDuration'>
}

export interface OrderPayload {
  kind: 'order'
  orderVersion: OrderVersion
  groups: SenseGroup[]
  /** 被彻底删除（不属于任何历史版本）的意群 id；其上反馈进入待处理区。 */
  removedGroupIds: string[]
}

export interface WordIssuePayload {
  kind: 'wordIssue'
  attemptId: string
  issue: WordIssue
}

export interface FeedbackPayload {
  kind: 'feedback'
  /** 空表示不绑定具体轮次。 */
  attemptId: string | null
  feedback: SegmentFeedback
  /** 撤回/改写时携带，便于服务端把旧反馈移出待处理区。 */
  replaces?: string
}

export type BundlePayload = PracticePayload | OrderPayload | WordIssuePayload | FeedbackPayload

/** outbox 中一条可离线提交、可断点续传的练习包。 */
export interface OutboxBundle {
  id: string
  projectId: string
  deviceId: string
  kind: BundleKind
  createdAt: string
  payload: BundlePayload
  /** practice 包的录音字节，其余类型为空。 */
  audioBlob?: Blob
  status: 'queued' | 'uploading' | 'synced' | 'error'
  /** 已确认收到的录音分片序号（断点）。 */
  ackedChunk: number
  attempts: number
  lastError?: string
  syncedAt?: string
}

export interface DeviceIdentity {
  deviceId: string
  name: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// 模拟服务端（同构接口，未来可替换成真实 HTTP 传输）
// ---------------------------------------------------------------------------

export interface ServerAudioRef {
  hash: string
  mime: string
  size: number
  chunkSize: number
}

export interface ServerProject {
  id: string
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  orderVersions: OrderVersion[]
  attempts: Array<Omit<Attempt, 'audioBlob'> & { audio?: ServerAudioRef }>
  /** 独立反馈流（与具体轮次解绑时使用），主流程仍挂在 attempts.feedback。 */
  feedback?: SegmentFeedback[]
  feedbackAttempt?: Record<string, string | null>
  pendingFeedback: PendingFeedbackItem[]
  errorCategories: string[]
  updatedAt: string
}

export interface SyncSnapshot {
  serverNow: string
  projects: ServerProject[]
  /** 可下载的录音内容哈希。 */
  audioHashes: string[]
}

export interface SyncResult {
  snapshot: SyncSnapshot
  /** 本次新下载到本机的录音哈希。 */
  downloadedAudio: string[]
  pushed: number
  pulled: boolean
}
