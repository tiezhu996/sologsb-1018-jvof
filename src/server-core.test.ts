// 端到端规则测试（node --test）。不依赖浏览器/DOM：
// 覆盖 分片断点续传、录音 hash 去重、错词排队、意群改版后反馈仍锚定旧版、
// 找不到锚点进待处理区、教师撤回墓碑不可复活、重复提交幂等。
import assert from 'node:assert/strict'
import test from 'node:test'

// 通过 vite 的 esbuild 在测试启动时转译 TS（见 scripts/run-core-tests.mjs）。
const core = await import('./server-core.ts')

const { applyBundle, createServerState, recordChunk } = core as typeof import('./server-core.ts')

let seq = 0
const id = (prefix: string) => `${prefix}-${(seq += 1)}`
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString()

function sizeOf(value: unknown): number {
  return (value as { size?: number })?.size ?? 0
}
const fakeChunk = (size: number) => ({ size })

function makePracticeBundle(overrides: {
  attemptId: string
  groups: import('./types.ts').SenseGroup[]
  orderVersion: import('./types.ts').OrderVersion
  feedback?: import('./types.ts').SegmentFeedback[]
  wordIssues?: import('./types.ts').WordIssue[]
  audioHash?: string
  totalChunks?: number
  revisedAt?: string
  rangeEnd?: number
}) {
  const { attemptId, groups, orderVersion, feedback = [], wordIssues = [], audioHash, totalChunks = 3, revisedAt = iso(0), rangeEnd = 5 } = overrides
  return {
    kind: 'practice' as const,
    attempt: {
      id: attemptId,
      number: 1,
      label: '第 1 轮',
      createdAt: iso(-10),
      revisedAt,
      duration: 5,
      audioMime: 'audio/webm',
      simulated: false,
      rangeStart: 0,
      rangeEnd,
      orderVersionId: orderVersion.id,
      scores: [],
      wordIssues,
      feedback,
      selfNote: ''
    },
    groups,
    orderVersion,
    errorCategories: ['声调'],
    projectMeta: { title: 't', sentence: 's', translation: 'e', teacher: '陈老师', targetAttempts: 5, targetDuration: 10 },
    ...(audioHash
      ? { audio: { hash: audioHash, mime: 'audio/webm', size: 30, chunkSize: 10, totalChunks } }
      : {})
  }
}

test('录音分片中断后续传：已确认分片不重传，收齐才算完整', () => {
  const state = createServerState()
  const hash = 'audio-hash-1'
  // 先传第 0、1 片
  assert.deepEqual(recordChunk(state, hash, 0, 3, 10, 'audio/webm', fakeChunk(10), sizeOf), { receivedChunks: 1, complete: false })
  assert.deepEqual(recordChunk(state, hash, 1, 3, 10, 'audio/webm', fakeChunk(10), sizeOf), { receivedChunks: 2, complete: false })
  // 断网恢复后第 0 片重发（幂等），再发第 2 片
  assert.deepEqual(recordChunk(state, hash, 0, 3, 10, 'audio/webm', fakeChunk(10), sizeOf), { receivedChunks: 2, complete: false })
  assert.deepEqual(recordChunk(state, hash, 2, 3, 10, 'audio/webm', fakeChunk(10), sizeOf), { receivedChunks: 3, complete: true })
  assert.equal(state.audio[hash].size, 30)
})

test('同一录音重复提交：hash 相同只算已存在，练习包仍幂等 upsert', () => {
  const state = createServerState()
  const groups = [{ id: 'g1', text: '一段', stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat', note: '', updatedAt: iso(-1) }]
  const order = { id: 'o1', groupIds: ['g1'], source: 'student', createdAt: iso(-2), label: 'v1' }
  const hash = 'same-audio'
  for (let i = 0; i < 3; i += 1) recordChunk(state, hash, i, 3, 10, 'audio/webm', fakeChunk(10), sizeOf)
  const payload = makePracticeBundle({ attemptId: 'a1', groups, orderVersion: order, audioHash: hash })
  const first = applyBundle(state, payload, 'p1')
  assert.equal(first.alreadyHasAudio, true) // 录音已收齐
  // 重复提交同一个练习包：不产生第二条 attempt、不产生第二份录音
  const second = applyBundle(state, structuredClone(payload), 'p1')
  assert.equal(second.alreadyHasAudio, true)
  assert.equal(state.projects[0].attempts.length, 1)
  assert.equal(Object.keys(state.audio).length, 1)
})

test('错词排队上传：逐条包到达后按 id 合并到同一轮', () => {
  const state = createServerState()
  const groups = [{ id: 'g1', text: '一段', stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat', note: '', updatedAt: iso(-1) }]
  const order = { id: 'o1', groupIds: ['g1'], source: 'student', createdAt: iso(-2), label: 'v1' }
  applyBundle(state, makePracticeBundle({ attemptId: 'a1', groups, orderVersion: order }), 'p1')
  applyBundle(state, { kind: 'wordIssue', attemptId: 'a1', issue: { id: 'w1', groupId: 'g1', word: '掠过', category: '声调', note: '' } }, 'p1')
  applyBundle(state, { kind: 'wordIssue', attemptId: 'a1', issue: { id: 'w2', groupId: 'g1', word: '信', category: '韵尾', note: '' } }, 'p1')
  // 同 id 再传一次（重发）不应重复
  applyBundle(state, { kind: 'wordIssue', attemptId: 'a1', issue: { id: 'w1', groupId: 'g1', word: '掠过', category: '声调', note: '更新' } }, 'p1')
  const attempt = state.projects[0].attempts[0]
  assert.equal(attempt.wordIssues.length, 2)
  assert.equal(attempt.wordIssues.find((w) => w.id === 'w1')?.note, '更新')
})

test('学生改了意群顺序、教师按旧顺序留反馈：两版都保留，反馈锚定原意群', () => {
  const state = createServerState()
  const groups = [1, 2, 3].map((n) => ({ id: `g${n}`, text: `段${n}`, stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat' as const, note: '', updatedAt: iso(-5) }))
  const orderV1 = { id: 'o1', groupIds: ['g1', 'g2', 'g3'], source: 'student' as const, createdAt: iso(-9), label: 'v1' }
  const orderV2 = { id: 'o2', groupIds: ['g3', 'g1', 'g2'], source: 'student' as const, createdAt: iso(-1), label: 'v2-学生重排' }

  // 学生先按 v1 交了第 1 轮
  applyBundle(state, makePracticeBundle({ attemptId: 'a1', groups, orderVersion: orderV1 }), 'p1')
  // 学生改顺序（order 包）
  applyBundle(state, { kind: 'order', orderVersion: orderV2, groups, removedGroupIds: [] }, 'p1')
  // 教师在学校电脑上仍看着 v1，对 g2 留反馈（feedback 包）
  const feedback = { id: 'f1', groupId: 'g2', teacher: '陈老师', text: 'g2 要再轻', createdAt: iso(0) }
  applyBundle(state, { kind: 'feedback', attemptId: 'a1', feedback }, 'p1')

  const project = state.projects[0]
  assert.deepEqual(project.orderVersions.map((v) => v.id), ['o1', 'o2'])
  const attempt = project.attempts[0]
  // 反馈仍锚定 g2（不是位置 2，也没因顺序变化丢失）
  assert.equal(attempt.feedback.find((f) => f.id === 'f1')?.groupId, 'g2')
  assert.equal(project.pendingFeedback.length, 0)
})

test('反馈锚定的意群被所有顺序版本移除时进入待处理区，重新锚定后回归', () => {
  const state = createServerState()
  const groups = [1, 2].map((n) => ({ id: `g${n}`, text: `段${n}`, stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat' as const, note: '', updatedAt: iso(-5) }))
  const v1 = { id: 'o1', groupIds: ['g1', 'g2'], source: 'student' as const, createdAt: iso(-9), label: 'v1' }
  applyBundle(state, makePracticeBundle({
    attemptId: 'a1',
    groups,
    orderVersion: v1,
    feedback: [{ id: 'f1', groupId: 'g2', teacher: '陈老师', text: '旧反馈', createdAt: iso(-4) }]
  }), 'p1')
  // g2 在任何版本中都不再出现（这里直接交一个只含 g1 的新版本，且 g2 实体也被删掉）
  const v2 = { id: 'o2', groupIds: ['g1'], source: 'student' as const, createdAt: iso(-2), label: 'v2' }
  applyBundle(state, { kind: 'order', orderVersion: v2, groups: groups.filter((g) => g.id === 'g1'), removedGroupIds: ['g2'] }, 'p1')
  const project = state.projects[0]
  assert.equal(project.attempts[0].feedback.length, 0)
  assert.equal(project.pendingFeedback[0]?.feedback.id, 'f1')
  // 教师把反馈重新锚定到 g1
  applyBundle(state, { kind: 'feedback', attemptId: 'a1', feedback: { id: 'f1', groupId: 'g1', teacher: '陈老师', text: '旧反馈', createdAt: iso(-4) } }, 'p1')
  assert.equal(project.pendingFeedback.length, 0)
  assert.equal(project.attempts[0].feedback.find((f) => f.id === 'f1')?.groupId, 'g1')
})

test('教师撤回反馈：墓碑写入后，旧内容的重传副本不能复活它', () => {
  const state = createServerState()
  const groups = [{ id: 'g1', text: '段', stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat' as const, note: '', updatedAt: iso(-5) }]
  const order = { id: 'o1', groupIds: ['g1'], source: 'student', createdAt: iso(-9), label: 'v1' }
  applyBundle(state, makePracticeBundle({
    attemptId: 'a1',
    groups,
    orderVersion: order,
    feedback: [{ id: 'f1', groupId: 'g1', teacher: '陈老师', text: '原始反馈', createdAt: iso(-4) }]
  }), 'p1')
  assert.equal(state.projects[0].attempts[0].feedback.length, 1)

  // 教师撤回（独立墓碑包）
  applyBundle(state, { kind: 'feedback', attemptId: 'a1', feedback: { id: 'f1', groupId: 'g1', teacher: '陈老师', text: '', createdAt: iso(-4), deletedAt: iso(0) } }, 'p1')
  const afterWithdraw = state.projects[0].attempts[0].feedback
  assert.equal(afterWithdraw.length, 1)
  assert.ok(afterWithdraw[0].deletedAt, '墓碑必须保留在服务端，供其他设备同步删除')

  // 一个还没同步撤回的旧设备，重传了带原始内容的练习包
  applyBundle(state, makePracticeBundle({
    attemptId: 'a1',
    groups,
    orderVersion: order,
    feedback: [{ id: 'f1', groupId: 'g1', teacher: '陈老师', text: '原始反馈', createdAt: iso(-4) }],
    revisedAt: iso(-3)
  }), 'p1')
  const resurrected = state.projects[0].attempts[0].feedback.find((f) => f.id === 'f1')
  assert.ok(resurrected?.deletedAt, '旧内容重传不能让已撤回反馈复活')
})

test('教师改写反馈：旧 id 立墓碑 + 新 id 内容，二者都稳定', () => {
  const state = createServerState()
  const groups = [{ id: 'g1', text: '段', stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat' as const, note: '', updatedAt: iso(-5) }]
  const order = { id: 'o1', groupIds: ['g1'], source: 'student', createdAt: iso(-9), label: 'v1' }
  applyBundle(state, makePracticeBundle({
    attemptId: 'a1', groups, orderVersion: order,
    feedback: [{ id: 'old', groupId: 'g1', teacher: '陈老师', text: '原话', createdAt: iso(-5) }]
  }), 'p1')
  applyBundle(state, { kind: 'feedback', attemptId: 'a1', feedback: { id: 'old', groupId: 'g1', teacher: '陈老师', text: '', createdAt: iso(-5), deletedAt: iso(-1) } }, 'p1')
  applyBundle(state, { kind: 'feedback', attemptId: 'a1', feedback: { id: 'new', groupId: 'g1', teacher: '陈老师', text: '改写后', createdAt: iso(-1) } }, 'p1')
  const all = state.projects[0].attempts[0].feedback
  assert.ok(all.find((f) => f.id === 'old')?.deletedAt)
  assert.equal(all.find((f) => f.id === 'new')?.text, '改写后')
})

test('轮次元数据按 revisedAt 双向合并，较新的标注覆盖较旧的', () => {
  const state = createServerState()
  const groups = [{ id: 'g1', text: '段', stressWords: [], stressLevel: 1, pauseMs: 0, intonation: 'flat' as const, note: '', updatedAt: iso(-5) }]
  const order = { id: 'o1', groupIds: ['g1'], source: 'student', createdAt: iso(-9), label: 'v1' }
  const base = (rangeEnd: number, revisedAt: string) => makePracticeBundle({ attemptId: 'a1', groups, orderVersion: order, revisedAt, rangeEnd })
  // 旧 bundle 的 rangeEnd=5
  applyBundle(state, { ...base(5, iso(-3)) }, 'p1')
  // 新 bundle 的 rangeEnd=4.2
  applyBundle(state, { ...base(4.2, iso(-1)) }, 'p1')
  assert.equal(state.projects[0].attempts[0].rangeEnd, 4.2)
  // 更旧的包迟到，不应回退
  applyBundle(state, { ...base(3.9, iso(-2)) }, 'p1')
  assert.equal(state.projects[0].attempts[0].rangeEnd, 4.2)
})
