// 客户端同步引擎端到端测试（node --test，经 esbuild 转译）。
// 用内存 Map 模拟两台设备各自的本地库，用 __useMemoryServer 模拟云端，
// 完整走一遍：学生录音离线打包→分片上传→教师拉取并留反馈→学生拉取合并→
// 教师撤回（墓碑）→学生再同步旧反馈不复活；以及断网排队、重开页面按服务端断点续传。
import assert from 'node:assert/strict'
import test from 'node:test'

const sync = await import('./sync.ts')
const runtime = await import('./runtime.ts')
const mockServer = await import('./mock-server.ts')
const serverCore = await import('./server-core.ts')
const types = await import('./types.ts')

// --- 用内存存储注入运行时，替换 sync 引擎默认的 IndexedDB 实现 ---------------
const audioMem = new Map<string, Blob>()
const bundleMem = new Map<string, types.OutboxBundle>()

const hashBlob = async (blob: Blob) => {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

runtime.setRuntime({
  hashBlob,
  putAudio: async (hash, blob) => void audioMem.set(hash, blob),
  getAudio: async (hash) => audioMem.get(hash),
  listBundles: async () => Array.from(bundleMem.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  putBundle: async (b) => void bundleMem.set(b.id, b),
  deleteBundle: async (id) => void bundleMem.delete(id),
  pushBundle: (payload, projectId) => mockServer.pushBundle(payload, projectId),
  uploadChunk: async (hash, index, total, chunkSize, mime, chunk) => {
    const ack = await mockServer.uploadChunk(hash, index, total, chunkSize, mime, chunk)
    return { receivedChunks: ack.receivedChunks, complete: ack.complete }
  },
  getChunkStatus: (hash) => mockServer.getChunkStatus(hash),
  fetchSnapshot: () => mockServer.fetchSnapshot(),
  downloadAudio: (hash) => mockServer.downloadAudio(hash),
  isOffline: () => mockServer.mockNetwork.isOffline()
})

// 云端用内存状态
const serverState = serverCore.createServerState()
mockServer.__useMemoryServer(serverState)
mockServer.mockNetwork.setLatency(0)

const iso = (m: number) => new Date(Date.now() + m * 60000).toISOString()
const deviceStudent = { deviceId: 'dev-student', name: '学生平板', createdAt: iso(-100) }
const deviceTeacher = { deviceId: 'dev-teacher', name: '学校电脑', createdAt: iso(-100) }
const noopSave = async () => {}

function makeProject(): types.PracticeProject {
  const now = iso(-50)
  const groups = [
    { id: 'g1', text: '清晨的海风', stressWords: [], stressLevel: 2 as const, pauseMs: 300, intonation: 'flat' as const, note: '', updatedAt: now },
    { id: 'g2', text: '掠过旧码头', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'fall' as const, note: '', updatedAt: now }
  ]
  const order = { id: 'o1', groupIds: ['g1', 'g2'], source: 'student' as const, createdAt: now, label: '初版' }
  return {
    id: 'proj-1',
    title: '测试练习',
    sentence: '清晨的海风，掠过旧码头',
    translation: '',
    teacher: '陈老师',
    targetAttempts: 3,
    targetDuration: 8,
    groups,
    attempts: [],
    errorCategories: ['声调'],
    activeOrderVersionId: 'o1',
    orderVersions: [order],
    pendingFeedback: [],
    updatedAt: now
  }
}

function makeAudioBlob(size: number): Blob {
  const unit = 'abcdef0123456789'
  let out = ''
  while (out.length < size) out += unit
  return new Blob([out.slice(0, size)], { type: 'audio/webm' })
}

async function recordAttempt(project: types.PracticeProject, blob: Blob): Promise<types.Attempt> {
  let attempt: types.Attempt = {
    id: `attempt-${Math.random().toString(36).slice(2, 8)}`,
    number: project.attempts.length + 1,
    label: `第 ${project.attempts.length + 1} 轮`,
    createdAt: new Date().toISOString(),
    revisedAt: new Date().toISOString(),
    duration: 4.2,
    audioMime: 'audio/webm',
    simulated: false,
    rangeStart: 0,
    rangeEnd: 4.2,
    orderVersionId: project.orderVersions[0].id,
    scores: [],
    wordIssues: [],
    feedback: [],
    selfNote: ''
  }
  attempt = await sync.stampAudioHash(attempt, blob)
  await runtime.getRuntime().putAudio(attempt.audioHash!, blob)
  project.attempts.push(attempt)
  return attempt
}

test('端到端：学生录音离线排队、分片上传，教师拉取留反馈，学生合并；教师撤回墓碑不复活', async () => {
  // 300 KiB > 默认 256 KiB 分片，自然切成 2 片。
  const studentProject = makeProject()
  const blob = makeAudioBlob(300 * 1024)
  const attempt = await recordAttempt(studentProject, blob)

  await sync.enqueuePracticeBundle(studentProject, attempt, { deviceId: deviceStudent.deviceId, projectId: studentProject.id })
  assert.equal((await runtime.getRuntime().listBundles()).length, 1)

  // 断网时同步优雅返回，练习包原样留在队列，不丢任何东西。
  mockServer.mockNetwork.setOffline(true)
  const offlineResult = await sync.syncOnce(studentProject, noopSave, () => {})
  assert.equal(offlineResult.pulled, false)
  assert.equal((await runtime.getRuntime().listBundles()).length, 1)
  mockServer.mockNetwork.setOffline(false)

  // 联网完整同步：分片上传 + 元数据提交，outbox 清空，云端一份录音。
  await sync.syncOnce(studentProject, async (next) => Object.assign(studentProject, next), () => {})
  assert.equal((await runtime.getRuntime().listBundles()).length, 0)
  assert.equal(Object.keys(serverState.audio).length, 1)

  // 同一录音重复提交：hash 相同，服务端不产生第二份录音、第二条轮次。
  await sync.enqueuePracticeBundle(studentProject, attempt, { deviceId: deviceStudent.deviceId, projectId: studentProject.id })
  await sync.syncOnce(studentProject, noopSave, () => {})
  assert.equal(Object.keys(serverState.audio).length, 1)
  assert.equal(serverState.projects[0].attempts.length, 1)

  // 教师设备（本地无此录音）拉取：看到轮次并自动下载录音。
  const teacherProject = makeProject()
  audioMem.clear()
  let teacherSaved: types.PracticeProject | null = null
  await sync.syncOnce(teacherProject, async (next) => (teacherSaved = next), () => {})
  assert.ok(teacherSaved)
  assert.equal(teacherSaved!.attempts.length, 1)
  const teacherAttemptId = teacherSaved!.attempts[0].id
  assert.equal(teacherSaved!.attempts[0].audioHash, attempt.audioHash)
  assert.ok(audioMem.has(attempt.audioHash!))

  // 教师按 g2 留反馈（独立反馈包）。
  const feedback = { id: 'fb-1', groupId: 'g2', teacher: '陈老师', text: '“掠”字再轻一点', createdAt: iso(0) }
  teacherSaved!.attempts[0].feedback.push(feedback)
  await sync.enqueueFeedbackBundle(feedback, teacherAttemptId, { deviceId: deviceTeacher.deviceId, projectId: teacherProject.id })
  await sync.syncOnce(teacherProject, noopSave, () => {})
  assert.equal(serverState.projects[0].attempts[0].feedback.find((f) => f.id === 'fb-1')?.text, '“掠”字再轻一点')

  // 学生再同步，合并到教师反馈。
  await sync.syncOnce(studentProject, async (next) => Object.assign(studentProject, next), () => {})
  assert.equal(studentProject.attempts[0].feedback.find((f) => f.id === 'fb-1')?.text, '“掠”字再轻一点')

  // 教师撤回反馈（墓碑）并同步。
  const tombstone = { ...feedback, text: '', deletedAt: iso(1) }
  await sync.enqueueFeedbackBundle(tombstone, teacherAttemptId, { deviceId: deviceTeacher.deviceId, projectId: teacherProject.id })
  await sync.syncOnce(teacherProject, noopSave, () => {})

  // 学生再同步：本地旧反馈被墓碑删除，不复活。
  await sync.syncOnce(studentProject, async (next) => Object.assign(studentProject, next), () => {})
  assert.ok(!studentProject.attempts[0].feedback.some((f) => f.id === 'fb-1'), '撤回的反馈不能在学生副本里出现')
})

test('断点续传：服务端只收到部分分片时，重开页面后从断点补传，已传部分不重传', async () => {
  bundleMem.clear()
  for (const key of Object.keys(serverState.audio)) delete serverState.audio[key]
  serverState.projects = []

  const project = makeProject()
  const blob = makeAudioBlob(300 * 1024)
  const attempt = await recordAttempt(project, blob)
  await sync.enqueuePracticeBundle(project, attempt, { deviceId: deviceStudent.deviceId, projectId: project.id })
  const bundle = (await runtime.getRuntime().listBundles()).find((b) => b.payload.kind === 'practice')!
  const manifest = bundle.payload.kind === 'practice' ? bundle.payload.audio! : undefined!
  assert.equal(manifest.totalChunks, 2)

  // 云端只有第 0 片（模拟上次传到一半、页面关闭）。
  const full = await blob.arrayBuffer()
  const first = new Blob([full.slice(0, manifest.chunkSize)], { type: blob.type })
  await mockServer.uploadChunk(manifest.hash, 0, manifest.totalChunks, manifest.chunkSize, manifest.mime, first)

  // 同步时 getChunkStatus 返回 1，只补传第 1 片即完成，最终 outbox 清空。
  await sync.syncOnce(project, async (next) => Object.assign(project, next), () => {})
  assert.equal((await runtime.getRuntime().listBundles()).length, 0)
  assert.equal(serverState.audio[manifest.hash].received, manifest.totalChunks)
  assert.equal(serverState.audio[manifest.hash].size, blob.size)
})
