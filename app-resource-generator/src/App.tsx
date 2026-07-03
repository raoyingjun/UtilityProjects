import { type DragEvent, type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { formatSimulatorDate } from './lib/dateFormat'
import { TASK_COPY, type TaskId } from './lib/iconSpecs'
import { DeviceSimulator } from './components/DeviceSimulator'
import {
  generateAssets,
  isSupportedImageFile,
  loadSourceImage,
  type GeneratedAsset,
  type GenerationProgress,
  type GenerationOptions,
  type SourceImage,
} from './lib/imageTools'
import {
  assignGenerationOption,
  buildSourceFixPlan,
  isFixableItem,
  type SourceFixPlan,
  type SourceFixItem,
  type SourceFixKind,
} from './lib/sourceDiagnostics'
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

type StepId = 0 | 1 | 2 | 3
type NotificationSourceMode = 'app' | 'custom'

type ProgressUi = GenerationProgress & {
  visible: boolean
}

type WorkspaceDraft = {
  activeTask: TaskId
  step: StepId
  androidSource: SourceImage | null
  notificationAppSource: SourceImage | null
  notificationCustomSource: SourceImage | null
  notificationSourceMode: NotificationSourceMode
  iosSource: SourceImage | null
  optionsByTask: Record<TaskId, GenerationOptions>
  appliedFixes: AppliedFixRecord[]
  previewAssets: GeneratedAsset[]
  exportAssets: GeneratedAsset[]
  exportSignature: string
  writeReport: WriteReport | null
}

type AppliedFixRecord = {
  id: string
  task: TaskId
  sourceKey: string
  title: string
  detail: string
  label: string
  before: Partial<GenerationOptions>
  after: Partial<GenerationOptions>
}

type BrowserSupport = {
  blockers: string[]
  browserName: string
}

type ChromeLaunchPlan = {
  url: string
  label: string
}

type UnsupportedActionState = 'idle' | 'opening' | 'copied' | 'launch-failed-copied'

const EXPORT_ONLY_WORKSPACE_ID = 'export-only'
const EXPORT_ONLY_MODE_LABEL = '仅导出模式'
const EXPORT_ONLY_MODE_HINT = '下载 ZIP，不写入 Flutter 项目'
const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/'

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
  enhanceLowResolution: false,
  normalizeOutputFormat: false,
  preserveTransparentLayers: false,
  notificationAlphaMask: false,
  removeSolidBackground: false,
  flattenTransparency: false,
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

function getEffectiveGenerationOptions(
  task: TaskId,
  options: GenerationOptions,
  notificationSourceMode: NotificationSourceMode,
): GenerationOptions {
  if (task === 'android-launcher') {
    return {
      ...options,
      preserveTransparentLayers: true,
    }
  }

  if (task === 'ios-launcher') {
    return {
      ...options,
      backgroundColor: options.backgroundColor === '#00000000' ? '#ffffff' : options.backgroundColor,
      flattenTransparency: true,
    }
  }

  if (task !== 'android-notification') {
    return options
  }

  return {
    ...options,
    backgroundColor: '#00000000',
    trim: true,
    notificationAlphaMask: true,
    removeSolidBackground: notificationSourceMode === 'app' ? true : options.removeSolidBackground,
  }
}

function createDefaultWorkspaceDraft(): WorkspaceDraft {
  return {
    activeTask: 'android-launcher',
    step: 0,
    androidSource: null,
    notificationAppSource: null,
    notificationCustomSource: null,
    notificationSourceMode: 'custom',
    iosSource: null,
    optionsByTask: createDefaultOptionsByTask(),
    appliedFixes: [],
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
  for (const source of [
    draft.androidSource,
    draft.notificationAppSource,
    draft.notificationCustomSource,
    draft.iosSource,
  ]) {
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
    title: '01',
    label: '导入素材',
    detail: '源图与来源',
    icon: Upload,
  },
  {
    title: '02',
    label: '智能修正',
    detail: '质量与风险',
    icon: Wand2,
  },
  {
    title: '03',
    label: '调整参数',
    detail: '尺寸与安全区',
    icon: PaintBucket,
  },
  {
    title: '04',
    label: '导出写入',
    detail: '文件与项目',
    icon: Download,
  },
] as const

function App() {
  const browserSupport = detectBrowserSupport()

  if (browserSupport.blockers.length) {
    return <UnsupportedBrowserPage support={browserSupport} />
  }

  return <ResourceGeneratorApp />
}

// 只有无法本地生成资源时才整页阻断；仅缺目录写入能力时降级为仅导出模式。
function detectBrowserSupport(): BrowserSupport {
  const blockers: string[] = []

  if (typeof window.createImageBitmap !== 'function') {
    blockers.push('不支持本地图像解码')
  }

  if (!window.isSecureContext) {
    blockers.push('当前访问环境不是安全上下文（需要 HTTPS 或 localhost）')
  }

  return {
    blockers,
    browserName: detectBrowserName(window.navigator.userAgent),
  }
}

function detectBrowserName(userAgent: string): string {
  if (/Edg\//.test(userAgent)) {
    return 'Microsoft Edge'
  }

  if (/OPR\//.test(userAgent)) {
    return 'Opera'
  }

  if (/Firefox\//.test(userAgent)) {
    return 'Firefox'
  }

  if (/Chrome\//.test(userAgent) && !/Chromium\//.test(userAgent)) {
    return 'Chrome'
  }

  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) {
    return 'Safari'
  }

  return '当前浏览器'
}

function UnsupportedBrowserPage({ support }: { support: BrowserSupport }) {
  const [actionState, setActionState] = useState<UnsupportedActionState>('idle')
  const currentUrl = window.location.href
  const chromeLaunchPlan = getChromeLaunchPlan(currentUrl, support.browserName)
  const primaryActionLabel =
    actionState === 'opening'
      ? '正在尝试打开'
      : actionState === 'copied'
        ? '已复制地址'
        : actionState === 'launch-failed-copied'
          ? '未打开，地址已复制'
          : chromeLaunchPlan?.label ?? '复制当前地址'

  async function copyCurrentUrl(updateState = true): Promise<boolean> {
    try {
      if (!window.navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable')
      }

      await window.navigator.clipboard.writeText(currentUrl)
      if (updateState) {
        setActionState('copied')
        window.setTimeout(() => setActionState('idle'), 1800)
      }
      return true
    } catch {
      window.prompt('复制这个地址后，在 Chrome 地址栏访问：', currentUrl)
      setActionState('idle')
      return false
    }
  }

  async function handlePrimaryAction() {
    if (!chromeLaunchPlan) {
      await copyCurrentUrl()
      return
    }

    if (actionState === 'opening') {
      return
    }

    let leftPage = false
    const markLeftPage = () => {
      leftPage = true
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markLeftPage()
      }
    }

    setActionState('opening')
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', markLeftPage, { once: true })
    const copiedBeforeLaunch = await copyCurrentUrl(false)
    window.location.href = chromeLaunchPlan.url

    window.setTimeout(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', markLeftPage)

      if (!leftPage && document.visibilityState === 'visible') {
        if (copiedBeforeLaunch) {
          setActionState('launch-failed-copied')
        } else {
          setActionState('idle')
        }
      }
    }, 1600)
  }

  return (
    <main className="unsupported-shell">
      <section className="unsupported-panel" aria-labelledby="unsupported-title">
        <div className="unsupported-mark">
          <MonitorSmartphone size={28} />
        </div>

        <div className="unsupported-copy">
          <p className="eyebrow">浏览器不支持</p>
          <h1 id="unsupported-title">请使用 Chrome 打开应用资源生成器</h1>
          <p>
            当前使用的是 {support.browserName}，缺少在本地生成图像资源所需的浏览器能力。
            为避免生成界面无法正常工作，请改用桌面版 Chrome 后再访问当前页面。
          </p>
        </div>

        <div className="unsupported-actions">
          <button type="button" className="primary-button" onClick={handlePrimaryAction}>
            <FolderOpen size={16} />
            {primaryActionLabel}
          </button>
          <a className="secondary-button" href={CHROME_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            <Download size={16} />
            下载 Chrome
          </a>
        </div>

        <div className="unsupported-url" aria-label="当前页面地址">
          {currentUrl}
        </div>

        <div className="unsupported-steps" aria-label="打开方式">
          <div>
            <strong>1. 打开 Chrome</strong>
            <span>使用桌面版 Chrome 或兼容的 Chromium 浏览器。</span>
          </div>
          <div>
            <strong>2. 访问当前地址</strong>
            <span>把上方地址粘贴到 Chrome 地址栏并进入。</span>
          </div>
          <div>
            <strong>3. 打开项目</strong>
            <span>授权选择 Flutter 项目目录后再生成资源。</span>
          </div>
        </div>

        <div className="unsupported-reasons">
          <AlertCircle size={16} />
          <span>{support.blockers.join('、')}</span>
        </div>
      </section>
    </main>
  )
}

function getChromeLaunchPlan(targetUrl: string, browserName: string): ChromeLaunchPlan | null {
  if (browserName === 'Chrome') {
    return null
  }

  const userAgent = window.navigator.userAgent

  if (/Android/i.test(userAgent)) {
    return {
      url: makeAndroidChromeIntentUrl(targetUrl),
      label: '用 Chrome 打开',
    }
  }

  if (/iPad|iPhone|iPod/i.test(userAgent)) {
    return {
      url: makeIosChromeUrl(targetUrl),
      label: '尝试用 Chrome 打开',
    }
  }

  return {
    url: makeDesktopChromeUrl(targetUrl),
    label: '尝试用 Chrome 打开',
  }
}

function makeAndroidChromeIntentUrl(targetUrl: string): string {
  try {
    const url = new URL(targetUrl)
    return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=${url.protocol.replace(
      ':',
      '',
    )};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(CHROME_DOWNLOAD_URL)};end`
  } catch {
    return CHROME_DOWNLOAD_URL
  }
}

function makeIosChromeUrl(targetUrl: string): string {
  if (targetUrl.startsWith('https://')) {
    return targetUrl.replace(/^https:\/\//, 'googlechromes://')
  }

  if (targetUrl.startsWith('http://')) {
    return targetUrl.replace(/^http:\/\//, 'googlechrome://')
  }

  return `googlechrome://navigate?url=${encodeURIComponent(targetUrl)}`
}

function makeDesktopChromeUrl(targetUrl: string): string {
  return `googlechrome://navigate?url=${encodeURIComponent(targetUrl)}`
}

function ResourceGeneratorApp() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [writeNoticeDismissed, setWriteNoticeDismissed] = useState(false)
  const writeSupported = canWriteLocalProject()
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
    notificationAppSource,
    notificationCustomSource,
    notificationSourceMode,
    iosSource,
    optionsByTask,
    appliedFixes,
    previewAssets,
    exportAssets,
    exportSignature,
    writeReport,
  } = currentDraft
  const currentCopy = TASK_COPY[activeTask]
  const activeSource =
    activeTask === 'ios-launcher'
      ? iosSource
      : activeTask === 'android-notification'
        ? notificationSourceMode === 'app'
          ? notificationAppSource
          : notificationCustomSource
        : androidSource
  const notificationPreviewAppSource =
    activeTask === 'android-notification'
      ? notificationSourceMode === 'app'
        ? notificationAppSource
        : androidSource ?? notificationAppSource
      : null
  const activeOptions = optionsByTask[activeTask]
  const generationOptions = useMemo(
    () => getEffectiveGenerationOptions(activeTask, activeOptions, notificationSourceMode),
    [activeOptions, activeTask, notificationSourceMode],
  )
  const activeSourceKey = activeSource?.objectUrl ?? ''
  const blockingBusy = exportBusy || actionBusy
  const visibleAssetCount = step === 3 ? exportAssets.length : previewAssets.length
  const sourceReady = Boolean(activeSource)
  const statusDetail = error
    ? error
    : writeReport
      ? `写入 ${writeReport.written.length} 个，跳过 ${writeReport.skipped.length} 个`
      : status || ''

  const activeSignature = useMemo(() => {
    if (!activeSource) {
      return ''
    }

    return [
      activeTask,
      notificationSourceMode,
      activeSource.objectUrl,
      generationOptions.backgroundColor,
      generationOptions.scale,
      generationOptions.trim,
      generationOptions.padding,
      generationOptions.foregroundPercent,
      generationOptions.monochrome,
      generationOptions.enhanceLowResolution,
      generationOptions.normalizeOutputFormat,
      generationOptions.preserveTransparentLayers,
      generationOptions.notificationAlphaMask,
      generationOptions.removeSolidBackground,
      generationOptions.flattenTransparency,
    ].join('|')
  }, [activeSource, activeTask, generationOptions, notificationSourceMode])

  const groupedAssets = useMemo(() => {
    const groups = new Map<string, GeneratedAsset[]>()
    for (const asset of previewAssets) {
      const current = groups.get(asset.group) ?? []
      current.push(asset)
      groups.set(asset.group, current)
    }
    return [...groups.entries()]
  }, [previewAssets])

  const activeFixPlan = useMemo(
    () =>
      activeSource
        ? buildSourceFixPlan({
            task: activeTask,
            source: activeSource,
            options: generationOptions,
            notificationSourceMode,
          })
        : null,
    [activeSource, activeTask, generationOptions, notificationSourceMode],
  )
  const activeAppliedFixes = useMemo(
    () =>
      appliedFixes.filter(
        (fix) => fix.task === activeTask && fix.sourceKey === activeSourceKey,
      ),
    [appliedFixes, activeSourceKey, activeTask],
  )

  const updateWorkspaceDraft = useCallback(
    (workspaceId: string, updater: (draft: WorkspaceDraft) => WorkspaceDraft) => {
      setWorkspaceDrafts((current) => {
        const previousDraft = current[workspaceId] ?? createDefaultWorkspaceDraft()
        const nextDraft = updater(previousDraft)
        if (nextDraft === previousDraft && current[workspaceId]) {
          return current
        }
        return {
          ...current,
          [workspaceId]: nextDraft,
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

      generateAssets(activeSource, generationOptions, {
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
  }, [activeSource, currentWorkspaceId, generationOptions, updateWorkspaceDraft])

  useEffect(() => {
    updateCurrentDraft((draft) => {
      // 只有已生成的导出结果与当前参数签名不一致时才失效，避免切换任务/项目误清缓存。
      if (!draft.exportSignature || draft.exportSignature === activeSignature) {
        return draft
      }
      return {
        ...draft,
        exportAssets: [],
        exportSignature: '',
      }
    })
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
      const nextAssets = await generateAssets(activeSource, generationOptions, {
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
    activeSignature,
    activeSource,
    currentWorkspaceId,
    exportAssets,
    exportSignature,
    generationOptions,
    updateWorkspaceDraft,
  ])

  useEffect(() => {
    if (step !== 3 || !activeSource) {
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

    if (!isSupportedImageFile(file)) {
      setError(`不支持的素材格式：${file.name}。请使用 PNG / WebP / JPEG / SVG。`)
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
          appliedFixes: draft.appliedFixes.filter((fix) => fix.task !== draft.activeTask),
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

        if (draft.activeTask === 'android-notification') {
          if (draft.notificationSourceMode === 'app') {
            revokeSource(draft.notificationAppSource)
            return {
              ...nextDraft,
              notificationAppSource: source,
            }
          }

          revokeSource(draft.notificationCustomSource)
          return {
            ...nextDraft,
            notificationCustomSource: source,
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
      const { projects: nextProjects, projectId: nextProjectId } = await upsertProject(projects, selected)
      setProjects(nextProjects)
      updateWorkspaceDraft(nextProjectId, (draft) => draft)
      setCurrentProjectId(nextProjectId)
      await saveStoredProjects(nextProjects)
      setStatus(
        selected.supportsWrite
          ? `已打开 ${selected.name}。`
          : `已打开 ${selected.name}，但需要重新授权写入。`,
      )
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') {
        setStatus('已取消选择项目目录。')
      } else {
        setError(nextError instanceof Error ? nextError.message : '打开项目失败。')
      }
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
      appliedFixes: draft.appliedFixes.filter((fix) => fix.task !== draft.activeTask),
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

  function handleApplyFix(item: SourceFixItem) {
    if (!activeSource || !isFixableItem(item)) {
      return
    }

    const sourceKey = activeSource.objectUrl
    updateCurrentDraft((draft) => {
      const currentOptions = draft.optionsByTask[draft.activeTask]
      const before = pickOptionPatchValues(currentOptions, item.patch)
      const after = pickOptionPatchValues(
        {
          ...currentOptions,
          ...item.patch,
        },
        item.patch,
      )

      return {
        ...draft,
        appliedFixes: [
          ...draft.appliedFixes.filter(
            (fix) =>
              fix.id !== item.id ||
              fix.task !== draft.activeTask ||
              fix.sourceKey !== sourceKey,
          ),
          {
            id: item.id,
            task: draft.activeTask,
            sourceKey,
            title: item.title,
            detail: item.detail,
            label: item.actionLabel ?? item.title,
            before,
            after,
          },
        ],
        optionsByTask: {
          ...draft.optionsByTask,
          [draft.activeTask]: {
            ...currentOptions,
            ...item.patch,
          },
        },
      }
    })
    setError('')
    setStatus(`已应用优化：${item.actionLabel ?? item.title}。`)
  }

  function handleApplyAllFixes() {
    if (!activeSource || !activeFixPlan?.canApply) {
      return
    }

    const appliedIds = new Set(activeAppliedFixes.map((fix) => fix.id))
    const items = activeFixPlan.items.filter((item) => isFixableItem(item) && !appliedIds.has(item.id))
    if (!items.length) {
      return
    }

    const sourceKey = activeSource.objectUrl
    updateCurrentDraft((draft) => {
      let nextOptions = draft.optionsByTask[draft.activeTask]
      const nextRecords: AppliedFixRecord[] = []

      for (const item of items) {
        if (!isFixableItem(item)) {
          continue
        }

        const before = pickOptionPatchValues(nextOptions, item.patch)
        nextOptions = {
          ...nextOptions,
          ...item.patch,
        }
        nextRecords.push({
          id: item.id,
          task: draft.activeTask,
          sourceKey,
          title: item.title,
          detail: item.detail,
          label: item.actionLabel ?? item.title,
          before,
          after: pickOptionPatchValues(nextOptions, item.patch),
        })
      }

      const nextRecordIds = new Set(nextRecords.map((fix) => fix.id))
      return {
        ...draft,
        appliedFixes: [
          ...draft.appliedFixes.filter(
            (fix) =>
              fix.task !== draft.activeTask ||
              fix.sourceKey !== sourceKey ||
              !nextRecordIds.has(fix.id),
          ),
          ...nextRecords,
        ],
        optionsByTask: {
          ...draft.optionsByTask,
          [draft.activeTask]: nextOptions,
        },
      }
    })
    setError('')
    setStatus(`已一键优化 ${items.length} 项。`)
  }

  function handleRevertFix(fix: AppliedFixRecord) {
    updateCurrentDraft((draft) => ({
      ...draft,
      appliedFixes: draft.appliedFixes.filter(
        (item) =>
          item.id !== fix.id ||
          item.task !== fix.task ||
          item.sourceKey !== fix.sourceKey,
      ),
      optionsByTask: {
        ...draft.optionsByTask,
        [fix.task]: {
          ...draft.optionsByTask[fix.task],
          ...fix.before,
        },
      },
    }))
    setError('')
    setStatus(`已撤回优化：${fix.label}。`)
  }

  function handleRevertAllFixes() {
    if (!activeAppliedFixes.length) {
      return
    }

    updateCurrentDraft((draft) => {
      const matchingFixes = draft.appliedFixes.filter(
        (fix) => fix.task === draft.activeTask && fix.sourceKey === activeSourceKey,
      )
      if (!matchingFixes.length) {
        return draft
      }

      let nextOptions = draft.optionsByTask[draft.activeTask]
      for (const fix of [...matchingFixes].reverse()) {
        nextOptions = {
          ...nextOptions,
          ...fix.before,
        }
      }

      return {
        ...draft,
        appliedFixes: draft.appliedFixes.filter(
          (fix) => fix.task !== draft.activeTask || fix.sourceKey !== activeSourceKey,
        ),
        optionsByTask: {
          ...draft.optionsByTask,
          [draft.activeTask]: nextOptions,
        },
      }
    })
    setError('')
    setStatus(`已一键撤回 ${activeAppliedFixes.length} 项优化。`)
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
            {statusDetail ? (
              <span className={error ? 'workspace-status-detail error' : 'workspace-status-detail'}>
                {statusDetail}
              </span>
            ) : null}
          </div>
        </header>

        {!writeSupported && !writeNoticeDismissed ? (
          <div className="capability-banner" role="note">
            <AlertCircle size={15} />
            <span>
              当前浏览器不支持直接写入本地 Flutter 项目，已进入{EXPORT_ONLY_MODE_LABEL}：可正常生成资源并下载
              ZIP。需要一键写入项目请使用桌面版 Chrome 或 Edge。
            </span>
            <button
              type="button"
              className="capability-banner-close"
              onClick={() => setWriteNoticeDismissed(true)}
              aria-label="关闭提示"
            >
              <XCircle size={15} />
            </button>
          </div>
        ) : null}

        <ProcessingBanner visible={blockingBusy && progress.visible} progress={progress} />

        <div className="stepper" role="tablist" aria-label="生成步骤">
          {STEPS.map((item, index) => {
            const Icon = item.icon
            const active = step === index
            const disabled = index > 0 && !sourceReady
            const complete = sourceReady && index < step
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-current={active ? 'step' : undefined}
                disabled={disabled}
                key={item.title}
                className={[
                  'workflow-step',
                  active ? 'active' : '',
                  complete ? 'complete' : '',
                  disabled ? 'locked' : '',
                ].filter(Boolean).join(' ')}
                title={disabled ? '请先导入素材' : `${item.label}：${item.detail}`}
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
                onNotificationSourceModeChange={(mode) =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    notificationSourceMode: mode,
                    step: 0,
                    appliedFixes: draft.appliedFixes.filter((fix) => fix.task !== 'android-notification'),
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
              <SmartFixStep
                plan={activeFixPlan}
                appliedFixes={activeAppliedFixes}
                onApplyFix={handleApplyFix}
                onApplyAll={handleApplyAllFixes}
                onRevertFix={handleRevertFix}
                onRevertAll={handleRevertAllFixes}
                onNext={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 2,
                  }))
                }
                onBack={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 0,
                  }))
                }
              />
            ) : null}

            {step === 2 ? (
              <TuningStep
                task={activeTask}
                options={activeOptions}
                onChange={updateOptions}
                onReset={resetTaskOptions}
                onNext={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 3,
                  }))
                }
              />
            ) : null}

            {step === 3 ? (
              <ExportStep
                task={activeTask}
                assets={exportAssets}
                project={currentProject}
                exportOnly={!currentProject}
                busy={blockingBusy}
                writeReport={writeReport}
                onDownload={handleDownloadZip}
                onWrite={handleWriteProject}
                onBack={() =>
                  updateCurrentDraft((draft) => ({
                    ...draft,
                    step: 2,
                  }))
                }
              />
            ) : null}
          </section>

          <PreviewPanel
            task={activeTask}
            source={activeSource}
            notificationAppSource={notificationPreviewAppSource}
            assets={previewAssets}
            options={generationOptions}
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
  onNotificationSourceModeChange,
  onFile,
  onNext,
}: {
  task: TaskId
  source: SourceImage | null
  notificationSourceMode: NotificationSourceMode
  onNotificationSourceModeChange: (mode: NotificationSourceMode) => void
  onFile: (file: File | null) => void
  onNext: () => void
}) {
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)
  const copy = TASK_COPY[task]
  const isNotification = task === 'android-notification'
  const uploadLabel = isNotification
    ? notificationSourceMode === 'app'
      ? '选择应用图标素材'
      : '选择通知专用素材'
    : '选择图片素材'

  // 用进入/离开计数抵消子元素触发的 dragleave，避免高亮闪烁。
  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    event.stopPropagation()
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (!dragDepthRef.current) {
      setDragActive(false)
    }
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)
    onFile(event.dataTransfer.files?.[0] ?? null)
  }

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
              ? '上传用于生成通知图标的应用图标素材；该素材只用于当前通知图标，不会同步到 Android 应用图标。'
              : '请上传透明背景的单色或高对比图形；下一步可生成白色 alpha 蒙版。'}
          </span>
        </div>
      ) : null}

      <label
        className={dragActive ? 'drop-zone drag-active' : 'drop-zone'}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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
              {source.width}x{source.height}px · {formatSourceType(source.fileType)} · {formatFileSize(source.fileSize)}
              {getSourceDimensionHint(task, source)}
            </p>
            {isNotification ? (
              <p>
                素材来源：
                {notificationSourceMode === 'app'
                  ? '应用图标素材（仅用于生成通知图标）'
                  : '通知专用素材'}
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

function SmartFixStep({
  plan,
  appliedFixes,
  onApplyFix,
  onApplyAll,
  onRevertFix,
  onRevertAll,
  onNext,
  onBack,
}: {
  plan: SourceFixPlan | null
  appliedFixes: AppliedFixRecord[]
  onApplyFix: (item: SourceFixItem) => void
  onApplyAll: () => void
  onRevertFix: (fix: AppliedFixRecord) => void
  onRevertAll: () => void
  onNext: () => void
  onBack: () => void
}) {
  const appliedById = new Map(appliedFixes.map((fix) => [fix.id, fix]))
  const items = mergeVisibleFixItems(plan, appliedFixes)
  const autoCount = plan?.autoCount ?? 0
  const unappliedFixCount = plan?.items.filter((item) => isFixableItem(item) && !appliedById.has(item.id)).length ?? 0
  const queueSummary = getSmartFixQueueSummary(autoCount, unappliedFixCount, appliedFixes.length)

  return (
    <div className="step-content">
      <div className="panel-heading">
        <div>
          <h3>智能修正</h3>
          <p>{plan?.summary ?? '导入素材后显示可优化项。'}</p>
        </div>
        <Wand2 size={22} />
      </div>

      <div className={`source-quality-panel ${plan ? getPlanTone(plan) : 'ready'}`}>
        <div className="source-quality-head">
          <div>
            <span className="smart-tag smart-tag-queue">优化队列</span>
            <strong>{queueSummary}</strong>
          </div>
          <div className="smart-fix-head-actions">
            <button
              type="button"
              className={unappliedFixCount ? 'primary-button smart-fix-button' : 'ghost-button smart-fix-button'}
              onClick={onApplyAll}
              disabled={!unappliedFixCount}
            >
              <Wand2 size={15} />
              一键优化
            </button>
            <button
              type="button"
              className="ghost-button smart-fix-button"
              onClick={onRevertAll}
              disabled={!appliedFixes.length}
            >
              <RotateCcw size={15} />
              一键撤回
            </button>
          </div>
        </div>

        {items.length ? (
          <div className="smart-fix-list">
            {items.map((item) => {
              const appliedFix = appliedById.get(item.id)
              return (
                <SmartFixItemRow
                  item={item}
                  appliedFix={appliedFix}
                  key={item.id}
                  onApply={onApplyFix}
                  onRevert={onRevertFix}
                />
              )
            })}
          </div>
        ) : (
          <div className="smart-fix-empty">
            <CheckCircle2 size={18} />
            <span>没有检测到需要修正的素材问题。</span>
          </div>
        )}
      </div>

      <div className="step-actions split">
        <button type="button" className="ghost-button" onClick={onBack}>
          返回导入
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={onNext}
          disabled={!plan}
        >
          下一步
        </button>
      </div>
    </div>
  )
}

function SmartFixItemRow({
  item,
  appliedFix,
  onApply,
  onRevert,
}: {
  item: SourceFixItem
  appliedFix: AppliedFixRecord | undefined
  onApply: (item: SourceFixItem) => void
  onRevert: (fix: AppliedFixRecord) => void
}) {
  const applied = Boolean(appliedFix)
  const fixable = isFixableItem(item)
  const detail = getSmartFixItemDetail(
    applied ? appliedFix?.detail ?? item.detail : item.detail,
    item.patch,
    applied,
  )

  return (
    <div className={`smart-fix-item ${applied ? 'applied' : item.kind}`}>
      <IssueKindIcon kind={applied ? 'ok' : item.kind} />
      <div className="smart-fix-item-copy">
        <strong>
          <span className={`smart-tag ${applied ? 'smart-tag-applied' : getIssueKindTagClassName(item.kind)}`}>
            {applied ? '已应用' : getIssueKindLabel(item.kind)}
          </span>
          {item.title}
        </strong>
        <p>{detail}</p>
      </div>
      <div className="smart-fix-item-action">
        {applied && appliedFix ? (
          <button type="button" className="ghost-button" onClick={() => onRevert(appliedFix)}>
            撤回
          </button>
        ) : (
          fixable ? (
            <button type="button" className="secondary-button" onClick={() => onApply(item)}>
              {item.actionLabel ?? '优化'}
            </button>
          ) : (
            <span className={`smart-tag smart-fix-passive-tag ${getIssueKindTagClassName(item.kind)}`}>
              {getPassiveActionLabel(item.kind)}
            </span>
          )
        )}
      </div>
    </div>
  )
}

function getSmartFixItemDetail(
  detail: string,
  patch: Partial<GenerationOptions> | undefined,
  applied: boolean,
): string {
  const optionSentence = getPatchOptionSentence(patch, applied)
  if (!optionSentence) {
    return detail
  }

  const normalizedDetail = detail.trim()
  const separator = normalizedDetail.endsWith('。') ? '' : '。'
  return `${normalizedDetail}${separator}${optionSentence}`
}

function getPatchOptionSentence(
  patch: Partial<GenerationOptions> | undefined,
  applied: boolean,
): string {
  if (!patch) {
    return ''
  }

  const phrases = Object.keys(patch).map((key) => getOptionAdjustmentPhrase(key as keyof GenerationOptions))

  if (!phrases.length) {
    return ''
  }

  return applied ? `已经完成了${joinChinesePhrases(phrases)}。` : `应用后会${joinChinesePhrases(phrases)}。`
}

function joinChinesePhrases(phrases: string[]): string {
  if (phrases.length <= 1) {
    return phrases[0] ?? ''
  }

  return `${phrases.slice(0, -1).join('、')}，并${phrases[phrases.length - 1]}`
}

function mergeVisibleFixItems(
  plan: SourceFixPlan | null,
  appliedFixes: AppliedFixRecord[],
): SourceFixItem[] {
  const items = [...(plan?.items ?? [])]
  const itemIds = new Set(items.map((item) => item.id))

  for (const fix of appliedFixes) {
    if (!itemIds.has(fix.id)) {
      items.push({
        id: fix.id,
        kind: 'ok',
        title: fix.title,
        detail: fix.detail,
        actionLabel: fix.label,
        patch: fix.after,
      })
    }
  }

  return items
}

function getSmartFixQueueSummary(
  autoCount: number,
  unappliedFixCount: number,
  appliedFixCount: number,
): string {
  if (autoCount && unappliedFixCount) {
    return `${autoCount} 项自动处理，${unappliedFixCount} 项可优化`
  }

  if (autoCount) {
    return `${autoCount} 项自动处理`
  }

  if (unappliedFixCount) {
    return `${unappliedFixCount} 项等待优化`
  }

  if (appliedFixCount) {
    return `${appliedFixCount} 项已应用，可单独撤回`
  }

  return '暂无需要手动优化的项目'
}

function getOptionAdjustmentPhrase(key: keyof GenerationOptions): string {
  if (key === 'backgroundColor') {
    return '补齐背景色'
  }
  if (key === 'scale') {
    return '调整图形缩放比例'
  }
  if (key === 'trim') {
    return '裁剪透明边缘'
  }
  if (key === 'padding') {
    return '调整边距'
  }
  if (key === 'foregroundPercent') {
    return '优化前景安全区'
  }
  if (key === 'monochrome') {
    return '生成单色图层'
  }
  if (key === 'enhanceLowResolution') {
    return '增强低分辨率素材的清晰度'
  }
  if (key === 'normalizeOutputFormat') {
    return '把素材重新编码成 PNG'
  }
  if (key === 'preserveTransparentLayers') {
    return '保留自适应图标前景层的透明通道'
  }
  if (key === 'notificationAlphaMask') {
    return '生成通知小图标需要的白色 alpha 蒙版'
  }
  if (key === 'removeSolidBackground') {
    return '移除通知素材边缘检测到的底色'
  }
  if (key === 'flattenTransparency') {
    return '把透明区域合成到不透明背景里'
  }

  return '更新资源类型'
}

function getPassiveActionLabel(kind: SourceFixKind): string {
  if (kind === 'auto') {
    return '自动处理'
  }
  if (kind === 'fix') {
    return '可优化'
  }
  return '已通过'
}

function getIssueKindTagClassName(kind: SourceFixKind): string {
  return `smart-tag-${kind}`
}

function IssueKindIcon({ kind }: { kind: SourceFixKind }) {
  if (kind === 'auto') {
    return <Info size={16} />
  }

  if (kind === 'fix') {
    return <Wand2 size={16} />
  }

  return <CheckCircle2 size={16} />
}

function getIssueKindLabel(kind: SourceFixKind): string {
  if (kind === 'auto') {
    return '自动处理'
  }

  if (kind === 'fix') {
    return '修正'
  }

  return '通过'
}

function getPlanTone(plan: SourceFixPlan): string {
  if (plan.canApply) {
    return 'fixable'
  }

  return 'ready'
}

function formatSourceType(fileType: string): string {
  const normalized = fileType.split(';')[0]?.trim().toLowerCase()
  if (normalized === 'image/png') {
    return 'PNG'
  }
  if (normalized === 'image/jpeg') {
    return 'JPEG'
  }
  if (normalized === 'image/webp') {
    return 'WebP'
  }
  if (normalized === 'image/svg+xml') {
    return 'SVG'
  }

  return '图片'
}

function formatFileSize(fileSize: number): string {
  if (fileSize < 1024) {
    return `${fileSize} B`
  }

  if (fileSize < 1024 * 1024) {
    return `${(fileSize / 1024).toFixed(1)} KB`
  }

  return `${(fileSize / 1024 / 1024).toFixed(1)} MB`
}

function getSourceDimensionHint(task: TaskId, source: SourceImage): string {
  const minDimension = Math.min(source.width, source.height)
  if (task === 'android-notification') {
    return minDimension < 96 ? '，建议使用 96x96 或更大通知素材。' : ''
  }

  return minDimension < 1024 ? '，建议使用 1024x1024 或更大素材。' : ''
}

function pickOptionPatchValues(
  options: GenerationOptions,
  patch: Partial<GenerationOptions>,
): Partial<GenerationOptions> {
  const picked: Partial<GenerationOptions> = {}
  for (const key of Object.keys(patch) as Array<keyof GenerationOptions>) {
    assignGenerationOption(picked, key, options[key])
  }
  return picked
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
  writeReport,
  onDownload,
  onWrite,
  onBack,
}: {
  task: TaskId
  assets: GeneratedAsset[]
  project: ProjectHandle | null
  exportOnly: boolean
  busy: boolean
  writeReport: WriteReport | null
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

      {writeReport ? (
        <div className={writeReport.skipped.length ? 'write-report has-skipped' : 'write-report'}>
          <div className="write-report-head">
            {writeReport.skipped.length ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
            <strong>
              已写入 {writeReport.written.length} 个文件
              {writeReport.skipped.length ? `，跳过 ${writeReport.skipped.length} 个` : ''}
            </strong>
          </div>
          {writeReport.skipped.slice(0, 5).map((item) => (
            <p key={item.path}>
              {item.path} — {item.reason}
            </p>
          ))}
          {writeReport.skipped.length > 5 ? (
            <p>其余 {writeReport.skipped.length - 5} 个文件也未写入，可重试或改用下载 ZIP。</p>
          ) : null}
        </div>
      ) : null}

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
  notificationAppSource,
  assets,
  options,
  groupedAssets,
  busy,
}: {
  task: TaskId
  source: SourceImage | null
  notificationAppSource: SourceImage | null
  assets: GeneratedAsset[]
  options: GenerationOptions
  groupedAssets: Array<[string, GeneratedAsset[]]>
  busy: boolean
}) {
  const [previewMode, setPreviewMode] = useState<'assets' | 'device'>('assets')
  const imageAssets = assets.filter((asset) => asset.dataUrl)
  const androidForeground = imageAssets.find((asset) => asset.path.includes('drawable-xxxhdpi/ic_launcher_foreground'))
  const notificationIcon =
    imageAssets.find((asset) => asset.path.includes('drawable-xxxhdpi/ic_stat_app.png')) ??
    imageAssets.find((asset) => asset.path.includes('drawable-xhdpi/ic_stat_app.png'))
  const notificationLargest = [...imageAssets].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
  const notificationPreviewIcon = notificationIcon ?? notificationLargest

  useEffect(() => {
    setPreviewMode('assets')
  }, [task])

  return (
    <aside className="preview-panel">
      <div className="preview-header">
        <div>
          <p className="eyebrow">实时预览</p>
          <h3>{TASK_COPY[task].shortLabel}</h3>
        </div>
        <div className="preview-header-actions">
          <span className={busy ? 'preview-state loading' : 'preview-state'}>
            {busy ? <Loader2 className="spin" size={13} /> : null}
            {busy ? '更新中' : source ? `${source.width}x${source.height}` : '未导入素材'}
          </span>
          <button
            type="button"
            className={previewMode === 'device' ? 'device-preview-toggle active' : 'device-preview-toggle'}
            onClick={() => setPreviewMode((current) => (current === 'assets' ? 'device' : 'assets'))}
            disabled={!source}
          >
            {previewMode === 'device' ? <ImageIcon size={14} /> : <MonitorSmartphone size={14} />}
            {previewMode === 'device' ? '资源预览' : '手机预览'}
          </button>
        </div>
      </div>

      {!source ? (
        <PreviewEmptyState task={task} />
      ) : null}

      {source && previewMode === 'device' ? (
        <DeviceSimulator
          task={task}
          source={source}
          notificationAppSource={notificationAppSource}
          assets={assets}
          options={options}
          busy={busy}
        />
      ) : null}

      {source && previewMode === 'assets' && task === 'android-launcher' ? (
        <div className="preview-section">
          <div className="asset-preview-head">
            <p className="preview-title">自适应图标遮罩预览</p>
          </div>
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

      {source && previewMode === 'assets' && task === 'android-notification' ? (
        <div className="preview-section">
          <div className="asset-preview-head">
            <p className="preview-title">状态栏 / 通知栏预览</p>
          </div>
          <div className="phone-preview">
            <div className="phone-status">
              <div>
                <span>09:41</span>
                {notificationPreviewIcon ? (
                  <span className="notification-icon-surface status-icon">
                    <img src={notificationPreviewIcon.dataUrl} alt="" />
                  </span>
                ) : null}
              </div>
              <div>
                <span>LTE</span>
                <span className="phone-status-battery" />
              </div>
            </div>
            <div className="notification-preview-head">
              <span>{formatSimulatorDate()}</span>
              <strong>25°</strong>
            </div>
            <div className="notification-quick-settings" aria-label="快捷设置预览">
              <span className="active">网络</span>
              <span className="active">蓝牙</span>
              <span>勿扰</span>
              <span>手电筒</span>
            </div>
            <div className="notification-brightness">
              <span />
            </div>
            <div className="notification-row">
              {notificationPreviewIcon ? (
                <span className="notification-icon-surface notification-icon-large">
                  <img src={notificationPreviewIcon.dataUrl} alt="" />
                </span>
              ) : null}
              <div>
                <span className="notification-app-line">
                  <strong>应用通知</strong>
                  <small>现在</small>
                </span>
                <p>通知小图标应在深色系统面板中保持清晰的白色 alpha 蒙版。</p>
              </div>
            </div>
            <div className="notification-preview-foot">
              <span>管理</span>
              <span>清除全部</span>
            </div>
          </div>
        </div>
      ) : null}

      {source && previewMode === 'assets' && task === 'ios-launcher' ? (
        <div className="preview-section">
          <div className="asset-preview-head">
            <p className="preview-title">iOS 主屏图标预览</p>
          </div>
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
                    // White alpha-mask layers (notification icons and the launcher monochrome layer)
                    // are white-on-transparent; a light cell would render them invisible, so give
                    // them the dark checkerboard backdrop.
                    className={
                      task === 'android-notification' || asset.path.includes('ic_launcher_monochrome')
                        ? 'asset-cell notification-asset-cell'
                        : 'asset-cell'
                    }
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

function PreviewEmptyState({ task }: { task: TaskId }) {
  return (
    <div className="empty-preview">
      <div className="empty-preview-mark">
        <ImageIcon size={32} />
      </div>
      <strong>{TASK_COPY[task].shortLabel} 等待素材</strong>
    </div>
  )
}

function RequirementBox({ task }: { task: TaskId }) {
  const notes = TASK_COPY[task].officialNotes
  return (
    <details className="requirement-box">
      <summary className="section-title">
        <Info size={16} />
        <span>官方素材要求</span>
      </summary>
      <ul className="requirement-list">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
        {task === 'ios-launcher' ? (
          <li>Xcode 支持从 1024x1024 单尺寸图标派生；本工具同时生成传统全尺寸 AppIcon 资源。</li>
        ) : null}
        {task === 'android-notification' ? (
          <li>通知图标会输出为白色 alpha 蒙版；如果素材有底色，可在智能修正中尝试移除。</li>
        ) : null}
      </ul>
    </details>
  )
}

function DensityTable() {
  return (
    <div className="density-table">
      {[
        ['mdpi', '48px'],
        ['hdpi', '72px'],
        ['xhdpi', '96px'],
        ['xxhdpi', '144px'],
        ['xxxhdpi', '192px'],
      ].map(([density, size]) => (
        <div key={density}>
          <span>{density}</span>
          <strong>{size}</strong>
        </div>
      ))}
    </div>
  )
}

export default App
