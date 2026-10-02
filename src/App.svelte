<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ProgressBar } from '@skeletonlabs/skeleton'
  import { createSampleProject } from './sample'
  import {
    clearAllLocal,
    getDevice,
    getAudio,
    listBundles,
    loadPractice,
    putAudio,
    saveDevice,
    savePractice
  } from './storage'
  import {
    enqueueFeedbackBundle,
    enqueueOrderBundle,
    enqueuePracticeBundle,
    enqueueWordIssueBundle,
    stampAudioHash,
    syncOnce,
    type SyncProgress
  } from './sync'
  import { mockNetwork, resetMockServer } from './mock-server'
  import type {
    Attempt,
    DeviceIdentity,
    Intonation,
    OrderVersion,
    OutboxBundle,
    PendingFeedbackItem,
    PracticeProject,
    SenseGroup,
    StressLevel
  } from './types'

  const intonationOptions: Array<{ value: Intonation; label: string }> = [
    { value: 'fall', label: '下降 ↘' },
    { value: 'rise', label: '上升 ↗' },
    { value: 'flat', label: '平稳 →' },
    { value: 'rise-fall', label: '先升后降 ↗↘' },
    { value: 'fall-rise', label: '先降后升 ↘↗' }
  ]
  const CHUNK_PERCENT = (bundle: OutboxBundle) => {
    if (bundle.payload.kind !== 'practice' || !bundle.payload.audio) return bundle.status === 'synced' ? 100 : 0
    return Math.round((bundle.ackedChunk / bundle.payload.audio.totalChunks) * 100)
  }

  let project: PracticeProject = createSampleProject()
  let loaded = false
  let saveStatus = '正在读取本机练习…'
  let online = true
  let simulatedOffline = false
  let device: DeviceIdentity | null = null
  let role: 'student' | 'teacher' = 'student'
  let deviceNameInput = ''
  let selectedGroupId = project.groups[0]?.id ?? ''
  let selectedAttemptId = project.attempts.at(-1)?.id ?? ''
  let workspaceTab: 'annotate' | 'review' | 'sync' = 'annotate'
  let recording = false
  let recordingSeconds = 0
  let recordingFallback = false
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let mediaChunks: Blob[] = []
  let recordingTimer: number | undefined
  let saveTimer: number | undefined
  let playbackTimer: number | undefined
  let audioElement: HTMLAudioElement | undefined
  let playing = false
  let playbackTime = 0
  let audioUrls = new Map<string, string>()
  let issueWord = ''
  let issueCategory = '声调'
  let issueNote = ''
  let feedbackText = ''
  let newCategory = ''
  let undoStack: PracticeProject[] = []
  let redoStack: PracticeProject[] = []
  let selectedGroup: SenseGroup | undefined
  let selectedAttempt: Attempt | undefined
  let queue: OutboxBundle[] = []
  let syncing = false
  let syncProgress: SyncProgress = { phase: 'idle', message: '', percent: 0 }
  let viewOrderVersionId = ''
  let lastSyncAt = ''
  let pendingAnchorChoice: PendingFeedbackItem | null = null

  // 当前生效顺序（学生端可切换查看历史版本；反馈始终锚定它自己的版本）。
  $: activeVersion = project.orderVersions.find((version) => version.id === project.activeOrderVersionId) ?? project.orderVersions.at(-1)
  $: viewVersion = project.orderVersions.find((version) => version.id === viewOrderVersionId) ?? activeVersion
  $: visibleGroups = (viewVersion ? viewVersion.groupIds : project.groups.map((g) => g.id))
    .map((id) => project.groups.find((group) => group.id === id))
    .filter((group): group is SenseGroup => Boolean(group))
  $: selectedGroup = visibleGroups.find((group) => group.id === selectedGroupId) ?? visibleGroups[0]
  $: selectedAttempt = project.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? project.attempts.at(-1)
  $: selectedScore = selectedAttempt && selectedGroup ? selectedAttempt.scores.find((score) => score.groupId === selectedGroup?.id) : undefined
  $: completedAttempts = Math.min(project.attempts.length, project.targetAttempts)
  $: progress = Math.round((completedAttempts / Math.max(project.targetAttempts, 1)) * 100)
  $: averageAccuracy = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / selectedAttempt.scores.length) : 0
  $: averageDeviation = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.deviation, 0) / selectedAttempt.scores.length) : 0
  $: totalIssueCategories = project.errorCategories.map((category) => ({ category, count: project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length }))
  $: queuedCount = queue.filter((bundle) => bundle.status !== 'synced').length
  $: pendingCount = project.pendingFeedback.length

  const clone = <T,>(value: T): T => structuredClone(value)
  const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  function editProject(mutator: (draft: PracticeProject) => void) {
    const before = clone(project)
    const draft = clone(project)
    mutator(draft)
    draft.updatedAt = new Date().toISOString()
    project = draft
    undoStack = [...undoStack.slice(-59), before]
    redoStack = []
    scheduleSave()
  }

  function scheduleSave() {
    saveStatus = online && !simulatedOffline ? '正在保存…' : '离线编辑中，练习包保留在本机'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      await savePractice(project)
      await refreshQueue()
      saveStatus = online && !simulatedOffline ? '已保存到本机' : '已离线保存，等待联网提交'
    }, 250)
  }

  function undo() {
    const target = undoStack.pop()
    if (!target) return
    redoStack = [...redoStack, clone(project)]
    project = target
    scheduleSave()
  }

  function redo() {
    const target = redoStack.pop()
    if (!target) return
    undoStack = [...undoStack, clone(project)]
    project = target
    scheduleSave()
  }

  function selectGroup(groupId: string) {
    selectedGroupId = groupId
    stopPlayback()
  }

  function updateGroup(field: keyof SenseGroup, value: string | number | string[]) {
    editProject((draft) => {
      const group = draft.groups.find((item) => item.id === selectedGroupId)
      if (!group) return
      ;(group as unknown as Record<string, unknown>)[field] = value
      group.updatedAt = new Date().toISOString()
    })
  }

  function setStressLevel(level: number) {
    updateGroup('stressLevel', level as StressLevel)
  }

  function setIntonation(value: string) {
    updateGroup('intonation', value as Intonation)
  }

  function toggleStressWord(word: string) {
    if (!selectedGroup) return
    const words = selectedGroup.stressWords.includes(word) ? selectedGroup.stressWords.filter((item) => item !== word) : [...selectedGroup.stressWords, word]
    updateGroup('stressWords', words)
  }

  function addGroup() {
    const id = uid('group')
    editProject((draft) => {
      draft.groups.push({ id, text: '新的意群', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '', updatedAt: new Date().toISOString() })
      const version = draft.orderVersions.find((item) => item.id === draft.activeOrderVersionId)
      const nextIds = [...(version?.groupIds ?? draft.groups.map((group) => group.id).filter((existing) => existing !== id)), id]
      const orderVersion: OrderVersion = { id: uid('order'), groupIds: nextIds, source: role, createdAt: new Date().toISOString(), label: `新增意群 ${draft.groups.length}` }
      draft.orderVersions.push(orderVersion)
      draft.activeOrderVersionId = orderVersion.id
    })
    selectedGroupId = id
    viewOrderVersionId = project.activeOrderVersionId
    void enqueueCurrentOrder()
  }

  function deleteGroup() {
    if (!selectedGroup || visibleGroups.length <= 1) return
    const removedId = selectedGroup.id
    const index = visibleGroups.findIndex((group) => group.id === removedId)
    let removedGroupIds: string[] = []
    editProject((draft) => {
      const version = draft.orderVersions.find((item) => item.id === draft.activeOrderVersionId)!
      const nextIds = version.groupIds.filter((id) => id !== removedId)
      const orderVersion: OrderVersion = { id: uid('order'), groupIds: nextIds, source: role, createdAt: new Date().toISOString(), label: '删除意群后的顺序' }
      draft.orderVersions.push(orderVersion)
      draft.activeOrderVersionId = orderVersion.id
      // 顺序版本全部保留；仅当没有任何版本再引用该意群时才真正删除实体，
      // 删除后挂在它上面的反馈在服务端进入待处理区，而不是随重排丢失。
      const stillReferenced = draft.orderVersions.some((item) => item.groupIds.includes(removedId))
      if (!stillReferenced) {
        draft.groups = draft.groups.filter((group) => group.id !== removedId)
        removedGroupIds = [removedId]
      }
    })
    selectedGroupId = visibleGroups[Math.max(0, index - 1)]?.id ?? ''
    viewOrderVersionId = project.activeOrderVersionId
    void enqueueCurrentOrder(removedGroupIds)
  }

  function moveGroup(direction: -1 | 1) {
    if (!selectedGroup) return
    const ids = visibleGroups.map((group) => group.id)
    const index = ids.findIndex((id) => id === selectedGroup.id)
    const next = index + direction
    if (next < 0 || next >= ids.length) return
    ;[ids[index], ids[next]] = [ids[next], ids[index]]
    commitNewOrder(ids)
  }

  function commitNewOrder(groupIds: string[]) {
    editProject((draft) => {
      const orderVersion: OrderVersion = {
        id: uid('order'),
        groupIds,
        source: role,
        createdAt: new Date().toISOString(),
        label: role === 'student' ? `学生调整的第 ${draft.orderVersions.length + 1} 版顺序` : `教师调整的第 ${draft.orderVersions.length + 1} 版顺序`
      }
      draft.orderVersions.push(orderVersion)
      draft.activeOrderVersionId = orderVersion.id
    })
    viewOrderVersionId = project.activeOrderVersionId
    void enqueueCurrentOrder()
  }

  async function enqueueCurrentOrder(removedGroupIds: string[] = []) {
    if (!device) return
    await Promise.resolve()
    const version = project.orderVersions.find((item) => item.id === project.activeOrderVersionId)
    if (version) {
      await enqueueOrderBundle(project, version, { deviceId: device.deviceId, projectId: project.id }, removedGroupIds)
      await refreshQueue()
    }
  }

  function splitSentence() {
    const parts = project.sentence.split(/[，。！？；、\n]+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return
    editProject((draft) => {
      const reused = draft.groups
      draft.groups = parts.map((text, index) => ({
        id: reused[index]?.id ?? uid('group'),
        text,
        stressWords: reused[index]?.stressWords ?? [],
        stressLevel: reused[index]?.stressLevel ?? 1,
        pauseMs: reused[index]?.pauseMs ?? 300,
        intonation: reused[index]?.intonation ?? 'flat',
        note: reused[index]?.note ?? '',
        updatedAt: new Date().toISOString()
      }))
      const orderVersion: OrderVersion = { id: uid('order'), groupIds: draft.groups.map((group) => group.id), source: role, createdAt: new Date().toISOString(), label: '按标点重新切分' }
      draft.orderVersions.push(orderVersion)
      draft.activeOrderVersionId = orderVersion.id
    })
    selectedGroupId = visibleGroups[0]?.id ?? ''
    viewOrderVersionId = project.activeOrderVersionId
    void enqueueCurrentOrder()
  }

  function updateSentence(value: string) {
    editProject((draft) => { draft.sentence = value })
  }

  async function startRecording() {
    if (recording) return
    recordingFallback = false
    mediaChunks = []
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('unsupported')
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder = new MediaRecorder(mediaStream)
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) mediaChunks.push(event.data) }
      mediaRecorder.onstop = () => void finishRecording(recordingFallback)
      mediaRecorder.start()
    } catch {
      recordingFallback = true
      mediaRecorder = null
    }
    recording = true
    recordingSeconds = 0
    window.clearInterval(recordingTimer)
    recordingTimer = window.setInterval(() => { recordingSeconds += 0.1 }, 100)
  }

  function stopRecording() {
    if (!recording) return
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    else void finishRecording(true)
  }

  async function finishRecording(simulated: boolean) {
    if (!recording) return
    recording = false
    window.clearInterval(recordingTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    const blob = !simulated && mediaChunks.length ? new Blob(mediaChunks, { type: mediaChunks[0].type || 'audio/webm' }) : undefined
    const attemptId = uid('attempt')
    const number = project.attempts.length + 1
    const duration = Number(Math.max(0.5, recordingSeconds).toFixed(1))
    let attempt: Attempt = {
      id: attemptId,
      number,
      label: simulated ? `第 ${number} 轮 · 离线模拟` : `第 ${number} 轮`,
      createdAt: new Date().toISOString(),
      revisedAt: new Date().toISOString(),
      duration,
      audioMime: blob?.type ?? 'audio/webm',
      simulated,
      rangeStart: 0,
      rangeEnd: duration,
      orderVersionId: activeVersion?.id,
      scores: visibleGroups.map((group) => ({ groupId: group.id, accuracy: 70, rhythm: 70, deviation: 0, note: '' })),
      wordIssues: [],
      feedback: [],
      selfNote: ''
    }
    if (blob) {
      attempt = await stampAudioHash(attempt, blob)
      await putAudio(attempt.audioHash!, blob)
      audioUrls.set(attemptId, URL.createObjectURL(blob))
    }
    editProject((draft) => { draft.attempts.push(attempt) })
    selectedAttemptId = attemptId
    workspaceTab = 'review'
    recordingSeconds = duration
    // 录完即打包：录音、意群顺序、元数据进入离线 outbox，断网也不丢。
    if (device) {
      await enqueuePracticeBundle(project, attempt, { deviceId: device.deviceId, projectId: project.id })
      await refreshQueue()
    }
  }

  function audioUrlFor(attempt?: Attempt) {
    if (!attempt?.audioBlob) return ''
    if (!audioUrls.has(attempt.id)) audioUrls.set(attempt.id, URL.createObjectURL(attempt.audioBlob))
    return audioUrls.get(attempt.id) ?? ''
  }

  function togglePlayback() {
    if (!selectedAttempt) return
    if (playing) {
      stopPlayback()
      return
    }
    playing = true
    playbackTime = selectedAttempt.rangeStart
    const url = audioUrlFor(selectedAttempt)
    if (url && audioElement) {
      audioElement.src = url
      audioElement.currentTime = selectedAttempt.rangeStart
      audioElement.play().catch(() => startPlaybackTimer())
    } else {
      startPlaybackTimer()
    }
  }

  function startPlaybackTimer() {
    window.clearInterval(playbackTimer)
    playbackTimer = window.setInterval(() => {
      playbackTime = Number((playbackTime + 0.1).toFixed(1))
      if (playbackTime >= (selectedAttempt?.rangeEnd ?? 0)) stopPlayback()
    }, 100)
  }

  function stopPlayback() {
    playing = false
    window.clearInterval(playbackTimer)
    audioElement?.pause()
  }

  function onAudioTimeUpdate() {
    if (!audioElement || !selectedAttempt) return
    playbackTime = audioElement.currentTime
    if (playbackTime >= selectedAttempt.rangeEnd) stopPlayback()
  }

  function touchAttemptRevision(draft: PracticeProject, attemptId: string) {
    const attempt = draft.attempts.find((item) => item.id === attemptId)
    if (attempt) attempt.revisedAt = new Date().toISOString()
  }

  function updateScore(field: 'accuracy' | 'rhythm' | 'deviation', value: number) {
    if (!selectedAttempt || !selectedGroup) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      let score = attempt?.scores.find((item) => item.groupId === selectedGroupId)
      if (!attempt || !score) {
        attempt?.scores.push({ groupId: selectedGroupId, accuracy: 70, rhythm: 70, deviation: 0, note: '' })
        score = attempt?.scores.at(-1)
      }
      if (score) score[field] = value
      touchAttemptRevision(draft, selectedAttemptId)
    })
  }

  function updateScoreNote(value: string) {
    if (!selectedAttempt || !selectedGroup) return
    editProject((draft) => {
      const score = draft.attempts.find((attempt) => attempt.id === selectedAttemptId)?.scores.find((item) => item.groupId === selectedGroupId)
      if (score) score.note = value
      touchAttemptRevision(draft, selectedAttemptId)
    })
  }

  async function addWordIssue() {
    if (!selectedAttempt || !selectedGroup || !issueWord.trim()) return
    const issue = { id: uid('issue'), groupId: selectedGroupId, word: issueWord.trim(), category: issueCategory, note: issueNote.trim() }
    editProject((draft) => {
      draft.attempts.find((item) => item.id === selectedAttemptId)?.wordIssues.push(issue)
    })
    issueWord = ''
    issueNote = ''
    // 错词排队上传：单独成包，不依赖整轮重交。
    if (device) {
      await enqueueWordIssueBundle(issue, selectedAttempt.id, { deviceId: device.deviceId, projectId: project.id })
      await refreshQueue()
    }
  }

  function removeWordIssue(issueId: string) {
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.wordIssues = attempt.wordIssues.filter((issue) => issue.id !== issueId)
    })
  }

  async function addFeedback() {
    if (!selectedGroup || !feedbackText.trim() || !selectedAttempt) return
    const feedback = {
      id: uid('feedback'),
      groupId: selectedGroupId,
      teacher: role === 'teacher' ? project.teacher : `学生（${device?.name ?? '本机'}）`,
      text: feedbackText.trim(),
      createdAt: new Date().toISOString()
    }
    editProject((draft) => {
      draft.attempts.find((item) => item.id === selectedAttemptId)?.feedback.push(feedback)
    })
    feedbackText = ''
    if (device) {
      await enqueueFeedbackBundle(feedback, selectedAttempt.id, { deviceId: device.deviceId, projectId: project.id })
      await refreshQueue()
    }
  }

  /** 撤回反馈：写 deletedAt 墓碑并单独打包，所有后续同步副本都不能再出现它。 */
  async function withdrawFeedback(feedbackId: string) {
    if (!selectedAttempt || !confirm('撤回这条反馈后，其他设备同步后也会删除，确定吗？')) return
    const original = selectedAttempt.feedback.find((item) => item.id === feedbackId)
    if (!original) return
    const tombstone = { ...original, text: '', deletedAt: new Date().toISOString() }
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.feedback = attempt.feedback.filter((item) => item.id !== feedbackId)
      draft.pendingFeedback = draft.pendingFeedback.filter((item) => item.feedback.id !== feedbackId)
    })
    if (device) {
      await enqueueFeedbackBundle(tombstone, selectedAttempt.id, { deviceId: device.deviceId, projectId: project.id })
      await refreshQueue()
    }
  }

  /** 改写反馈：旧内容以墓碑撤回，新内容作为新条目同步（历史可审计）。 */
  async function rewriteFeedback(feedbackId: string) {
    if (!selectedAttempt) return
    const original = selectedAttempt.feedback.find((item) => item.id === feedbackId)
    if (!original) return
    const text = prompt('改写后的反馈内容：', original.text)
    if (text === null || !text.trim()) return
    const tombstone = { ...original, text: '', deletedAt: new Date().toISOString() }
    const replacement = { ...original, id: uid('feedback'), text: text.trim(), createdAt: new Date().toISOString() }
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt.feedback = attempt.feedback.filter((item) => item.id !== feedbackId)
      attempt.feedback.push(replacement)
    })
    if (device) {
      await enqueueFeedbackBundle(tombstone, selectedAttempt.id, { deviceId: device.deviceId, projectId: project.id })
      await enqueueFeedbackBundle(replacement, selectedAttempt.id, { deviceId: device.deviceId, projectId: project.id })
      await refreshQueue()
    }
  }

  /** 把待处理反馈重新锚定到当前意群（学生恢复意群或教师改指新段时使用）。 */
  async function reanchorPending(item: PendingFeedbackItem, groupId: string) {    const moved = { ...item.feedback, groupId }
    editProject((draft) => {
      const attempt = draft.attempts.find((entry) => entry.id === item.attemptId)
      if (attempt && !attempt.feedback.some((feedback) => feedback.id === moved.id)) attempt.feedback.push(moved)
      draft.pendingFeedback = draft.pendingFeedback.filter((pending) => pending.feedback.id !== item.feedback.id)
    })
    if (device) {
      await enqueueFeedbackBundle(moved, item.attemptId, { deviceId: device.deviceId, projectId: project.id })
      await refreshQueue()
    }
    pendingAnchorChoice = null
  }

  async function reanchorPendingChoice(groupId: string) {
    if (!pendingAnchorChoice) return
    await reanchorPending(pendingAnchorChoice, groupId)
  }

  function updateRange(field: 'rangeStart' | 'rangeEnd', value: number) {
    if (!selectedAttempt) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt[field] = value
      if (attempt.rangeEnd <= attempt.rangeStart) {
        if (field === 'rangeStart') attempt.rangeEnd = Math.min(attempt.duration, value + 0.5)
        else attempt.rangeStart = Math.max(0, value - 0.5)
      }
      touchAttemptRevision(draft, selectedAttemptId)
    })
  }

  function addCategory() {
    if (!newCategory.trim() || project.errorCategories.includes(newCategory.trim())) return
    editProject((draft) => { draft.errorCategories.push(newCategory.trim()) })
    newCategory = ''
  }

  /** 学生把当前轮次的最新标注重新打成练习包提交（内容哈希相同的录音不会重复上传）。 */
  async function resubmitAttempt() {
    if (!selectedAttempt || !device) return
    let attempt = selectedAttempt
    if (attempt.audioBlob && !attempt.audioHash) {
      attempt = await stampAudioHash(attempt, attempt.audioBlob)
    }
    await enqueuePracticeBundle(project, attempt, { deviceId: device.deviceId, projectId: project.id })
    editProject((draft) => {
      const target = draft.attempts.find((item) => item.id === attempt.id)
      if (target) target.bundleId = 'queued'
    })
    await refreshQueue()
    syncProgress = { phase: 'idle', message: '已加入提交队列。', percent: 0 }
  }

  async function refreshQueue() {
    queue = await listBundles()
  }

  async function runSync() {
    if (syncing || !device) return
    syncing = true
    try {
      const result = await syncOnce(project, async (next) => {
        project = next
        await savePractice(next)
      }, (progress) => {
        syncProgress = progress
      })
      void result
      lastSyncAt = new Date().toISOString()
      await refreshQueue()
      // 下载完成后给远程录音补 object URL。
      for (const attempt of project.attempts) {
        if (!attempt.audioBlob && attempt.audioHash) {
          const blob = await getAudio(attempt.audioHash)
          if (blob) {
            attempt.audioBlob = blob
            if (!audioUrls.has(attempt.id)) audioUrls.set(attempt.id, URL.createObjectURL(blob))
          }
        }
      }
      project = clone(project)
    } catch {
      // 错误信息已写入 syncProgress。
    } finally {
      syncing = false
    }
  }

  function toggleSimulatedOffline() {
    simulatedOffline = !simulatedOffline
    mockNetwork.setOffline(simulatedOffline)
    online = navigator.onLine && !simulatedOffline
  }

  async function identifyDevice() {
    const name = deviceNameInput.trim() || (role === 'teacher' ? '学校电脑' : '学生设备')
    device = { deviceId: uid('device'), name: `${name} · ${role === 'teacher' ? '教师端' : '学生端'}`, createdAt: new Date().toISOString() }
    await saveDevice(device)
    await runSync()
  }

  function resetSample() {
    if (!confirm('恢复示例会替换当前练习，确定继续吗？')) return
    editProject((draft) => { Object.assign(draft, clone(createSampleProject())) })
    selectedGroupId = visibleGroups[0]?.id ?? ''
    selectedAttemptId = project.attempts.at(-1)?.id ?? ''
    viewOrderVersionId = project.activeOrderVersionId
  }

  async function deleteAllData() {
    if (!confirm('这会清除本机全部练习、录音与待提交练习包（模拟云端不受影响），且不能撤销。')) return
    stopPlayback()
    await clearAllLocal()
    const sample = createSampleProject()
    project = sample
    selectedGroupId = sample.groups[0]?.id ?? ''
    selectedAttemptId = sample.attempts.at(-1)?.id ?? ''
    viewOrderVersionId = sample.activeOrderVersionId
    undoStack = []
    redoStack = []
    queue = []
    await savePractice(project)
  }

  async function clearCloud() {
    if (!confirm('清空模拟云端的全部项目与录音？本机数据保留。')) return
    await resetMockServer()
    await refreshQueue()
    syncProgress = { phase: 'idle', message: '模拟云端已清空。', percent: 0 }
  }

  function onKeydown(event: KeyboardEvent) {
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void savePractice(project).then(() => { saveStatus = '已保存到本机' })
    } else if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    } else if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
    } else if (event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      recording ? stopRecording() : void startRecording()
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveGroup(event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      const index = visibleGroups.findIndex((group) => group.id === selectedGroupId)
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (visibleGroups[next]) selectedGroupId = visibleGroups[next].id
    }
  }

  let syncRetryTimer: number | undefined

  onMount(async () => {
    online = navigator.onLine
    device = await getDevice()
    const saved = await loadPractice()
    if (saved) project = saved
    selectedGroupId = visibleGroups[0]?.id ?? ''
    selectedAttemptId = project.attempts.at(-1)?.id ?? ''
    viewOrderVersionId = project.activeOrderVersionId
    if (device) deviceNameInput = device.name
    await refreshQueue()
    loaded = true
    saveStatus = saved ? '已恢复本机练习' : '示例练习已就绪'
    const goOnline = () => {
      online = navigator.onLine && !simulatedOffline
      if (online && device && !syncing) void runSync()
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', () => { online = false })
    window.addEventListener('keydown', onKeydown)
    // 联网期间每 20 秒自动同步一次；断线时 outbox 已持久化，什么都不做。
    syncRetryTimer = window.setInterval(() => {
      if (navigator.onLine && !simulatedOffline && device && !syncing) void runSync()
    }, 20000)
    if (device && navigator.onLine) void runSync()
  })

  onDestroy(() => {
    window.clearTimeout(saveTimer)
    window.clearInterval(recordingTimer)
    window.clearInterval(playbackTimer)
    window.clearInterval(syncRetryTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    audioUrls.forEach((url) => URL.revokeObjectURL(url))
    window.removeEventListener('keydown', onKeydown)
  })
</script>

<svelte:head>
  <title>{project.title} · 声律场</title>
</svelte:head>

<div class="app-shell min-h-screen">
  <header class="top-header">
    <div class="brand-block">
      <div class="brand-mark">律</div>
      <div>
        <strong>声律场</strong>
        <span>PROSODY PRACTICE</span>
      </div>
    </div>
    <div class="practice-title">
      <h1>{project.title}</h1>
      <span>{project.teacher} · {device ? device.name : '未登记设备'} · 手机与电脑自动适配</span>
    </div>
    <div class="header-actions">
      <span class:offline={!online} class="connection badge">{online ? '在线' : '离线排队'}</span>
      <span class="badge">{role === 'teacher' ? '教师端' : '学生端'}</span>
      {#if queuedCount > 0}<span class="badge variant-filled-warning">待提交 {queuedCount}</span>{/if}
      {#if pendingCount > 0}<span class="badge variant-filled-secondary">待处理 {pendingCount}</span>{/if}
      <span class="save-state">{saveStatus}</span>
      <button class="btn btn-sm variant-ghost" on:click={undo} disabled={!undoStack.length}>撤销</button>
      <button class="btn btn-sm variant-ghost" on:click={redo} disabled={!redoStack.length}>重做</button>
    </div>
  </header>

  <section class="progress-strip">
    <div class="progress-copy">
      <span>练习进度</span>
      <strong>{completedAttempts} / {project.targetAttempts} 轮</strong>
    </div>
    <ProgressBar value={progress} />
    <div class="progress-metric"><span>当前准确度</span><strong>{averageAccuracy}%</strong></div>
    <div class="progress-metric"><span>平均偏差</span><strong>{averageDeviation}%</strong></div>
    <div class="progress-metric"><span>目标时长</span><strong>{project.targetDuration.toFixed(1)}s</strong></div>
  </section>

  {#if !device}
    <section class="card device-card">
      <div class="section-heading">
        <div><span class="eyebrow">DEVICE</span><h2>登记这台设备</h2></div>
      </div>
      <p>学生在家用手机/电脑练习，教师在学校电脑留反馈；两端都通过练习包离线提交、联网后自动合并。先告诉系统这台设备是谁。</p>
      <div class="device-form">
        <label class="label"><span>设备名称（可选）</span><input class="input" bind:value={deviceNameInput} placeholder="例如：家里的平板 / 讲台电脑" /></label>
        <div class="role-switch">
          <button class:active={role === 'student'} class="btn variant-filled-primary" on:click={() => (role = 'student')}>我是学生（在家练习）</button>
          <button class:active={role === 'teacher'} class="btn variant-filled-tertiary" on:click={() => (role = 'teacher')}>我是教师（学校电脑）</button>
        </div>
        <button class="btn variant-filled-primary" on:click={identifyDevice}>登记并开始同步</button>
      </div>
    </section>
  {/if}

  <div class="mobile-tabs">
    <button class:active={workspaceTab === 'annotate'} on:click={() => (workspaceTab = 'annotate')}>标注</button>
    <button class:active={workspaceTab === 'review'} on:click={() => (workspaceTab = 'review')}>录音校对</button>
    <button class:active={workspaceTab === 'sync'} on:click={() => (workspaceTab = 'sync')}>同步 {queuedCount > 0 ? `(${queuedCount})` : ''}</button>
  </div>

  <main class="workspace">
    <aside class:mobile-hidden={workspaceTab !== 'annotate'} class:tab-hidden={workspaceTab === 'sync'} class="group-column card">
      <div class="section-heading">
        <div><span class="eyebrow">TEXT</span><h2>原文与意群</h2></div>
        <button class="btn btn-sm variant-soft-primary" on:click={addGroup}>＋ 意群</button>
      </div>
      <label class="label">
        <span>录入句子</span>
        <textarea class="textarea" rows="4" value={project.sentence} on:input={(event) => updateSentence(event.currentTarget.value)}></textarea>
      </label>
      <label class="label">
        <span>英文释义 / 参考</span>
        <textarea class="textarea" rows="3" value={project.translation} on:input={(event) => editProject((draft) => (draft.translation = event.currentTarget.value))}></textarea>
      </label>
      <div class="inline-actions">
        <button class="btn btn-sm variant-soft" on:click={splitSentence}>按标点智能切分</button>
        <span>{visibleGroups.length} 个意群 · {project.orderVersions.length} 版顺序</span>
      </div>
      <label class="label">
        <span>查看顺序版本（反馈始终锚定它被写下时的版本）</span>
        <select class="select" value={viewOrderVersionId} on:change={(event) => (viewOrderVersionId = event.currentTarget.value)}>
          {#each [...project.orderVersions].reverse() as version}
            <option value={version.id}>{version.label} · {new Date(version.createdAt).toLocaleString('zh-CN')}{version.id === project.activeOrderVersionId ? '（当前）' : ''}</option>
          {/each}
        </select>
      </label>
      <div class="group-list">
        {#each visibleGroups as group, index (group.id)}
          <button class:active={group.id === selectedGroup?.id} class="group-item" on:click={() => selectGroup(group.id)}>
            <span class="group-index">{String(index + 1).padStart(2, '0')}</span>
            <span class="group-copy">
              <strong>{group.text}</strong>
              <small>重音 {group.stressWords.join('、') || '未设'} · 停 {group.pauseMs}ms · {intonationOptions.find((item) => item.value === group.intonation)?.label}</small>
            </span>
          </button>
        {/each}
      </div>
      <div class="sidebar-actions">
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(-1)}>上移</button>
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(1)}>下移</button>
        <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteGroup}>删除意群</button>
      </div>
      <div class="shortcut-note">
        <strong>快捷操作</strong>
        <span>Alt + ↑/↓ 调整意群 · Alt+R 开始/停止录音</span>
        <span>← / → 切换意群 · ⌘S 保存 · ⌘Z 撤销</span>
      </div>
    </aside>

    {#if selectedGroup}
      <section class:mobile-hidden={workspaceTab !== 'annotate'} class:tab-hidden={workspaceTab === 'sync'} class="annotation-column">
        <div class="card annotation-card">
          <div class="section-heading">
            <div><span class="eyebrow">PROSODY MARKUP</span><h2>发音与韵律标注</h2></div>
            <span class="chapter-badge">意群 {visibleGroups.findIndex((group) => group.id === selectedGroup?.id) + 1}</span>
          </div>
          {#if viewVersion?.id !== activeVersion?.id}
            <p class="version-note">正在查看历史顺序 <strong>{viewVersion?.label}</strong>，标注编辑会作用于意群本身。</p>
          {/if}
          <label class="label">
            <span>意群文本</span>
            <input class="input" value={selectedGroup.text} on:input={(event) => updateGroup('text', event.currentTarget.value)} />
          </label>
          <div class="token-board">
            <div class="token-label">点击文字切换重音词</div>
            <div class="token-list">
              {#each selectedGroup.text.split('') as char}
                <button class:stressed={selectedGroup.stressWords.some((word) => word.includes(char))} class="text-token" on:click={() => toggleStressWord(char)}>{char}</button>
              {/each}
            </div>
          </div>
          <div class="annotation-grid">
            <label class="label">
              <span>重音词（用逗号分隔）</span>
              <input class="input" value={selectedGroup.stressWords.join('，')} on:change={(event) => updateGroup('stressWords', event.currentTarget.value.split(/[，,]/).map((word) => word.trim()).filter(Boolean))} />
            </label>
            <div class="label">
              <span>重音强度</span>
              <div class="segmented">
                {#each [0, 1, 2, 3] as level}
                  <button class:active={selectedGroup.stressLevel === level} on:click={() => setStressLevel(level)}>{level === 0 ? '无' : '●'.repeat(level)}</button>
                {/each}
              </div>
            </div>
            <label class="label">
              <span>后接停顿：{selectedGroup.pauseMs}ms</span>
              <input class="range" type="range" min="0" max="1500" step="20" value={selectedGroup.pauseMs} on:input={(event) => updateGroup('pauseMs', Number(event.currentTarget.value))} />
            </label>
            <label class="label">
              <span>语调走向</span>
              <select class="select" value={selectedGroup.intonation} on:change={(event) => setIntonation(event.currentTarget.value)}>
                {#each intonationOptions as option}<option value={option.value}>{option.label}</option>{/each}
              </select>
            </label>
            <label class="label span-2">
              <span>学习提示</span>
              <input class="input" value={selectedGroup.note} on:input={(event) => updateGroup('note', event.currentTarget.value)} placeholder="例如：重音后短停，句尾自然下落" />
            </label>
          </div>
          <div class="prosody-preview">
            <div>
              <span class="eyebrow">PREVIEW</span>
              <strong>标注预览</strong>
            </div>
            <p>
              <span class="stress-line">{'●'.repeat(selectedGroup.stressLevel)}</span>
              <span>{selectedGroup.text}</span>
              <span class="pause-mark">{selectedGroup.pauseMs ? `／ ${selectedGroup.pauseMs}ms` : ''}</span>
              <span class="intonation-mark">{intonationOptions.find((item) => item.value === selectedGroup.intonation)?.label}</span>
            </p>
          </div>
        </div>

        <div class="card recorder-card">
          <div class="section-heading">
            <div><span class="eyebrow">RECORDING</span><h2>录下这一轮</h2></div>
            <span class:recording class="record-dot">{recording ? 'REC' : 'READY'}</span>
          </div>
          <div class="record-console">
            <div class="record-time">{Math.floor(recordingSeconds / 60).toString().padStart(2, '0')}:{Math.floor(recordingSeconds % 60).toString().padStart(2, '0')}.{Math.floor((recordingSeconds % 1) * 10)}</div>
            <div class="level-bars" aria-hidden="true">
              {#each Array(24) as _, index}<span style={`height:${recording ? 18 + ((index * 17) % 46) : 12}%`}></span>{/each}
            </div>
            <button class:variant-filled-error={recording} class:variant-filled-primary={!recording} class="btn record-button" on:click={() => (recording ? stopRecording() : startRecording())}>
              {recording ? '■ 停止并打包' : '● 开始录音'}
            </button>
            <p>{recordingFallback ? '当前浏览器未授权麦克风，将保存一轮可校对的离线模拟记录。' : '录完立即进入离线练习包队列，联网后分片续传；同一录音重复提交只占一份。'}</p>
          </div>
        </div>
      </section>
    {/if}

    <aside class:mobile-hidden={workspaceTab !== 'review' && workspaceTab !== 'sync'} class="review-column">
      <div class="card attempts-card">
        <div class="section-heading">
          <div><span class="eyebrow">TAKES</span><h2>多轮尝试</h2></div>
          <span class="chapter-badge">{project.attempts.length} 轮</span>
        </div>
        <div class="attempt-list">
          {#each [...project.attempts].reverse() as attempt}
            <button class:active={attempt.id === selectedAttempt?.id} class="attempt-item" on:click={() => { selectedAttemptId = attempt.id; stopPlayback() }}>
              <span class="attempt-number">{attempt.number}</span>
              <span><strong>{attempt.label}</strong><small>{attempt.duration.toFixed(1)}s · {attempt.simulated ? '模拟' : attempt.audioFromRemote && !attempt.audioBlob ? '远端录音' : '录音'}</small></span>
              <span class="attempt-flags">
                {#if attempt.audioSynced}<small class="badge variant-soft-success">已传</small>{:else if attempt.bundleId || queue.some((b) => b.payload.kind === 'practice' && b.payload.attempt?.id === attempt.id)}<small class="badge variant-soft-warning">排队</small>{/if}
                <span class="attempt-score">{attempt.scores.length ? Math.round(attempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / attempt.scores.length) : 0}%</span>
              </span>
            </button>
          {/each}
        </div>
        {#if selectedAttempt && device}
          <button class="btn btn-sm variant-soft" on:click={resubmitAttempt}>把本轮重新打成练习包提交</button>
        {/if}
      </div>

      {#if selectedAttempt}
        <div class:recommended={workspaceTab !== 'sync'} class="card playback-card">
          <div class="section-heading">
            <div><span class="eyebrow">COMPARE</span><h2>回听与偏差</h2></div>
            <button class="btn btn-sm variant-filled-primary" on:click={togglePlayback}>{playing ? '■ 停止' : '▶ 播放范围'}</button>
          </div>
          <audio bind:this={audioElement} src={audioUrlFor(selectedAttempt)} on:timeupdate={onAudioTimeUpdate} on:ended={stopPlayback}></audio>
          {#if !selectedAttempt.audioBlob && selectedAttempt.audioFromRemote}<p class="empty-copy">这段录音在另一台设备上，下次同步联网时自动下载。</p>{/if}
          <div class="playback-timeline">
            <div class="playhead" style={`left:${selectedAttempt.duration ? Math.min(100, (playbackTime / selectedAttempt.duration) * 100) : 0}%`}></div>
            <span class="range-fill" style={`left:${selectedAttempt.duration ? (selectedAttempt.rangeStart / selectedAttempt.duration) * 100 : 0}%;right:${selectedAttempt.duration ? 100 - (selectedAttempt.rangeEnd / selectedAttempt.duration) * 100 : 0}%`}></span>
          </div>
          <div class="range-controls">
            <label><span>回听起点 {selectedAttempt.rangeStart.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeStart} on:input={(event) => updateRange('rangeStart', Number(event.currentTarget.value))} /></label>
            <label><span>回听终点 {selectedAttempt.rangeEnd.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeEnd} on:input={(event) => updateRange('rangeEnd', Number(event.currentTarget.value))} /></label>
          </div>
          {#if selectedScore}
            <div class="score-grid">
              <label><span>准确度 {selectedScore.accuracy}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.accuracy} on:input={(event) => updateScore('accuracy', Number(event.currentTarget.value))} /></label>
              <label><span>节奏 {selectedScore.rhythm}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.rhythm} on:input={(event) => updateScore('rhythm', Number(event.currentTarget.value))} /></label>
              <label><span>偏差 {selectedScore.deviation}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.deviation} on:input={(event) => updateScore('deviation', Number(event.currentTarget.value))} /></label>
            </div>
            <label class="label"><span>本意群偏差说明</span><textarea class="textarea" rows="2" value={selectedScore.note} on:input={(event) => updateScoreNote(event.currentTarget.value)}></textarea></label>
          {/if}
          <label class="label"><span>本轮自评</span><textarea class="textarea" rows="2" value={selectedAttempt.selfNote} on:input={(event) => editProject((draft) => { const attempt = draft.attempts.find((item) => item.id === selectedAttemptId); if (attempt) { attempt.selfNote = event.currentTarget.value; touchAttemptRevision(draft, selectedAttemptId) } })}></textarea></label>
        </div>

        <div class:recommended={workspaceTab === 'review'} class="card issues-card">
          <div class="section-heading">
            <div><span class="eyebrow">ERROR TAGS</span><h2>错词分类</h2></div>
          </div>
          <div class="issue-form">
            <input class="input" placeholder="错词或字" value={issueWord} on:input={(event) => (issueWord = event.currentTarget.value)} />
            <select class="select" value={issueCategory} on:change={(event) => (issueCategory = event.currentTarget.value)}>
              {#each project.errorCategories as category}<option value={category}>{category}</option>{/each}
            </select>
            <input class="input span-2" placeholder="问题说明（可选）" value={issueNote} on:input={(event) => (issueNote = event.currentTarget.value)} />
            <button class="btn btn-sm variant-filled-secondary span-2" on:click={addWordIssue}>添加错词并排队上传</button>
          </div>
          <div class="issue-list">
            {#each selectedAttempt.wordIssues.filter((issue) => issue.groupId === selectedGroupId) as issue}
              <div class="issue-item">
                <span class="badge variant-filled-warning">{issue.category}</span>
                <strong>{issue.word}</strong>
                <p>{issue.note || '暂无补充说明'}</p>
                <button class="btn btn-sm variant-ghost text-error-500" on:click={() => removeWordIssue(issue.id)}>移除</button>
              </div>
            {/each}
            {#if !selectedAttempt.wordIssues.some((issue) => issue.groupId === selectedGroupId)}<p class="empty-copy">本轮意群还没有错词记录。</p>{/if}
          </div>
        </div>
      {/if}

      <div class:recommended={workspaceTab === 'review' || workspaceTab === 'sync'} class="card feedback-card">
        <div class="section-heading">
          <div><span class="eyebrow">TEACHER FEEDBACK</span><h2>逐段反馈</h2></div>
        </div>
        {#if selectedAttempt}
          <p class="empty-copy">反馈锚定到第 {selectedAttempt.number} 轮写下时的意群；意群顺序改版后，旧反馈仍挂原意群。</p>
          <div class="feedback-list">
            {#each selectedAttempt.feedback.filter((item) => item.groupId === selectedGroupId) as feedback}
              <div class="feedback-item">
                <div class="feedback-head">
                  <strong>{feedback.teacher}</strong>
                  <span class="feedback-actions">
                    <button class="btn btn-sm variant-ghost" on:click={() => rewriteFeedback(feedback.id)}>改写</button>
                    <button class="btn btn-sm variant-ghost text-error-500" on:click={() => withdrawFeedback(feedback.id)}>撤回</button>
                  </span>
                </div>
                <p>{feedback.text}</p>
                <small>{new Date(feedback.createdAt).toLocaleString('zh-CN')}</small>
              </div>
            {/each}
            {#if !selectedAttempt.feedback.some((item) => item.groupId === selectedGroupId)}<p class="empty-copy">本意群还没有反馈。</p>{/if}
          </div>
          <label class="label"><span>{role === 'teacher' ? '教师' : '学生'}给当前意群留言（离线也会打包）</span><textarea class="textarea" rows="2" bind:value={feedbackText} placeholder="反馈会绑定到这一轮和这个意群"></textarea></label>
          <button class="btn btn-sm variant-filled-tertiary" on:click={addFeedback}>留下反馈并排队</button>
        {/if}
      </div>
    </aside>

    {#if workspaceTab === 'sync'}
      <section class="sync-column">
        <div class="card sync-card">
          <div class="section-heading">
            <div><span class="eyebrow">SYNC CENTER</span><h2>练习包与同步</h2></div>
            <button class="btn btn-sm variant-filled-primary" on:click={runSync} disabled={syncing || !device}>{syncing ? '同步中…' : '立即同步'}</button>
          </div>
          <div class="sync-controls">
            <button class="btn btn-sm" class:variant-filled-error={!simulatedOffline} class:variant-soft-success={simulatedOffline} on:click={toggleSimulatedOffline}>
              {simulatedOffline ? '模拟断网中 · 点击恢复' : '模拟断网'}
            </button>
            <button class="btn btn-sm variant-ghost text-error-500" on:click={clearCloud}>清空模拟云端</button>
            <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteAllData}>清除本机数据</button>
            <button class="btn btn-sm variant-ghost" on:click={resetSample}>恢复示例</button>
          </div>
          {#if lastSyncAt}<p class="empty-copy">上次同步：{new Date(lastSyncAt).toLocaleString('zh-CN')}</p>{/if}
          <div class:error={syncProgress.phase === 'error'} class:offline={syncProgress.phase === 'offline'} class="sync-status">
            <strong>{syncProgress.phase === 'idle' ? '等待同步' : syncProgress.message}</strong>
            {#if syncProgress.phase === 'pushing' || syncProgress.phase === 'downloading'}<ProgressBar value={syncProgress.percent} />{/if}
          </div>
          <div class="bundle-list">
            {#each queue as bundle (bundle.id)}
              <div class={`bundle-item status-${bundle.status}`}>
                <div class="bundle-head">
                  <strong>{bundle.kind === 'practice' && bundle.payload.kind === 'practice' ? `第 ${bundle.payload.attempt.number} 轮练习包` : bundle.kind === 'order' ? '意群顺序包' : bundle.kind === 'wordIssue' ? '错词包' : bundle.payload.kind === 'feedback' && bundle.payload.feedback.deletedAt ? '反馈撤回墓碑' : '反馈包'}</strong>
                  <span class="badge">{bundle.status === 'queued' ? '排队' : bundle.status === 'uploading' ? `上传 ${CHUNK_PERCENT(bundle)}%` : bundle.status === 'error' ? '中断·待续' : '已传'}</span>
                </div>
                <small>{new Date(bundle.createdAt).toLocaleString('zh-CN')} · 设备 {bundle.deviceId.slice(-5)}</small>
                {#if bundle.payload.kind === 'practice' && bundle.payload.audio}
                  <ProgressBar value={CHUNK_PERCENT(bundle)} />
                  <small>录音 {bundle.payload.audio.hash.slice(0, 10)}… · {bundle.ackedChunk}/{bundle.payload.audio.totalChunks} 片 · {(bundle.payload.audio.size / 1024).toFixed(0)} KiB</small>
                {/if}
                {#if bundle.lastError}<small class="text-error-500">{bundle.lastError}</small>{/if}
              </div>
            {/each}
            {#if !queue.length}<p class="empty-copy">练习包队列是空的：录音与反馈都已送达。</p>{/if}
          </div>
        </div>

        <div class="card pending-card">
          <div class="section-heading">
            <div><span class="eyebrow">PENDING</span><h2>待处理反馈（找不到意群锚点）</h2></div>
            <span class="chapter-badge">{project.pendingFeedback.length}</span>
          </div>
          {#each project.pendingFeedback as item}
            <div class="pending-item">
              <div class="feedback-head">
                <strong>{item.feedback.teacher} 锚定的意群已不在任何顺序版本中</strong>
                <button class="btn btn-sm variant-soft-primary" on:click={() => (pendingAnchorChoice = item)}>重新锚定</button>
              </div>
              <p>{item.feedback.text}</p>
              <small>{new Date(item.feedback.createdAt).toLocaleString('zh-CN')} · 第 {project.attempts.find((attempt) => attempt.id === item.attemptId)?.number ?? '?'} 轮</small>
            </div>
          {/each}
          {#if !project.pendingFeedback.length}<p class="empty-copy">所有反馈都能锚定到意群。</p>{/if}
        </div>

        <div class="card progress-dashboard">
          <div class="section-heading">
            <div><span class="eyebrow">PROGRESS</span><h2>练习进度与错词归类</h2></div>
          </div>
          <div class="progress-grid">
            <div><strong>{project.attempts.length}</strong><span>累计尝试</span></div>
            <div><strong>{averageAccuracy}%</strong><span>当前准确度</span></div>
            <div><strong>{averageDeviation}%</strong><span>平均偏差</span></div>
            <div><strong>{project.errorCategories.reduce((sum, category) => sum + project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length, 0)}</strong><span>错词记录</span></div>
          </div>
          <div class="category-list">
            {#each totalIssueCategories as category}
              <div><span>{category.category}</span><div class="mini-bar"><i style={`width:${Math.min(100, category.count * 18)}%`}></i></div><strong>{category.count}</strong></div>
            {/each}
          </div>
          <div class="inline-actions">
            <input class="input" bind:value={newCategory} placeholder="新增错词分类" />
            <button class="btn btn-sm variant-soft" on:click={addCategory}>添加分类</button>
          </div>
        </div>
      </section>
    {/if}
  </main>

  {#if pendingAnchorChoice}
    <div class="modal-backdrop" on:click={() => (pendingAnchorChoice = null)} on:keydown={(event) => event.key === 'Escape' && (pendingAnchorChoice = null)} role="presentation">
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <div class="card modal-card" role="dialog" aria-modal="true" on:click|stopPropagation>
        <h3>把反馈重新锚定到哪个意群？</h3>
        <p>{pendingAnchorChoice.feedback.text}</p>
        <div class="anchor-list">
          {#each visibleGroups as group}
            <button class="btn btn-sm variant-soft" on:click={() => reanchorPendingChoice(group.id)}>{group.text}</button>
          {/each}
        </div>
        <button class="btn btn-sm variant-ghost" on:click={() => (pendingAnchorChoice = null)}>取消</button>
      </div>
    </div>
  {/if}

  {#if !loaded}
    <div class="loading-overlay"><span class="loading-bar">正在恢复离线练习…</span></div>
  {/if}
</div>
