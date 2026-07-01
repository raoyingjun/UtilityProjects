import { type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CheckCircle2,
  Download,
  FolderOpen,
  ImageIcon,
  Info,
  Layers3,
  Loader2,
  MonitorSmartphone,
  PaintBucket,
  RotateCcw,
  Smartphone,
  Trash2,
  Upload,
  Wand2,
  AlertCircle,
  XCircle,
} from 'lucide-react'
import './App.css'
import { ANDROID_DENSITIES, TASK_COPY, type TaskId } from './lib/iconSpecs'
import {
  generateAssets,
  loadSourceImage,
  type GeneratedAsset,
  type GenerationProgress,
  type GenerationOptions,
  type SourceImage,
} from './lib/imageTools'
import {
  canWriteLocalProject,
  downloadZip,
  loadStoredProjects,
  pickFlutterProject,
  refreshFlutterProject,
  saveStoredProjects,
  upsertProject,
  writeAssetsToProject,
  type ProjectHandle,
  type WriteReport,
} from './lib/projectFiles'

type StepId = 0 | 1 | 2
type NotificationSourceMode = 'app' | 'custom'

type ProgressUi = GenerationProgress & {
  visible: boolean
}

type WorkspaceDraft = {
  activeTask: TaskId
  step: StepId
  androidSource: SourceImage | null
  notificationSource: SourceImage | null
  notificationSourceMode: NotificationSourceMode
  iosSource: SourceImage | null
  optionsByTask: Record<TaskId, GenerationOptions>
  previewAssets: GeneratedAsset[]
  exportAssets: GeneratedAsset[]
  exportSignature: string
  writeReport: WriteReport | null
}

const EXPORT_ONLY_WORKSPACE_ID = 'export-only'
const EXPORT_ONLY_MODE_LABEL = '仅导出模式'
const EXPORT_ONLY_MODE_HINT = '下载 ZIP，不写入 Flutter 项目'

const TASKS: Array<{ id: TaskId; icon: typeof Smartphone }> = [
  { id: 'android-launcher', icon: Smartphone },
  { id: 'android-notification', icon: Bell },
  { id: 'ios-launcher', icon: MonitorSmartphone },
]

const DEFAULT_OPTIONS: GenerationOptions = {
  taskId: 'android-launcher',
  backgroundColor: '#f4f7fb',
  scale: 0.82,
  trim: true,
  padding: 6,
  foregroundPercent: 66,
  monochrome: true,
}

function createDefaultOptionsByTask(): Record<TaskId, GenerationOptions> {
  return {
    'android-launcher': { ...DEFAULT_OPTIONS, taskId: 'android-launcher' },
    'android-notification': {
      ...DEFAULT_OPTIONS,
      taskId: 'android-notification',
      backgroundColor: '#00000000',
      scale: 0.74,
      padding: 12,
      foregroundPercent: 66,
      monochrome: false,
    },
    'ios-launcher': {
      ...DEFAULT_OPTIONS,
      taskId: 'ios-launcher',
      backgroundColor: '#ffffff',
      scale: 0.9,
      padding: 0,
      foregroundPercent: 66,
      monochrome: false,
    },
  }
}

function createDefaultWorkspaceDraft(): WorkspaceDraft {
  return {
    activeTask: 'android-launcher',
    step: 0,
    androidSource: null,
    notificationSource: null,
    notificationSourceMode: 'app',
    iosSource: null,
    optionsByTask: createDefaultOptionsByTask(),
    previewAssets: [],
    exportAssets: [],
    exportSignature: '',
    writeReport: null,
  }
}

function revokeSource(source: SourceImage | null) {
  if (source) {
    URL.revokeObjectURL(source.objectUrl)
  }
}

function revokeDraftSources(draft: WorkspaceDraft | undefined) {
  if (!draft) {
    return
  }

  const objectUrls = new Set<string>()
  for (const source of [draft.androidSource, draft.notificationSource, draft.iosSource]) {
    if (source) {
      objectUrls.add(source.objectUrl)
    }
  }
  for (const objectUrl of objectUrls) {
    URL.revokeObjectURL(objectUrl)
  }
}

const STEPS = [
  {
    title: 'Step 1',
    label: '导入素材',
    icon: Upload,
  },
  {
    title: 'Step 2',
    label: '调整参数',
    icon: Wand2,
  },
  {
    title: 'Step 3',
    label: '导出写入',
    icon: Download,
  },
] as const

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Record<string, WorkspaceDraft>>({
    [EXPORT_ONLY_WORKSPACE_ID]: createDefaultWorkspaceDraft(),
  })
  const [projects, setProjects] = useState<ProjectHandle[]>([])
  const [currentProjectId, setCurrentProjectId] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [progress, setProgress] = useState<ProgressUi>({
    visible: false,
    current: 0,
    total: 0,
    percent: 0,
    label: '',
    phase: 'prepare',
  })
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const projectBusyRef = useRef(false)
  const workspaceDraftsRef = useRef(workspaceDrafts)

  const currentProject = projects.find((item) => item.id === currentProjectId) ?? null
  const currentWorkspaceId = currentProject?.id ?? EXPORT_ONLY_WORKSPACE_ID
  const currentDraft = useMemo(
    () => workspaceDrafts[currentWorkspaceId] ?? createDefaultWorkspaceDraft(),
    [currentWorkspaceId, workspaceDrafts],
  )
  const {
    activeTask,
    step,
    androidSource,
    notificationSource,
    notificationSourceMode,
    iosSource,
    optionsByTask,
    previewAssets,
    exportAssets,
    exportSignature,
    writeReport,
  } = currentDraft
  const currentCopy = TASK_COPY[activeTask]
  const activeSource =
    activeTask === 'ios-launcher'
      ? iosSource
      : activeTask === 'android-notification' && notificationSourceMode === 'custom'
        ? notificationSource
        : androidSource
  const activeOptions = optionsByTask[activeTask]
  const blockingBusy = exportBusy || actionBusy
  const visibleAssetCount = step === 2 ? exportAssets.length : previewAssets.length
  const sourceReady = Boolean(activeSource)
  const statusDetail = error
    ? error
    : writeReport
      ? `写入 ${writeReport.written.length} 个，跳过 ${writeReport.skipped.length} 个`
      : status || '本地处理，不上传素材'

  const activeSignature = useMemo(() => {
    if (!activeSource) {
      return ''
    }

    return [
      activeTask,
      notificationSourceMode,
      activeSource.objectUrl,
      activeOptions.backgroundColor,
      activeOptions.scale,
      activeOptions.trim,
      activeOptions.padding,
      activeOptions.foregroundPercent,
      activeOptions.monochrome,
    ].join('|')
  }, [activeOptions, activeSource, activeTask, notificationSourceMode])

  const groupedAssets = useMemo(() => {
    const groups = new Map<string, GeneratedAsset[]>()
    for (const asset of previewAssets) {
      const current = groups.get(asset.group) ?? []
      current.push(asset)
      groups.set(asset.group, current)
    }
    return [...groups.entries()]
  }, [previewAssets])

  const updateWorkspaceDraft = useCallback(
    (workspaceId: string, updater: (draft: WorkspaceDraft) => WorkspaceDraft) => {
      setWorkspaceDrafts((current) => {
        const previousDraft = current[workspaceId] ?? createDefaultWorkspaceDraft()
        return {
          ...current,
          [workspaceId]: updater(previousDraft),
        }
      })
    },
    [],
  )

  const updateCurrentDraft = useCallback(
    (updater: (draft: WorkspaceDraft) => WorkspaceDraft) => {
      updateWorkspaceDraft(currentWorkspaceId, updater)
    },
    [currentWorkspaceId, updateWorkspaceDraft],
  )

  useEffect(() => {
    const baseTitle = '应用资源生成器'
    const projectPart = ` · ${currentProject?.name ?? EXPORT_ONLY_MODE_LABEL}`
    const busyPart = blockingBusy ? '处理中 · ' : ''
    document.title = `${busyPart}${currentCopy.shortLabel}${projectPart} · ${baseTitle}`

    return () => {
      document.title = baseTitle
    }
  }, [blockingBusy, currentCopy.shortLabel, currentProject])

  useEffect(() => {
    workspaceDraftsRef.current = workspaceDrafts
  }, [workspaceDrafts])

  useEffect(() => {
    setWorkspaceDrafts((current) => {
      if (current[currentWorkspaceId]) {
        return current
      }
      return {
        ...current,
        [currentWorkspaceId]: createDefaultWorkspaceDraft(),
      }
    })
  }, [currentWorkspaceId])

  useEffect(() => {
    return () => {
      for (const draft of Object.values(workspaceDraftsRef.current)) {
        revokeDraftSources(draft)
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    loadStoredProjects()
      .then((storedProjects) => {
        if (cancelled) {
          return
        }
        setProjects(storedProjects)
        setCurrentProjectId((current) => current || storedProjects[0]?.id || '')
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('无法读取已保存的项目列表，本次仍可手动选择。')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const targetWorkspaceId = currentWorkspaceId
    const timeout = window.setTimeout(() => {
      if (!activeSource) {
        updateWorkspaceDraft(targetWorkspaceId, (draft) => ({
          ...draft,
          previewAssets: [],
        }))
        return
      }

      setPreviewBusy(true)
      updateWorkspaceDraft(targetWorkspaceId, (draft) => ({
        ...draft,
        writeReport: null,
      }))
      setError('')

      generateAssets(activeSource, activeOptions, {
        mode: 'preview',
        includeDataUrls: true,
      })
        .then((nextAssets) => {
          if (!cancelled) {
            updateWorkspaceDraft(targetWorkspaceId, (draft) => ({
              ...draft,
              previewAssets: nextAssets,
            }))
          }
        })
        .catch((nextError: unknown) => {
          if (!cancelled) {
            updateWorkspaceDraft(targetWorkspaceId, (draft) => ({
              ...draft,
              previewAssets: [],
            }))
            setError(nextError instanceof Error ? nextError.message : '生成预览失败。')
          }
        })
        .finally(() => {
          if (!cancelled) {
            setPreviewBusy(false)
          }
        })
    }, 70)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      setPreviewBusy(false)
    }
  }, [activeOptions, activeSource, currentWorkspaceId, updateWorkspaceDraft])

  useEffect(() => {
    updateCurrentDraft((draft) => ({
      ...draft,
      exportAssets: [],
      exportSignature: '',
    }))
  }, [activeSignature, updateCurrentDraft])

  const buildExportAssets = useCallback(async () => {
    if (!activeSource) {
      throw new Error('请先导入素材。')
    }

    if (exportSignature === activeSignature && exportAssets.length) {
      return exportAssets
    }

    const targetWorkspaceId = currentWorkspaceId
    const startedAt = performance.now()
    setExportBusy(true)
    setError('')
    setProgress({
      visible: true,
      current: 0,
      total: 1,
      percent: 0,
      label: '生成资源文件',
      phase: 'prepare',
    })

    try {
      const nextAssets = await generateAssets(activeSource, activeOptions, {
        mode: 'export',
        includeDataUrls: false,
        onProgress: (nextProgress) => setProgress({ ...nextProgress, visible: true }),
      })
      const elapsed = Math.round(performance.now() - startedAt)
      updateWorkspaceDraft(targetWorkspaceId, (draft) => ({
        ...draft,
        exportAssets: nextAssets,
        exportSignature: activeSignature,
      }))
      setStatus(`资源文件已生成：${nextAssets.length} 个文件，${elapsed}ms。`)
      return nextAssets
    } finally {
      setExportBusy(false)
      setProgress((current) => ({ ...current, visible: false }))
    }
  }, [
    activeOptions,
    activeSignature,
    activeSource,
    currentWorkspaceId,
    exportAssets,
    exportSignature,
    updateWorkspaceDraft,
  ])

  useEffect(() => {
    if (step !== 2 || !activeSource) {
      return
    }

    buildExportAssets().catch((nextError: unknown) => {
      setError(nextError instanceof Error ? nextError.message : '生成资源文件失败。')
    })
  }, [activeSource, buildExportAssets, step])

  function beginProjectOperation() {
    if (projectBusyRef.current || blockingBusy) {
      return false
    }

    projectBusyRef.current = true
    setProjectBusy(true)
    return true
  }

  function finishProjectOperation() {
    projectBusyRef.current = false
    setProjectBusy(false)
  }

  async function handleSourceUpload(file: File | null) {
    if (!file) {
      return
    }

    const targetWorkspaceId = currentWorkspaceId
    setActionBusy(true)
    setError('')
    setStatus('正在读取素材...')
    setProgress({
      visible: true,
      current: 0,
      total: 1,
      percent: 8,
      label: '读取上传素材',
      phase: 'prepare',
    })
    try {
      const source = await loadSourceImage(file)
      updateWorkspaceDraft(targetWorkspaceId, (draft) => {
        const nextDraft = {
          ...draft,
          step: 1 as StepId,
          previewAssets: [],
          exportAssets: [],
          exportSignature: '',
          writeReport: null,
        }

        if (draft.activeTask === 'ios-launcher') {
          revokeSource(draft.iosSource)
          return {
            ...nextDraft,
            iosSource: source,
          }
        }

        if (draft.activeTask === 'android-notification' && draft.notificationSourceMode === 'custom') {
          revokeSource(draft.notificationSource)
          return {
            ...nextDraft,
            notificationSource: source,
          }
        }

        revokeSource(draft.androidSource)
        return {
          ...nextDraft,
          androidSource: source,
        }
      })
      setStatus(`已读取 ${source.fileName}，尺寸 ${source.width}x${source.height}px。`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '素材读取失败。')
    } finally {
      setActionBusy(false)
      setProgress((current) => ({ ...current, visible: false }))
    }
  }

  async function handlePickProject() {
    if (!beginProjectOperation()) {
      return
    }

    setError('')
    setStatus('请选择要打开的 Flutter 项目目录...')
    try {
      const selected = await pickFlutterProject()
      const nextProjects = upsertProject(projects, selected)
      setProjects(nextProjects)
      const nextProjectId = nextProjects.find((item) => item.root.name === selected.root.name)?.id ?? selected.id
      updateWorkspaceDraft(nextProjectId, (draft) => draft)
      setCurrentProjectId(nextProjectId)
      await saveStoredProjects(nextProjects)
      setStatus(
        selected.supportsWrite
          ? `已打开 ${selected.name}。`
          : `已打开 ${selected.name}，但需要重新授权写入。`,
      )
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '打开项目失败。')
    } finally {
      finishProjectOperation()
    }
  }

  async function handleSelectProject(projectId: string) {
    if (projectId === EXPORT_ONLY_WORKSPACE_ID) {
      setCurrentProjectId('')
      setError('')
      setStatus(`已选择${EXPORT_ONLY_MODE_LABEL}：${EXPORT_ONLY_MODE_HINT}。`)
      return
    }

    const selected = projects.find((item) => item.id === projectId)
    if (!selected) {
      return
    }

    if (!beginProjectOperation()) {
      return
    }

    setError('')
    setStatus(`正在切换到 ${selected.name}...`)
    try {
      const refreshed = await refreshFlutterProject(selected)
      const nextProjects = projects.map((item) => (item.id === refreshed.id ? refreshed : item))
      updateWorkspaceDraft(refreshed.id, (draft) => draft)
      setProjects(nextProjects)
      setCurrentProjectId(refreshed.id)
      await saveStoredProjects(nextProjects)
      setStatus(refreshed.supportsWrite ? `当前项目：${refreshed.name}` : `${refreshed.name} 需要重新授权写入。`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '切换项目失败。')
    } finally {
      finishProjectOperation()
    }
  }

  async function handleRefreshProject(projectId: string) {
    if (projectId === EXPORT_ONLY_WORKSPACE_ID) {
      setCurrentProjectId('')
      setStatus(`已选择${EXPORT_ONLY_MODE_LABEL}：${EXPORT_ONLY_MODE_HINT}。`)
      return
    }

    const selected = projects.find((item) => item.id === projectId)
    if (!selected) {
      return
    }

    if (!beginProjectOperation()) {
      return
    }

    setError('')
    try {
      const refreshed = await refreshFlutterProject(selected)
      const nextProjects = projects.map((item) => (item.id === refreshed.id ? refreshed : item))
      setProjects(nextProjects)
      await saveStoredProjects(nextProjects)
      setStatus(refreshed.supportsWrite ? `${refreshed.name} 已获得写入授权。` : `${refreshed.name} 需要重新授权写入。`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '检查项目权限失败。')
    } finally {
      finishProjectOperation()
    }
  }

  async function handleRemoveProject(projectId: string) {
    const nextProjects = projects.filter((item) => item.id !== projectId)
    setProjects(nextProjects)
    setWorkspaceDrafts((current) => {
      const nextDrafts = { ...current }
      revokeDraftSources(nextDrafts[projectId])
      delete nextDrafts[projectId]
      return nextDrafts
    })
    setCurrentProjectId((current) => {
      if (current !== projectId) {
        return current
      }
      return ''
    })
    try {
      await saveStoredProjects(nextProjects)
      setStatus('项目已从列表移除。')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '保存项目列表失败。')
    }
  }

  async function handleDownloadZip() {
    if (!activeSource) {
      setError('请先导入素材并生成资源。')
      return
    }

    setActionBusy(true)
    setError('')
    try {
      const readyAssets = await buildExportAssets()
      setProgress({
        visible: true,
        current: readyAssets.length,
        total: readyAssets.length,
        percent: 0,
        label: '打包 ZIP',
        phase: 'encode',
      })
      await downloadZip(readyAssets, activeTask, (percent) => {
        setProgress({
          visible: true,
          current: readyAssets.length,
          total: readyAssets.length,
          percent,
          label: '打包 ZIP',
          phase: percent >= 100 ? 'done' : 'encode',
        })
      })
      setStatus('ZIP 已开始下载。')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '下载 ZIP 失败。')
    } finally {
      setActionBusy(false)
      setProgress((current) => ({ ...current, visible: false }))
    }
  }

  async function handleWriteProject() {
    if (!currentProject) {
      setError('请先打开 Flutter 项目，或下载 ZIP 后手动导入。')
      return
    }

    if (!activeSource) {
      setError('请先导入素材并生成资源。')
      return
    }

    setActionBusy(true)
    setError('')
    try {
      const readyAssets = await buildExportAssets()
      const refreshed = await refreshFlutterProject(currentProject)
      const nextProjects = projects.map((item) => (item.id === refreshed.id ? refreshed : item))
      setProjects(nextProjects)
      await saveStoredProjects(nextProjects)
      const report = await writeAssetsToProject(refreshed.root, readyAssets, (current, total, label) => {
        setProgress({
          visible: true,
          current,
          total,
          percent: Math.round((current / total) * 100),
          label: `写入 ${label}`,
          phase: current === total ? 'done' : 'encode',
        })
      })
      updateCurrentDraft((draft) => ({
        ...draft,
        writeReport: report,
      }))
      setStatus(`写入完成：${report.written.length} 个文件，跳过 ${report.skipped.length} 个。`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '写入项目失败。')
    } finally {
      setActionBusy(false)
      setProgress((current) => ({ ...current, visible: false }))
    }
  }

  function updateOptions(patch: Partial<GenerationOptions>) {
    updateCurrentDraft((draft) => ({
      ...draft,
      optionsByTask: {
        ...draft.optionsByTask,
        [draft.activeTask]: {
          ...draft.optionsByTask[draft.activeTask],
          ...patch,
        },
      },
    }))
  }

  function resetTaskOptions() {
    updateCurrentDraft((draft) => ({
      ...draft,
      optionsByTask: {
        ...draft.optionsByTask,
        [draft.activeTask]: {
          ...DEFAULT_OPTIONS,
          taskId: draft.activeTask,
          ...(draft.activeTask === 'android-notification'
            ? {
                backgroundColor: '#00000000',
                scale: 0.74,
                padding: 12,
                monochrome: false,
              }
            : {}),
          ...(draft.activeTask === 'ios-launcher'
            ? {
                backgroundColor: '#ffffff',
                scale: 0.9,
                padding: 0,
                monochrome: false,
              }
            : {}),
        },
      },
    }))
  }

  return (
    <main className={sidebarCollapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <aside className="sidebar" aria-label="应用导航">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((current) => !current)}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        <div className="brand-block">
          <div className="brand-mark">
            <Layers3 size={20} />
          </div>
          <div className="sidebar-label">
            <h1>应用资源生成器</h1>
            <p>Android / iOS / Flutter 资源</p>
          </div>
        </div>

        <ProjectPanel
          projects={projects}
          currentProject={currentProject}
          busy={blockingBusy}
          projectBusy={projectBusy}
          canWrite={canWriteLocalProject()}
          collapsed={sidebarCollapsed}
          exportOnlyActive={!currentProject}
          onAdd={handlePickProject}
          onSelect={handleSelectProject}
          onRefresh={handleRefreshProject}
          onRemove={handleRemoveProject}
        />

        <div className="resource-nav">
          <div className="section-title">
            <Layers3 size={16} />
            <span>资源类型</span>
          </div>
          <nav className="task-tabs" aria-label="资源生成类型">
            {TASKS.map(({ id, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={activeTask === id ? 'active' : ''}
                aria-current={activeTask === id ? 'page' : undefined}
                title={TASK_COPY[id].label}
                onClick={() => {
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    activeTask: id,
                    step: 0,
                    writeReport: null,
                  }))
                  setError('')
                }}
              >
                <Icon size={18} />
                <span className="sidebar-label">{TASK_COPY[id].label}</span>
                {activeTask === id ? <CheckCircle2 className="selected-mark" size={15} /> : null}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">资源生成</p>
            <h2>{currentCopy.label}</h2>
          </div>
          <div className="workspace-status" aria-live="polite">
            <div className={blockingBusy ? 'status-pill active' : 'status-pill'}>
              {blockingBusy ? (
                <CircularProgress percent={progress.percent} size={26} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              <span>{blockingBusy ? `${progress.percent}%` : visibleAssetCount ? `${visibleAssetCount} 个文件` : '待导入素材'}</span>
            </div>
            <div className={error ? 'workspace-status-detail error' : 'workspace-status-detail'}>
              {error ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
              <span>{statusDetail}</span>
            </div>
          </div>
        </header>

        <ProcessingBanner visible={blockingBusy && progress.visible} progress={progress} />

        <div className="stepper" role="tablist" aria-label="生成步骤">
          {STEPS.map((item, index) => {
            const Icon = item.icon
            const active = step === index
            const disabled = index > 0 && !sourceReady
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-current={active ? 'step' : undefined}
                disabled={disabled}
                key={item.title}
                className={active ? 'active' : ''}
                onClick={() => {
                  if (disabled) {
                    setError('请先导入素材。')
                    return
                  }
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: index as StepId,
                  }))
                }}
              >
                <Icon size={16} />
                <span>{item.title}</span>
                <strong>{item.label}</strong>
              </button>
            )
          })}
        </div>

        <div className="content-grid">
          <section className="tool-panel">
            {step === 0 ? (
              <UploadStep
                task={activeTask}
                source={activeSource}
                notificationSourceMode={notificationSourceMode}
                hasAppIconSource={Boolean(androidSource)}
                onNotificationSourceModeChange={(mode) =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    notificationSourceMode: mode,
                    previewAssets: [],
                    exportAssets: [],
                    exportSignature: '',
                  }))
                }
                onFile={handleSourceUpload}
                onNext={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 1,
                  }))
                }
              />
            ) : null}

            {step === 1 ? (
              <TuningStep
                task={activeTask}
                options={activeOptions}
                onChange={updateOptions}
                onReset={resetTaskOptions}
                onNext={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 2,
                  }))
                }
              />
            ) : null}

            {step === 2 ? (
              <ExportStep
                task={activeTask}
                assets={exportAssets}
                project={currentProject}
                exportOnly={!currentProject}
                busy={blockingBusy}
                onDownload={handleDownloadZip}
                onWrite={handleWriteProject}
                onBack={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 1,
                  }))
                }
              />
            ) : null}
          </section>

          <PreviewPanel
            task={activeTask}
            source={activeSource}
            assets={previewAssets}
            options={activeOptions}
            groupedAssets={groupedAssets}
            busy={previewBusy}
          />
        </div>

      </section>
    </main>
  )
}

function ProjectPanel({
  projects,
  currentProject,
  busy,
  projectBusy,
  canWrite,
  collapsed,
  exportOnlyActive,
  onAdd,
  onSelect,
  onRefresh,
  onRemove,
}: {
  projects: ProjectHandle[]
  currentProject: ProjectHandle | null
  busy: boolean
  projectBusy: boolean
  canWrite: boolean
  collapsed: boolean
  exportOnlyActive: boolean
  onAdd: () => void
  onSelect: (projectId: string) => void
  onRefresh: (projectId: string) => void
  onRemove: (projectId: string) => void
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const projectSelectorRef = useRef<HTMLDivElement>(null)
  const projectStatus = projectBusy
    ? '正在处理项目...'
    : currentProject
      ? currentProject.supportsWrite
        ? '已授权写入'
        : '需要重新授权写入'
      : EXPORT_ONLY_MODE_HINT

  useEffect(() => {
    if (collapsed) {
      setProjectMenuOpen(false)
    }
  }, [collapsed])

  useEffect(() => {
    if (!projectMenuOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!projectSelectorRef.current?.contains(event.target as Node)) {
        setProjectMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setProjectMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [projectMenuOpen])

  function selectProject(projectId: string) {
    setProjectMenuOpen(false)
    onSelect(projectId)
  }

  function refreshProject(projectId: string) {
    setProjectMenuOpen(false)
    onRefresh(projectId)
  }

  function removeProject(projectId: string) {
    setProjectMenuOpen(false)
    onRemove(projectId)
  }

  function openProjectMenu() {
    if (!busy && !projectBusy) {
      setProjectMenuOpen(true)
    }
  }

  function closeProjectMenu() {
    setProjectMenuOpen(false)
  }

  function handleCompactProjectBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      closeProjectMenu()
    }
  }

  function renderProjectMenu(compact = false) {
    return (
      <div
        className={compact ? 'project-menu compact-project-menu' : 'project-menu'}
        aria-label="选择 Flutter 项目"
      >
        <div className="project-list project-menu-list" aria-label="项目选项">
          <div className={exportOnlyActive ? 'project-row active export-only-row' : 'project-row export-only-row'}>
            <button
              type="button"
              className="project-switch"
              onClick={() => selectProject(EXPORT_ONLY_WORKSPACE_ID)}
              disabled={busy || projectBusy}
              title={`${EXPORT_ONLY_MODE_LABEL}：${EXPORT_ONLY_MODE_HINT}`}
            >
              <span>
                {EXPORT_ONLY_MODE_LABEL}
                {exportOnlyActive ? <CheckCircle2 className="project-selected" size={14} /> : null}
              </span>
              <small>{exportOnlyActive ? '当前模式' : EXPORT_ONLY_MODE_HINT}</small>
            </button>
          </div>

          {projects.length ? (
            projects.map((project) => {
              const active = currentProject?.id === project.id
              return (
                <div className={active ? 'project-row active' : 'project-row'} key={project.id}>
                  <button
                    type="button"
                    className="project-switch"
                    onClick={() => selectProject(project.id)}
                    disabled={busy || projectBusy}
                    title={`切换到 ${project.name}`}
                  >
                    <span>
                      {project.name}
                      {active ? <CheckCircle2 className="project-selected" size={14} /> : null}
                    </span>
                    <small>{active ? '当前项目' : project.supportsWrite ? '可写入' : '需授权写入'}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => refreshProject(project.id)}
                    disabled={busy || projectBusy}
                    title="重新授权并检查项目目录"
                  >
                    <RotateCcw size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => removeProject(project.id)}
                    disabled={busy || projectBusy}
                    title="从列表移除"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )
            })
          ) : (
            <p className="muted">还没有打开过 Flutter 项目。</p>
          )}
        </div>
      </div>
    )
  }

  if (collapsed) {
    return (
      <div
        className="project-box compact-project-box"
        ref={projectSelectorRef}
        onPointerLeave={closeProjectMenu}
        onMouseLeave={closeProjectMenu}
        onBlur={handleCompactProjectBlur}
      >
        <div className="compact-group-title" title="Flutter 项目">
          <FolderOpen size={14} />
        </div>
        <div className="compact-project-actions" aria-label="Flutter 项目快捷操作">
          <button
            type="button"
            className={projectMenuOpen ? 'compact-project active project-switcher' : 'compact-project project-switcher'}
            onPointerEnter={openProjectMenu}
            onPointerMove={openProjectMenu}
            onMouseEnter={openProjectMenu}
            onMouseMove={openProjectMenu}
            onFocus={openProjectMenu}
            onClick={openProjectMenu}
            disabled={busy || projectBusy}
            title={`切换项目：${currentProject?.name ?? EXPORT_ONLY_MODE_LABEL}`}
            aria-label="切换 Flutter 项目"
            aria-expanded={projectMenuOpen}
            aria-haspopup="menu"
          >
            <ChevronsUpDown size={17} />
          </button>

          {projectMenuOpen ? renderProjectMenu(true) : null}

          <button
            type="button"
            className="compact-project add-project"
            onClick={onAdd}
            disabled={!canWrite || busy || projectBusy}
            title={
              canWrite
                ? '打开 Flutter 项目'
                : '当前浏览器不支持选择本地目录'
            }
            aria-label="打开 Flutter 项目"
          >
            {projectBusy ? <Loader2 className="spin" size={18} /> : <FolderOpen size={18} />}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="project-box">
      <div className="project-header">
        <div className="section-title">
          <FolderOpen size={16} />
          <span>Flutter 项目</span>
        </div>
        <button
          type="button"
          className="primary-button project-open-button"
          onClick={onAdd}
          disabled={!canWrite || busy || projectBusy}
          title={canWrite ? '打开 Flutter 项目根目录' : '当前浏览器不支持选择本地目录'}
        >
          <FolderOpen size={14} />
          打开项目
        </button>
      </div>

      <div
        className={currentProject ? 'current-project ready' : 'current-project'}
        ref={projectSelectorRef}
      >
        <button
          type="button"
          className="current-project-trigger"
          onClick={() => setProjectMenuOpen((current) => !current)}
          aria-expanded={projectMenuOpen}
          aria-haspopup="menu"
          disabled={busy || projectBusy}
        >
          <span className="project-kicker">{currentProject ? '当前项目' : '项目状态'}</span>
          <span className="project-trigger-main">
            <strong>{currentProject?.name ?? EXPORT_ONLY_MODE_LABEL}</strong>
            <ChevronsUpDown size={15} />
          </span>
          <small>{projectStatus}</small>
        </button>

        {projectMenuOpen ? renderProjectMenu() : null}
      </div>

      {currentProject?.issues.length ? (
        <div className="issue-list">
          {currentProject.issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CircularProgress({ percent, size }: { percent: number; size: number }) {
  const stroke = 3
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (Math.max(0, Math.min(100, percent)) / 100) * circumference

  return (
    <svg className="circular-progress" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        className="track"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
      />
      <circle
        className="value"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
    </svg>
  )
}

function ProcessingBanner({
  visible,
  progress,
}: {
  visible: boolean
  progress: ProgressUi
}) {
  return (
    <div
      className={visible ? 'processing-banner visible' : 'processing-banner'}
      role={visible ? 'status' : undefined}
      aria-hidden={!visible}
      aria-live={visible ? 'polite' : undefined}
    >
      <div className="processing-copy">
        <Loader2 className="spin" size={16} />
        <span>{progress.label || '处理中'}</span>
        <strong>
          {progress.current}/{progress.total || 1}
        </strong>
      </div>
      <div className="progress-bar" aria-label={`进度 ${progress.percent}%`}>
        <span style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  )
}

function UploadStep({
  task,
  source,
  notificationSourceMode,
  hasAppIconSource,
  onNotificationSourceModeChange,
  onFile,
  onNext,
}: {
  task: TaskId
  source: SourceImage | null
  notificationSourceMode: NotificationSourceMode
  hasAppIconSource: boolean
  onNotificationSourceModeChange: (mode: NotificationSourceMode) => void
  onFile: (file: File | null) => void
  onNext: () => void
}) {
  const copy = TASK_COPY[task]
  const isNotification = task === 'android-notification'
  const uploadLabel = isNotification
    ? notificationSourceMode === 'app'
      ? hasAppIconSource
        ? '替换应用图标素材'
        : '选择应用图标素材'
      : '选择通知专用素材'
    : '选择图片素材'

  return (
    <div className="step-content">
      <div className="panel-heading">
        <div>
          <h3>导入素材</h3>
          <p>{copy.sourceHint}</p>
        </div>
        <ImageIcon size={22} />
      </div>

      {isNotification ? (
        <div className="segmented-control" data-mode={notificationSourceMode} aria-label="通知图标来源">
          <span className="segmented-thumb" aria-hidden="true" />
          <button
            type="button"
            className={notificationSourceMode === 'app' ? 'active' : ''}
            aria-pressed={notificationSourceMode === 'app'}
            onClick={() => onNotificationSourceModeChange('app')}
          >
            从应用图标生成
          </button>
          <button
            type="button"
            className={notificationSourceMode === 'custom' ? 'active' : ''}
            aria-pressed={notificationSourceMode === 'custom'}
            onClick={() => onNotificationSourceModeChange('custom')}
          >
            上传通知专用素材
          </button>
        </div>
      ) : null}

      {isNotification ? (
        <div className="inline-hint">
          <AlertCircle size={16} />
          <span>
            {notificationSourceMode === 'app'
              ? hasAppIconSource
                ? '将复用当前 Android 应用图标素材，自动移除启动图标底色，生成通知小图标。'
                : '请先上传 Android 应用图标素材，或切换为通知专用素材。'
              : '请上传透明背景的单色或高对比图形；生成结果会转换为白色 alpha 蒙版。'}
          </span>
        </div>
      ) : null}

      <label className="drop-zone">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={(event) => {
            onFile(event.target.files?.[0] ?? null)
            event.currentTarget.value = ''
          }}
        />
        <Upload size={26} />
        <span>{uploadLabel}</span>
        <small>PNG / WebP / JPEG / SVG</small>
        <div className="drop-zone-privacy">
          <CheckCircle2 size={14} />
          <small>本地处理，不上传素材</small>
        </div>
      </label>

      {source ? (
        <div className="source-summary">
          <img src={source.objectUrl} alt="" />
          <div>
            <strong>{source.fileName}</strong>
            <p>
              {source.width}x{source.height}px
              {source.width < 1024 || source.height < 1024 ? '，建议使用 1024x1024 或更大素材。' : ''}
            </p>
            {isNotification ? (
              <p>
                素材来源：
                {notificationSourceMode === 'app' ? 'Android 应用图标' : '通知专用素材'}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <RequirementBox task={task} />

      <div className="step-actions">
        <button type="button" className="secondary-button" onClick={onNext} disabled={!source}>
          下一步
        </button>
      </div>
    </div>
  )
}

function TuningStep({
  task,
  options,
  onChange,
  onReset,
  onNext,
}: {
  task: TaskId
  options: GenerationOptions
  onChange: (patch: Partial<GenerationOptions>) => void
  onReset: () => void
  onNext: () => void
}) {
  return (
    <div className="step-content">
      <div className="panel-heading">
        <div>
          <h3>调整生成参数</h3>
          <p>参数会实时更新右侧预览，并影响最终输出。</p>
        </div>
        <PaintBucket size={22} />
      </div>

      {task !== 'android-notification' ? (
        <label className="control-row">
          <span>背景色</span>
          <input
            type="color"
            value={options.backgroundColor.length === 7 ? options.backgroundColor : '#ffffff'}
            onChange={(event) => onChange({ backgroundColor: event.target.value })}
          />
        </label>
      ) : null}

      <label className="control-row">
        <span>缩放</span>
        <input
          type="range"
          min="0.45"
          max="1.25"
          step="0.01"
          value={options.scale}
          onChange={(event) => onChange({ scale: Number(event.target.value) })}
        />
        <strong>{Math.round(options.scale * 100)}%</strong>
      </label>

      <label className="control-row">
        <span>边距</span>
        <input
          type="range"
          min="-10"
          max="50"
          step="1"
          value={options.padding}
          onChange={(event) => onChange({ padding: Number(event.target.value) })}
        />
        <strong>{options.padding}%</strong>
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={options.trim}
          onChange={(event) => onChange({ trim: event.target.checked })}
        />
        <span>自动裁剪透明边缘</span>
      </label>

      {task === 'android-launcher' ? (
        <>
          <label className="control-row">
            <span>自适应图标前景</span>
            <input
              type="range"
              min="48"
              max="92"
              step="1"
              value={options.foregroundPercent}
              onChange={(event) => onChange({ foregroundPercent: Number(event.target.value) })}
            />
            <strong>{options.foregroundPercent}%</strong>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={options.monochrome}
              onChange={(event) => onChange({ monochrome: event.target.checked })}
            />
            <span>同时生成主题图标单色层</span>
          </label>
        </>
      ) : null}

      <div className="step-actions">
        <button type="button" className="ghost-button" onClick={onReset}>
          <RotateCcw size={16} />
          重置
        </button>
        <button type="button" className="secondary-button" onClick={onNext}>
          下一步
        </button>
      </div>
    </div>
  )
}

function ExportStep({
  task,
  assets,
  project,
  exportOnly,
  busy,
  onDownload,
  onWrite,
  onBack,
}: {
  task: TaskId
  assets: GeneratedAsset[]
  project: ProjectHandle | null
  exportOnly: boolean
  busy: boolean
  onDownload: () => void
  onWrite: () => void
  onBack: () => void
}) {
  const [showAllPaths, setShowAllPaths] = useState(false)
  const pathLimit = 9
  const hasMorePaths = assets.length > pathLimit
  const visibleAssets = showAllPaths ? assets : assets.slice(0, pathLimit)

  useEffect(() => {
    setShowAllPaths(false)
  }, [assets, task])

  return (
    <div className="step-content">
      <div className="panel-heading">
        <div>
          <h3>{exportOnly ? '导出 ZIP' : '导出与写入'}</h3>
          <p>
            {exportOnly
              ? '生成结果会打包为 ZIP 文件，可下载后自行使用。'
              : `可写入 ${TASK_COPY[task].outputRoot}，也可以下载 ZIP 后手动导入。`}
          </p>
        </div>
        <Download size={22} />
      </div>

      <div className="file-summary">
        <strong>{assets.length}</strong>
        <span>待输出文件</span>
      </div>

      <div className={showAllPaths ? 'path-list expanded' : 'path-list'}>
        {assets.length ? (
          <>
            {visibleAssets.map((asset) => (
              <p key={asset.path}>{asset.path}</p>
            ))}
            {hasMorePaths ? (
              <button
                type="button"
                className="path-expand-button"
                aria-expanded={showAllPaths}
                onClick={() => setShowAllPaths((current) => !current)}
              >
                {showAllPaths ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {showAllPaths ? '收起列表' : `查看全部（另有 ${assets.length - pathLimit} 个）`}
              </button>
            ) : null}
          </>
        ) : (
          <p>{busy ? '正在生成资源文件...' : '暂无输出文件，请先导入素材。'}</p>
        )}
      </div>

      <div className="step-actions split">
        <button type="button" className="ghost-button" onClick={onBack}>
          返回参数
        </button>
        <div>
          <button
            type="button"
            className={exportOnly ? 'primary-button' : 'secondary-button'}
            onClick={onDownload}
            disabled={!assets.length || busy}
          >
            <Download size={16} />
            下载 ZIP
          </button>
          {exportOnly ? null : (
            <button
              type="button"
              className="primary-button"
              onClick={onWrite}
              disabled={!assets.length || !project || busy}
              title="写入当前 Flutter 项目"
            >
              <FolderOpen size={16} />
              写入项目
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewPanel({
  task,
  source,
  assets,
  options,
  groupedAssets,
  busy,
}: {
  task: TaskId
  source: SourceImage | null
  assets: GeneratedAsset[]
  options: GenerationOptions
  groupedAssets: Array<[string, GeneratedAsset[]]>
  busy: boolean
}) {
  const imageAssets = assets.filter((asset) => asset.dataUrl)
  const androidForeground = imageAssets.find((asset) => asset.path.includes('drawable-xxxhdpi/ic_launcher_foreground'))
  const largest = [...imageAssets].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]

  return (
    <aside className="preview-panel">
      <div className="preview-header">
        <div>
          <p className="eyebrow">实时预览</p>
          <h3>{TASK_COPY[task].shortLabel}</h3>
        </div>
        <span className={busy ? 'preview-state loading' : 'preview-state'}>
          {busy ? <Loader2 className="spin" size={13} /> : null}
          {busy ? '更新中' : source ? `${source.width}x${source.height}` : '未导入素材'}
        </span>
      </div>

      {!source ? (
        <div className="empty-preview">
          <ImageIcon size={42} />
          <p>导入素材后显示生成效果。</p>
        </div>
      ) : null}

      {source && task === 'android-launcher' ? (
        <div className="preview-section">
          <p className="preview-title">自适应图标遮罩预览</p>
          <div className="adaptive-grid">
            {['circle', 'squircle', 'rounded', 'square'].map((shape) => (
              <div className={`adaptive-icon ${shape}`} key={shape} style={{ backgroundColor: options.backgroundColor }}>
                {androidForeground ? <img src={androidForeground.dataUrl} alt="" /> : null}
              </div>
            ))}
          </div>
          <DensityTable />
        </div>
      ) : null}

      {source && task === 'android-notification' ? (
        <div className="preview-section">
          <p className="preview-title">状态栏 / 通知栏预览</p>
          <div className="phone-preview">
            <div className="phone-status">
              {largest ? (
                <span className="notification-icon-surface status-icon">
                  <img src={largest.dataUrl} alt="" />
                </span>
              ) : null}
              <span>09:41</span>
              <span>LTE</span>
            </div>
            <div className="notification-row">
              {largest ? (
                <span className="notification-icon-surface notification-icon-large">
                  <img src={largest.dataUrl} alt="" />
                </span>
              ) : null}
              <div>
                <strong>应用通知</strong>
                <p>通知小图标使用白色 alpha 蒙版。</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {source && task === 'ios-launcher' ? (
        <div className="preview-section">
          <p className="preview-title">iOS 主屏预览</p>
          <div className="ios-grid-preview">
            {imageAssets.slice(-5).map((asset) => (
              <div className="ios-debug-tile" key={asset.path} title="外框为源图边界，圆角为 iOS 系统蒙版近似预览">
                <div className="ios-tile-mask">
                  <img src={asset.dataUrl} alt="" />
                  <span className="ios-safe-guide" aria-hidden="true" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {groupedAssets.length ? (
        <div className="asset-groups">
          {groupedAssets.map(([group, groupAssets]) => (
            <div className="asset-group" key={group}>
              <div className="asset-group-head">
                <strong>{group}</strong>
                <span>{groupAssets.length}</span>
              </div>
              <div className="asset-grid">
                {groupAssets.slice(0, 10).map((asset) => (
                  <div
                    className={task === 'android-notification' ? 'asset-cell notification-asset-cell' : 'asset-cell'}
                    key={asset.path}
                    title={asset.path}
                  >
                    <div className="asset-icon-preview">
                      {asset.dataUrl ? <img src={asset.dataUrl} alt="" /> : <Info size={18} />}
                    </div>
                    <span>{asset.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  )
}

function RequirementBox({ task }: { task: TaskId }) {
  const notes = TASK_COPY[task].officialNotes
  return (
    <div className="requirement-box">
      <div className="section-title">
        <Info size={16} />
        <span>官方素材要求</span>
      </div>
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {task === 'ios-launcher' ? (
        <p>Xcode 支持从 1024x1024 单尺寸图标派生；本工具同时生成传统全尺寸 AppIcon 资源。</p>
      ) : null}
      {task === 'android-notification' ? (
        <p>可从应用图标派生 alpha 蒙版；工具会尝试识别边缘底色，复杂背景仍建议上传通知专用素材。</p>
      ) : null}
    </div>
  )
}

function DensityTable() {
  return (
    <div className="density-table">
      {ANDROID_DENSITIES.map((item) => (
        <div key={item.density}>
          <span>{item.density}</span>
          <strong>{item.legacyLauncherPx}px</strong>
        </div>
      ))}
    </div>
  )
}

export default App
