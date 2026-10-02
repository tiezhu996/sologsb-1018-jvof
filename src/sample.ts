import type { PracticeProject } from './types'

export function createSampleProject(): PracticeProject {
  const now = Date.now()
  const initialOrderVersionId = 'order-version-initial'
  const groups = [
    {
      id: 'group-1', text: '清晨的海风', stressWords: ['海风'], stressLevel: 2 as const, pauseMs: 420, intonation: 'flat' as const,
      note: '平稳起句，不要咬字过重。', order: 0, createdAt: new Date(now - 90000000).toISOString(), versionId: 'group-version-initial-group-1', parentVersionId: null
    },
    {
      id: 'group-2', text: '掠过旧码头', stressWords: ['掠过'], stressLevel: 2 as const, pauseMs: 360, intonation: 'fall' as const,
      note: '“掠”字轻，避免拖成长音。', order: 1, createdAt: new Date(now - 90000000).toISOString(), versionId: 'group-version-initial-group-2', parentVersionId: null
    },
    {
      id: 'group-3', text: '也吹动了她手里的信', stressWords: ['她', '信'], stressLevel: 3 as const, pauseMs: 520, intonation: 'rise-fall' as const,
      note: '“她”后稍停，句尾自然下落。', order: 2, createdAt: new Date(now - 90000000).toISOString(), versionId: 'group-version-initial-group-3', parentVersionId: null
    },
    {
      id: 'group-4', text: '像一句迟到了很多年的回答', stressWords: ['很多年', '回答'], stressLevel: 3 as const, pauseMs: 300, intonation: 'fall-rise' as const,
      note: '最后形成回味，不要突然拔高。', order: 3, createdAt: new Date(now - 90000000).toISOString(), versionId: 'group-version-initial-group-4', parentVersionId: null
    }
  ]
  const groupVersions = groups.map((group) => ({
    id: group.versionId,
    groupId: group.id,
    parentVersionId: null,
    order: group.order,
    savedAt: group.createdAt
  }))
  const orderVersions = [
    {
      id: initialOrderVersionId,
      parentVersionId: null,
      savedAt: new Date(now - 90000000).toISOString(),
      entries: groups.map((group) => ({ groupId: group.id, groupVersionId: group.versionId, order: group.order }))
    }
  ]
  const feedbackAt1 = new Date(now - 82000000).toISOString()
  const feedbackAt2 = new Date(now - 81000000).toISOString()
  const feedbackAt3 = new Date(now - 35000000).toISOString()
  return {
    id: 'practice-harbor-letter',
    deviceId: 'device-sample',
    title: '电影独白 · 海风与回信',
    sentence: '清晨的海风，掠过旧码头，也吹动了她手里的信，像一句迟到了很多年的回答。',
    translation: 'The morning sea breeze swept over the old pier and stirred the letter in her hand, like an answer many years late.',
    teacher: '陈老师',
    targetAttempts: 5,
    targetDuration: 12.5,
    groups,
    groupVersions,
    orderVersions,
    currentOrderVersionId: initialOrderVersionId,
    attempts: [
      {
        id: 'attempt-1',
        number: 1,
        label: '首轮跟读',
        createdAt: new Date(now - 86400000).toISOString(),
        clientUpdatedAt: new Date(now - 83000000).toISOString(),
        duration: 14.8,
        audioMime: 'audio/webm',
        simulated: false,
        rangeStart: 2.2,
        rangeEnd: 7.6,
        orderVersionId: initialOrderVersionId,
        scores: groups.map((group, index) => ({ groupId: group.id, accuracy: [78, 72, 66, 74][index], rhythm: [72, 68, 61, 70][index], deviation: [16, 22, 29, 19][index], note: index === 2 ? '第三意群停顿过长。' : '' })),
        wordIssues: [
          { id: 'issue-1', groupId: 'group-2', word: '掠过', category: '声调', note: '去声下探不够明确。' },
          { id: 'issue-2', groupId: 'group-3', word: '信', category: '韵尾', note: '前鼻音收得不稳。' }
        ],
        feedback: [
          { id: 'feedback-1', attemptId: 'attempt-1', groupId: 'group-2', groupVersionId: 'group-version-initial-group-2', teacher: '陈老师', text: '“掠”字再轻一点，把重音留给后面的“旧码头”。', createdAt: feedbackAt1, updatedAt: feedbackAt1, status: 'active' as const },
          { id: 'feedback-2', attemptId: 'attempt-1', groupId: 'group-3', groupVersionId: 'group-version-initial-group-3', teacher: '陈老师', text: '“她”和“信”的重音层次可以更清楚，中间停顿缩短约半拍。', createdAt: feedbackAt2, updatedAt: feedbackAt2, status: 'active' as const }
        ],
        selfNote: '整体偏慢，第三段气息不足。'
      },
      {
        id: 'attempt-2',
        number: 2,
        label: '调整重音',
        createdAt: new Date(now - 43200000).toISOString(),
        clientUpdatedAt: new Date(now - 40000000).toISOString(),
        duration: 13.6,
        audioMime: 'audio/webm',
        simulated: false,
        rangeStart: 1.5,
        rangeEnd: 6.8,
        orderVersionId: initialOrderVersionId,
        scores: groups.map((group, index) => ({ groupId: group.id, accuracy: [83, 79, 75, 78][index], rhythm: [78, 76, 72, 77][index], deviation: [10, 13, 17, 13][index], note: index === 2 ? '停顿仍略长。' : '' })),
        wordIssues: [
          { id: 'issue-3', groupId: 'group-3', word: '信', category: '韵尾', note: '比上一轮稳定。' }
        ],
        feedback: [
          { id: 'feedback-3', attemptId: 'attempt-2', groupId: 'group-3', groupVersionId: 'group-version-initial-group-3', teacher: '陈老师', text: '节奏明显改善，下一轮注意句尾“回答”的两层语调。', createdAt: feedbackAt3, updatedAt: feedbackAt3, status: 'active' as const }
        ],
        selfNote: '第二意群衔接自然了。'
      }
    ],
    errorCategories: ['声调', '韵尾', '重音位置', '连读', '气息', '语速'],
    updatedAt: new Date().toISOString()
  }
}
