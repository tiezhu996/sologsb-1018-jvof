export type Intonation = 'fall' | 'rise' | 'flat' | 'rise-fall' | 'fall-rise'
export type StressLevel = 0 | 1 | 2 | 3
export type PartStatus = 'pending' | 'uploading' | 'done' | 'error'
export type FeedbackStatus = 'active' | 'edited' | 'withdrawn'

export interface SenseGroup {
  id: string
  text: string
  stressWords: string[]
  stressLevel: StressLevel
  pauseMs: number
  intonation: Intonation
  note: string
  versionId?: string
  parentVersionId?: string | null
  order: number
  createdAt: string
}

export interface GroupVersion {
  id: string
  groupId: string
  parentVersionId: string | null
  order: number
  savedAt: string
  teacherName?: string
  snapshot?: SenseGroup
}

export interface OrderEntry {
  groupId: string
  groupVersionId: string
  order: number
}

export interface OrderVersion {
  id: string
  parentVersionId: string | null
  savedAt: string
  entries: OrderEntry[]
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
  attemptId: string
  originDeviceId?: string
  groupId: string
  groupVersionId?: string
  teacher: string
  text: string
  createdAt: string
  updatedAt: string
  status: FeedbackStatus
  previousText?: string
}

export interface Attempt {
  id: string
  originDeviceId?: string
  number: number
  label: string
  createdAt: string
  clientUpdatedAt: string
  duration: number
  audioBlob?: Blob
  audioMime: string
  audioHash?: string
  simulated: boolean
  rangeStart: number
  rangeEnd: number
  scores: GroupScore[]
  wordIssues: WordIssue[]
  feedback: SegmentFeedback[]
  selfNote: string
  orderVersionId: string
}

export interface AttemptPayload {
  id: string
  number: number
  label: string
  createdAt: string
  clientUpdatedAt: string
  duration: number
  audioMime: string
  audioHash?: string
  simulated: boolean
  rangeStart: number
  rangeEnd: number
  scores: GroupScore[]
  wordIssues: WordIssue[]
  selfNote: string
  orderVersionId: string
}

export interface PracticePackage {
  id: string
  attemptId: string
  originDeviceId: string
  revision: number
  orderVersionId: string
  createdAt: string
  enqueuedAt: string
  attemptPayload: AttemptPayload
  orderSnapshot: OrderEntry[]
  audioHash?: string
  audioSize: number
  audioChunks: number
  chunkSize: number
  status: PartStatus
  audio: PartStatus
  order: PartStatus
  issues: PartStatus
  manifest: PartStatus
  uploadedChunks: number[]
  downloadedChunks: number[]
  direction: 'outbox' | 'inbox'
  lastError?: string
  checkpointAt?: string
}

export interface PracticeProject {
  id: string
  deviceId: string
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  groupVersions: GroupVersion[]
  orderVersions: OrderVersion[]
  currentOrderVersionId: string
  attempts: Attempt[]
  errorCategories: string[]
  updatedAt: string
}

export interface SyncState {
  deviceId: string
  packages: PracticePackage[]
  feedbackQueue: SegmentFeedback[]
  pendingFeedback: SegmentFeedback[]
  cursor: string
  lastSyncAt?: string
  lastMessage: string
  syncing: boolean
}

export interface PersistedPractice {
  project: PracticeProject
  sync: SyncState
  version: 2
}

export interface SyncBatch {
  groupVersions: GroupVersion[]
  orderVersions: OrderVersion[]
  packages: PracticePackage[]
  feedback: SegmentFeedback[]
  cursor: string
  serverTime: string
}
