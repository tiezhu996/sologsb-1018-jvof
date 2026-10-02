<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ProgressBar } from '@skeletonlabs/skeleton'
  import { createSampleProject } from './sample'
  import { clearPractice, loadPractice, savePractice } from './storage'
  import { commitGroupVersion, commitOrderVersion, enqueuePackage, hashBlob, packageProgress, queueFeedback, reassignPendingFeedback, synchronize, uid } from './sync'
  import type { Attempt, FeedbackStatus, Intonation, PracticeProject, SegmentFeedback, SenseGroup, StressLevel, SyncState } from './types'

  const intonationOptions: Array<{ value: Intonation; label: string }> = [
    { value: 'fall', label: '下降 ↘' },
    { value: 'rise', label: '上升 ↗' },
    { value: 'flat', label: '平稳 →' },
    { value: 'rise-fall', label: '先升后降 ↗↘' },
    { value: 'fall-rise', label: '先降后升 ↘↗' }
  ]

  let project: PracticeProject = createSampleProject()
  let sync: SyncState = { deviceId: project.deviceId, packages: [], feedbackQueue: [], pendingFeedback: [], cursor: '0', lastMessage: '尚未提交练习包', syncing: false }
  let loaded = false
  let saveStatus = '正在读取本机练习…'
  let online = true
  let selectedGroupId = project.groups[0]?.id ?? ''
  let selectedAttemptId = project.attempts.at(-1)?.id ?? ''
  let workspaceTab: 'annotate' | 'review' | 'progress' = 'annotate'
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
  let editingFeedbackId: string | null = null
  let pendingTargetGroupId = ''
  let newCategory = ''
  let undoStack: PracticeProject[] = []
  let redoStack: PracticeProject[] = []
  let selectedGroup: SenseGroup | undefined
  let selectedAttempt: Attempt | undefined

  $: selectedGroup = project.groups.find((group) => group.id === selectedGroupId) ?? project.groups[0]
  $: selectedAttempt = project.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? project.attempts.at(-1)
  $: selectedScore = selectedAttempt && selectedGroup ? selectedAttempt.scores.find((score) => score.groupId === selectedGroup?.id) : undefined
  $: completedAttempts = Math.min(project.attempts.length, project.targetAttempts)
  $: progress = Math.round((completedAttempts / Math.max(project.targetAttempts, 1)) * 100)
  $: averageAccuracy = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / selectedAttempt.scores.length) : 0
  $: averageDeviation = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.deviation, 0) / selectedAttempt.scores.length) : 0
  $: totalIssueCategories = project.errorCategories.map((category) => ({ category, count: project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length }))
  function packageForAttempt(attemptId: string) {
    return sync.packages.find((pkg) => pkg.attemptId === attemptId)
  }
  function attemptSyncLabel(attemptId: string) {
    const pkg = packageForAttempt(attemptId)
    if (!pkg) return '未提交'
    return pkg.status === 'done' ? '练习包已同步' : `${packageProgress(pkg)}% 断点保留`
  }
  $: currentGroupFeedback = selectedAttempt?.feedback.filter((item) => item.groupId === selectedGroupId && item.groupVersionId === selectedGroup?.versionId) ?? []
  $: anchoredHistoryFeedback = selectedAttempt?.feedback.filter((item) => item.groupId === selectedGroupId && item.groupVersionId !== selectedGroup?.versionId) ?? []
  $: pendingPackageCount = sync.packages.filter((pkg) => pkg.status !== 'done').length
  $: activePendingFeedback = sync.pendingFeedback.filter((feedback) => feedback.status === 'active')

  const clone = <T,>(value: T): T => structuredClone(value)

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
    saveStatus = online ? '正在保存…' : '离线编辑中，稍后继续保存'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      const target = await savePractice(project, sync)
      saveStatus = target === 'indexeddb' ? '已保存到本机' : '已保存到离线备份'
    }, 250)
  }

  function touchAttempt(draft: PracticeProject, attemptId = selectedAttemptId) {
    const attempt = draft.attempts.find((item) => item.id === attemptId)
    if (attempt) attempt.clientUpdatedAt = new Date().toISOString()
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

  function commitContentVersionInDraft(draft: PracticeProject, groupId = selectedGroupId) {
    const before = project.groups.find((group) => group.id === groupId)
    const changed = draft.groups.find((group) => group.id === groupId)
    if (!before || !changed) return
    const newId = uid('group-version')
    const snapshot: SenseGroup = { ...structuredClone(changed), versionId: newId, parentVersionId: before.versionId ?? null }
    const version = {
      id: newId,
      groupId,
      parentVersionId: before.versionId ?? null,
      order: changed.order,
      savedAt: new Date().toISOString(),
      snapshot
    }
    changed.versionId = newId
    changed.parentVersionId = before.versionId ?? null
    draft.groupVersions.push(version)
  }

  function updateGroup(field: keyof SenseGroup, value: string | number | string[]) {
    editProject((draft) => {
      const group = draft.groups.find((item) => item.id === selectedGroupId)
      if (!group) return
      ;(group as unknown as Record<string, unknown>)[field] = value
      commitContentVersionInDraft(draft)
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
      const now = new Date().toISOString()
      const groupVersionId = uid('group-version')
      draft.groups.push({ id, text: '新的意群', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '', order: draft.groups.length, createdAt: now, versionId: groupVersionId, parentVersionId: null })
      draft.groupVersions.push({ id: groupVersionId, groupId: id, parentVersionId: null, order: draft.groups.length - 1, savedAt: now, snapshot: structuredClone(draft.groups.at(-1)!) })
      commitOrderVersion(project, draft, '新增意群')
    })
    selectedGroupId = id
  }

  function deleteGroup() {
    if (!selectedGroup || project.groups.length <= 1) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup.id)
    editProject((draft) => {
      draft.groups = draft.groups.filter((group) => group.id !== selectedGroup?.id).map((group, order) => ({ ...group, order }))
      commitOrderVersion(project, draft, '删除意群')
    })
    selectedGroupId = project.groups[Math.max(0, index - 1)]?.id ?? ''
  }

  function moveGroup(direction: -1 | 1) {
    if (!selectedGroup) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup?.id)
    const next = index + direction
    if (next < 0 || next >= project.groups.length) return
    editProject((draft) => {
      const [group] = draft.groups.splice(index, 1)
      draft.groups.splice(next, 0, group)
      draft.groups.forEach((item, order) => item.order = order)
      commitOrderVersion(project, draft, '调整意群顺序')
    })
  }

  function splitSentence() {
    const parts = project.sentence.split(/[，。！？；、\n]+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return
    editProject((draft) => {
      const now = new Date().toISOString()
      draft.groups = parts.map((text, index) => {
        const previous = draft.groups[index]
        const changed = previous?.text !== text
        const id = previous?.id ?? uid('group')
        const versionId = previous && changed ? uid('group-version') : previous?.versionId ?? uid('group-version')
        const group: SenseGroup = {
          ...previous,
          id,
          text,
          stressWords: previous?.stressWords ?? [],
          stressLevel: previous?.stressLevel ?? 1,
          pauseMs: previous?.pauseMs ?? 300,
          intonation: previous?.intonation ?? 'flat',
          note: previous?.note ?? '',
          order: index,
          createdAt: previous?.createdAt ?? now,
          versionId,
          parentVersionId: previous && changed ? previous.versionId ?? null : previous?.parentVersionId ?? null
        }
        if (previous && changed) {
          draft.groupVersions.push({ id: versionId, groupId: id, parentVersionId: previous.versionId ?? null, order: index, savedAt: now, snapshot: structuredClone(group) })
        }
        if (!previous) {
          draft.groupVersions.push({ id: versionId, groupId: id, parentVersionId: null, order: index, savedAt: now, snapshot: structuredClone(group) })
        }
        return group
      })
      commitOrderVersion(project, draft, '重新切分意群')
    })
    selectedGroupId = project.groups[0]?.id ?? ''
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
      mediaRecorder.onstop = () => finishRecording(recordingFallback)
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
    else finishRecording(true)
  }

  async function finishRecording(simulated: boolean) {
    if (!recording) return
    recording = false
    window.clearInterval(recordingTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    const blob = !simulated && mediaChunks.length ? new Blob(mediaChunks, { type: mediaChunks[0].type || 'audio/webm' }) : undefined
    const audioHash = await hashBlob(blob)
    const attemptId = uid('attempt')
    const number = project.attempts.length + 1
    const duration = Number(Math.max(0.5, recordingSeconds).toFixed(1))
    const now = new Date().toISOString()
    const attempt: Attempt = {
      id: attemptId,
      originDeviceId: project.deviceId,
      number,
      label: simulated ? `第 ${number} 轮 · 离线模拟` : `第 ${number} 轮`,
      createdAt: now,
      clientUpdatedAt: now,
      duration,
      audioBlob: blob,
      audioMime: blob?.type ?? 'audio/webm',
      audioHash,
      simulated,
      rangeStart: 0,
      rangeEnd: duration,
      scores: project.groups.map((group) => ({ groupId: group.id, accuracy: 70, rhythm: 70, deviation: 0, note: '' })),
      wordIssues: [],
      feedback: [],
      selfNote: '',
      orderVersionId: project.currentOrderVersionId
    }
    if (blob) audioUrls.set(attemptId, URL.createObjectURL(blob))
    editProject((draft) => { draft.attempts.push(attempt) })
    selectedAttemptId = attemptId
    workspaceTab = 'review'
    recordingSeconds = duration
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
      touchAttempt(draft)
    })
  }

  function updateScoreNote(value: string) {
    if (!selectedAttempt || !selectedGroup) return
    editProject((draft) => {
      const score = draft.attempts.find((attempt) => attempt.id === selectedAttemptId)?.scores.find((item) => item.groupId === selectedGroupId)
      if (score) score.note = value
      touchAttempt(draft)
    })
  }

  function addWordIssue() {
    if (!selectedAttempt || !selectedGroup || !issueWord.trim()) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      attempt?.wordIssues.push({ id: uid('issue'), groupId: selectedGroupId, word: issueWord.trim(), category: issueCategory, note: issueNote.trim() })
      touchAttempt(draft)
    })
    issueWord = ''
    issueNote = ''
  }

  function removeWordIssue(issueId: string) {
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.wordIssues = attempt.wordIssues.filter((issue) => issue.id !== issueId)
      touchAttempt(draft)
    })
  }

  function addFeedback() {
    if (!selectedGroup || !selectedAttempt || !feedbackText.trim()) return
    const now = new Date().toISOString()
    let feedback: SegmentFeedback | null = null
    if (editingFeedbackId) {
      const original = selectedAttempt.feedback.find((item) => item.id === editingFeedbackId)
      if (original) feedback = { ...original, text: feedbackText.trim(), updatedAt: now, status: 'edited', previousText: original.text }
    } else {
      feedback = {
          id: uid('feedback'),
          attemptId: selectedAttemptId,
          originDeviceId: project.deviceId,
          groupId: selectedGroupId,
          groupVersionId: selectedGroup.versionId,
          teacher: project.teacher,
          text: feedbackText.trim(),
          createdAt: now,
          updatedAt: now,
          status: 'active'
        }
    }
    if (!feedback) return
    const savedFeedback = feedback
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt.feedback = attempt.feedback.filter((item) => item.id !== savedFeedback.id)
      attempt.feedback.push(savedFeedback)
    })
    sync = queueFeedback(sync, savedFeedback)
    void savePractice(project, sync)
    feedbackText = ''
    editingFeedbackId = null
  }

  function editFeedback(feedback: SegmentFeedback) {
    feedbackText = feedback.text
    editingFeedbackId = feedback.id
  }

  function cancelFeedbackEdit() {
    feedbackText = ''
    editingFeedbackId = null
  }

  function withdrawFeedback(feedbackId: string) {
    const current = project.attempts.find((attempt) => attempt.id === selectedAttemptId)?.feedback.find((item) => item.id === feedbackId)
    if (!current) return
    const withdrawn: SegmentFeedback = { ...current, status: 'withdrawn', updatedAt: new Date().toISOString() }
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      const feedback = attempt?.feedback.find((item) => item.id === feedbackId)
      if (feedback) Object.assign(feedback, withdrawn)
    })
    sync = queueFeedback(sync, withdrawn)
    void savePractice(project, sync)
  }

  async function submitPackage(attemptId: string) {
    const result = await enqueuePackage(project, sync, attemptId)
    project = result.project
    sync = result.sync
    await savePractice(project, sync)
    if (navigator.onLine) await runSync()
  }

  async function runSync() {
    if (sync.syncing) return
    const result = await synchronize(project, sync, async (nextProject, nextSync) => {
      project = nextProject
      sync = nextSync
      await savePractice(nextProject, nextSync)
    })
    project = result.project
    sync = result.sync
    await savePractice(project, sync)
    selectedAttemptId = project.attempts.find((attempt) => attempt.id === selectedAttemptId)?.id ?? project.attempts.at(-1)?.id ?? ''
    selectedGroupId = project.groups.find((group) => group.id === selectedGroupId)?.id ?? project.groups[0]?.id ?? ''
  }

  function assignPendingFeedback(feedbackId: string) {
    if (!pendingTargetGroupId) return
    const result = reassignPendingFeedback(project, sync, feedbackId, pendingTargetGroupId)
    project = result.project
    sync = result.sync
    void savePractice(project, sync)
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
      touchAttempt(draft)
    })
  }

  function addCategory() {
    if (!newCategory.trim() || project.errorCategories.includes(newCategory.trim())) return
    editProject((draft) => { draft.errorCategories.push(newCategory.trim()) })
    newCategory = ''
  }

  function resetSample() {
    if (!confirm('恢复示例会替换当前练习，确定继续吗？')) return
    const sample = createSampleProject()
    editProject((draft) => { Object.assign(draft, clone(sample)) })
    sync = { deviceId: sample.deviceId, packages: [], feedbackQueue: [], pendingFeedback: [], cursor: '0', lastMessage: '已重置示例', syncing: false }
    selectedGroupId = sample.groups[0]?.id ?? ''
    selectedAttemptId = sample.attempts.at(-1)?.id ?? ''
  }

  async function deleteAllData() {
    if (!confirm('这会清除本机全部练习、录音与反馈，且不能撤销。')) return
    stopPlayback()
    await clearPractice()
    const sample = createSampleProject()
    project = sample
    selectedGroupId = sample.groups[0]?.id ?? ''
    selectedAttemptId = sample.attempts.at(-1)?.id ?? ''
    undoStack = []
    redoStack = []
    sync = { deviceId: sample.deviceId, packages: [], feedbackQueue: [], pendingFeedback: [], cursor: '0', lastMessage: '本机数据已清除', syncing: false }
    await savePractice(project, sync)
  }

  async function switchDeviceRole() {
    const label = online ? 'switch-relay' : 'offline-device'
    if (!confirm(`将把当前资料切换到新的本机角色（${label}），用于模拟学生/学校两台设备；远程 relay 数据不会清除。继续吗？`)) return
    const deviceId = uid('device')
    editProject((draft) => { draft.deviceId = deviceId })
    sync = {
      ...sync,
      deviceId,
      packages: sync.packages.map((pkg) => ({ ...pkg, direction: pkg.originDeviceId === deviceId ? 'outbox' : 'inbox' })),
      lastMessage: '已切换设备角色，点击同步拉取另一台设备数据'
    }
    await savePractice(project, sync)
  }

  function onKeydown(event: KeyboardEvent) {
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void savePractice(project, sync).then(() => { saveStatus = '已保存到本机和断点' })
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
      const index = project.groups.findIndex((group) => group.id === selectedGroupId)
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (project.groups[next]) selectedGroupId = project.groups[next].id
    }
  }

  onMount(async () => {
    online = navigator.onLine
    const saved = await loadPractice()
    if (saved) {
      project = saved.project
      sync = saved.sync
    } else {
      sync = { ...sync, deviceId: project.deviceId }
      await savePractice(project, sync)
    }
    selectedGroupId = project.groups[0]?.id ?? ''
    selectedAttemptId = project.attempts.at(-1)?.id ?? ''
    pendingTargetGroupId = selectedGroupId
    loaded = true
    saveStatus = saved ? '已恢复本机练习和断点' : '示例练习已就绪'
    const handleOnline = () => { online = true; void runSync() }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', () => { online = false })
    window.addEventListener('keydown', onKeydown)
  })

  onDestroy(() => {
    window.clearTimeout(saveTimer)
    window.clearInterval(recordingTimer)
    window.clearInterval(playbackTimer)
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
      <span>{project.teacher} · 手机与电脑自动适配</span>
    </div>
    <div class="header-actions">
      <span class:offline={!online} class="connection badge">{online ? '在线' : '离线暂存'}</span>
      <button class="btn btn-sm variant-filled-primary" on:click={runSync} disabled={sync.syncing}>{sync.syncing ? '同步中…' : '同步练习包'}</button>
      <button class="btn btn-sm variant-ghost" on:click={switchDeviceRole}>切换设备角色</button>
      <span class="save-state">{pendingPackageCount ? `${pendingPackageCount} 个待传 · ` : ''}{sync.lastMessage}</span>
      <button class="btn btn-sm variant-ghost" on:click={undo} disabled={!undoStack.length}>撤销</button>
      <button class="btn btn-sm variant-ghost" on:click={redo} disabled={!redoStack.length}>重做</button>
      <button class="btn btn-sm variant-ghost" on:click={resetSample}>恢复示例</button>
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

  <section class="sync-strip card">
    <div>
      <span class="eyebrow">OFFLINE PACKAGE</span>
      <strong>{pendingPackageCount ? `${pendingPackageCount} 个练习包等待/继续上传` : '练习包队列空闲'}</strong>
      <p>录音按内容哈希去重；已完成的分片立即记录，刷新或断网后从下一个分片继续。</p>
    </div>
    <div class="sync-queue">
      {#each sync.packages.slice(-3) as pkg (pkg.id)}
        <div class="sync-queue-item">
          <span>{project.attempts.find((attempt) => attempt.id === pkg.attemptId)?.label ?? '练习轮次'} · v{pkg.revision}</span>
          <div class="mini-bar"><i style={`width:${packageProgress(pkg)}%`}></i></div>
          <strong>{pkg.status === 'done' ? '已同步' : `${packageProgress(pkg)}%`}</strong>
        </div>
      {/each}
    </div>
  </section>

  <div class="mobile-tabs">
    <button class:active={workspaceTab === 'annotate'} on:click={() => workspaceTab = 'annotate'}>标注</button>
    <button class:active={workspaceTab === 'review'} on:click={() => workspaceTab = 'review'}>录音校对</button>
    <button class:active={workspaceTab === 'progress'} on:click={() => workspaceTab = 'progress'}>反馈进度</button>
  </div>

  <main class="workspace">
    <aside class:mobile-hidden={workspaceTab !== 'annotate'} class="group-column card">
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
        <textarea class="textarea" rows="3" value={project.translation} on:input={(event) => editProject((draft) => draft.translation = event.currentTarget.value)}></textarea>
      </label>
      <div class="inline-actions">
        <button class="btn btn-sm variant-soft" on:click={splitSentence}>按标点智能切分</button>
        <span>{project.groups.length} 个意群</span>
      </div>
      <div class="group-list">
        {#each project.groups as group, index (group.id)}
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
      <section class:mobile-hidden={workspaceTab !== 'annotate'} class="annotation-column">
        <div class="card annotation-card">
          <div class="section-heading">
            <div><span class="eyebrow">PROSODY MARKUP</span><h2>发音与韵律标注</h2></div>
            <span class="chapter-badge">意群 {project.groups.findIndex((group) => group.id === selectedGroup?.id) + 1}</span>
          </div>
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
            <button class:variant-filled-error={recording} class:variant-filled-primary={!recording} class="btn record-button" on:click={() => recording ? stopRecording() : startRecording()}>
              {recording ? '■ 停止并保存尝试' : '● 开始录音'}
            </button>
            <p>{recordingFallback ? '当前浏览器未授权麦克风，将保存一轮可校对的离线模拟记录。' : '录音先保存在本机；点击练习包提交后才会排队上传。'}</p>
          </div>
        </div>
      </section>
    {/if}

    <aside class:mobile-hidden={workspaceTab !== 'review' && workspaceTab !== 'progress'} class="review-column">
      <div class="card attempts-card">
        <div class="section-heading">
          <div><span class="eyebrow">TAKES</span><h2>多轮尝试</h2></div>
          <span class="chapter-badge">{project.attempts.length} 轮</span>
        </div>
        <div class="attempt-list">
          {#each [...project.attempts].reverse() as attempt}
            <button class:active={attempt.id === selectedAttempt?.id} class="attempt-item" on:click={() => { selectedAttemptId = attempt.id; stopPlayback() }}>
              <span class="attempt-number">{attempt.number}</span>
              <span><strong>{attempt.label}</strong><small>{attempt.duration.toFixed(1)}s · {attempt.simulated ? '模拟' : '录音'} · {attemptSyncLabel(attempt.id)}</small></span>
              <span class="attempt-score">{attempt.scores.length ? Math.round(attempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / attempt.scores.length) : 0}%</span>
            </button>
          {/each}
        </div>
        {#if selectedAttempt}
          {@const pkg = packageForAttempt(selectedAttempt.id)}
          <button class="btn btn-sm variant-soft-primary package-submit" on:click={() => submitPackage(selectedAttempt.id)} disabled={sync.syncing}>
            {pkg ? pkg.status === 'done' ? '重新提交这一轮（保留幂等录音）' : `从 ${packageProgress(pkg)}% 断点继续提交` : '打成离线练习包并提交'}
          </button>
        {/if}
      </div>

      {#if selectedAttempt}
        <div class:recommended={workspaceTab !== 'progress'} class="card playback-card">
          <div class="section-heading">
            <div><span class="eyebrow">COMPARE</span><h2>回听与偏差</h2></div>
            <button class="btn btn-sm variant-filled-primary" on:click={togglePlayback}>{playing ? '■ 停止' : '▶ 播放范围'}</button>
          </div>
          <audio bind:this={audioElement} src={audioUrlFor(selectedAttempt)} on:timeupdate={onAudioTimeUpdate} on:ended={stopPlayback}></audio>
          <div class="playback-timeline">
            <div class="playhead" style={`left:${selectedAttempt.duration ? Math.min(100, playbackTime / selectedAttempt.duration * 100) : 0}%`}></div>
            <span class="range-fill" style={`left:${selectedAttempt.duration ? selectedAttempt.rangeStart / selectedAttempt.duration * 100 : 0}%;right:${selectedAttempt.duration ? 100 - selectedAttempt.rangeEnd / selectedAttempt.duration * 100 : 0}%`}></span>
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
          <label class="label"><span>本轮自评</span><textarea class="textarea" rows="2" value={selectedAttempt.selfNote} on:input={(event) => editProject((draft) => { const attempt = draft.attempts.find((item) => item.id === selectedAttemptId); if (attempt) { attempt.selfNote = event.currentTarget.value; touchAttempt(draft) } })}></textarea></label>
        </div>

        <div class:recommended={workspaceTab === 'review'} class="card issues-card">
          <div class="section-heading">
            <div><span class="eyebrow">ERROR TAGS</span><h2>错词分类</h2></div>
          </div>
          <div class="issue-form">
            <input class="input" placeholder="错词或字" value={issueWord} on:input={(event) => issueWord = event.currentTarget.value} />
            <select class="select" value={issueCategory} on:change={(event) => issueCategory = event.currentTarget.value}>
              {#each project.errorCategories as category}<option value={category}>{category}</option>{/each}
            </select>
            <input class="input span-2" placeholder="问题说明（可选）" value={issueNote} on:input={(event) => issueNote = event.currentTarget.value} />
            <button class="btn btn-sm variant-filled-secondary span-2" on:click={addWordIssue}>添加错词记录</button>
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

      <div class:recommended={workspaceTab === 'progress'} class="card feedback-card">
        <div class="section-heading">
          <div><span class="eyebrow">TEACHER FEEDBACK</span><h2>逐段反馈</h2></div>
          <span class="chapter-badge">锚定原意群</span>
        </div>
        <div class="feedback-list">
          {#each currentGroupFeedback as feedback}
            <div class:withdrawn={feedback.status === 'withdrawn'} class="feedback-item">
              <div class="feedback-head">
                <strong>{feedback.teacher}</strong>
                {#if feedback.status !== 'active'}<span class="badge">{feedback.status === 'withdrawn' ? '已撤回' : '已改写'}</span>{/if}
                {#if feedback.status === 'active'}
                  <button class="btn btn-sm variant-ghost" on:click={() => editFeedback(feedback)}>改写</button>
                  <button class="btn btn-sm variant-ghost text-error-500" on:click={() => withdrawFeedback(feedback.id)}>撤回</button>
                {/if}
              </div>
              {#if feedback.previousText && feedback.status === 'edited'}<p class="old-feedback">原文：{feedback.previousText}</p>{/if}
              <p>{feedback.status === 'withdrawn' ? '教师已撤回这条反馈，后续同步副本不会再显示。' : feedback.text}</p>
              <small>{new Date(feedback.updatedAt).toLocaleString('zh-CN')} · 锚点 {feedback.groupVersionId?.slice(-8)}</small>
            </div>
          {/each}
          {#if !currentGroupFeedback.some((item) => item.status === 'active')}<p class="empty-copy">当前意群没有有效反馈；改顺序后旧反馈仍按原意群版本归档。</p>{/if}
          {#if anchoredHistoryFeedback.length}
            <div class="history-box">
              <strong>原意群版本归档（{anchoredHistoryFeedback.length}）</strong>
              {#each anchoredHistoryFeedback as feedback}
                <div class:withdrawn={feedback.status === 'withdrawn'} class="feedback-history-row">
                  <span>{feedback.status === 'withdrawn' ? '已撤回' : feedback.text}</span>
                  <small>{feedback.groupVersionId?.slice(-8)}</small>
                </div>
              {/each}
            </div>
          {/if}
        </div>
        <label class="label"><span>{editingFeedbackId ? '改写反馈（保留原锚点，旧文进入版本）' : '给当前意群留言'}</span><textarea class="textarea" rows="2" value={feedbackText} on:input={(event) => feedbackText = event.currentTarget.value} placeholder="反馈绑定这一轮、意群 ID 与当时版本 ID"></textarea></label>
        <div class="inline-actions">
          <button class="btn btn-sm variant-filled-tertiary" on:click={addFeedback}>{editingFeedbackId ? '保存改写并同步' : '留下反馈'}</button>
          {#if editingFeedbackId}<button class="btn btn-sm variant-ghost" on:click={cancelFeedbackEdit}>取消改写</button>{/if}
        </div>
      </div>
    </aside>

    {#if workspaceTab === 'progress'}
      <section class="progress-dashboard card">
        <div class="section-heading">
          <div><span class="eyebrow">PROGRESS</span><h2>练习进度与错词归类</h2></div>
        </div>
        <div class="pending-box">
          <div class="section-heading"><div><span class="eyebrow">TRIAGE</span><h3>待处理反馈</h3></div><span class="chapter-badge">{activePendingFeedback.length}</span></div>
          {#if !activePendingFeedback.length}<p class="empty-copy">所有反馈都能找到原意群锚点。</p>{/if}
          {#each activePendingFeedback as feedback}
            <div class="pending-item">
              <div><strong>{feedback.teacher}</strong><p>{feedback.text}</p><small>原锚点 {feedback.groupId} / {feedback.groupVersionId}</small></div>
              <select class="select" on:change={(event) => pendingTargetGroupId = event.currentTarget.value} value={pendingTargetGroupId || selectedGroupId}>
                {#each project.groups as group}<option value={group.id}>{group.text}</option>{/each}
              </select>
              <button class="btn btn-sm variant-soft" on:click={() => assignPendingFeedback(feedback.id)}>归入意群</button>
            </div>
          {/each}
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
          <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteAllData}>清除本机数据</button>
        </div>
      </section>
    {/if}
  </main>

  {#if !loaded}
    <div class="loading-overlay"><span class="loading-bar">正在恢复离线练习…</span></div>
  {/if}
</div>
