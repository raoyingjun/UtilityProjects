import JSZip from 'jszip'
import type { GeneratedAsset } from './imageTools'

export type ProjectHandle = {
  id: string
  root: FileSystemDirectoryHandle
  name: string
  supportsWrite: boolean
  issues: string[]
  createdAt: number
  lastOpenedAt: number
}

export type SkippedWrite = {
  path: string
  reason: string
}

export type WriteReport = {
  written: string[]
  skipped: SkippedWrite[]
}

type PermissionMode = 'read' | 'readwrite'

type FileSystemPermissionDescriptor = {
  mode?: PermissionMode
}

export type FileSystemDirectoryHandle = {
  kind: 'directory'
  name: string
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemDirectoryHandle>
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemFileHandle>
  getFile?: (name: string) => Promise<File>
  isSameEntry?: (other: FileSystemDirectoryHandle) => Promise<boolean>
  queryPermission?: (descriptor?: FileSystemPermissionDescriptor) => Promise<PermissionState>
  requestPermission?: (descriptor?: FileSystemPermissionDescriptor) => Promise<PermissionState>
}

type FileSystemFileHandle = {
  kind: 'file'
  name: string
  createWritable: () => Promise<FileSystemWritableFileStream>
  getFile?: () => Promise<File>
}

type FileSystemWritableFileStream = WritableStream & {
  write: (data: Blob | BufferSource | string) => Promise<void>
  close: () => Promise<void>
}

const PROJECT_DB_NAME = 'app-resource-generator'
const PROJECT_DB_VERSION = 1
const PROJECT_STORE_NAME = 'flutter-projects'
const PROJECT_LIST_KEY = 'projects'

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string
      mode?: PermissionMode
      startIn?: string
    }) => Promise<FileSystemDirectoryHandle>
  }
}

export function canWriteLocalProject(): boolean {
  return typeof window.showDirectoryPicker === 'function'
}

export async function pickFlutterProject(): Promise<ProjectHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error('当前浏览器不支持选择本地目录，请改用下载 ZIP。')
  }

  const root = await window.showDirectoryPicker({
    id: 'flutter-project',
    mode: 'readwrite',
  })
  const permission = await ensurePermission(root)
  const issues = await validateFlutterProject(root)

  return {
    id: createProjectId(root.name),
    root,
    name: root.name,
    supportsWrite: permission === 'granted',
    issues,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  }
}

export async function refreshFlutterProject(project: ProjectHandle): Promise<ProjectHandle> {
  const permission = await ensurePermission(project.root)
  const issues = await validateFlutterProject(project.root)

  return {
    ...project,
    supportsWrite: permission === 'granted',
    issues,
    lastOpenedAt: Date.now(),
  }
}

export async function loadStoredProjects(): Promise<ProjectHandle[]> {
  try {
    const stored = await readProjectStore()
    return stored.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  } catch {
    return []
  }
}

export async function saveStoredProjects(projects: ProjectHandle[]) {
  await writeProjectStore(projects)
}

export async function upsertProject(
  projects: ProjectHandle[],
  project: ProjectHandle,
): Promise<{ projects: ProjectHandle[]; projectId: string }> {
  const matchingIndex = await findMatchingProjectIndex(projects, project)
  if (matchingIndex < 0) {
    return {
      projects: [project, ...projects],
      projectId: project.id,
    }
  }

  const nextProjects = [...projects]
  const existing = nextProjects[matchingIndex]
  nextProjects[matchingIndex] = {
    ...project,
    id: existing.id,
    createdAt: existing.createdAt,
  }
  return {
    projects: nextProjects,
    projectId: existing.id,
  }
}

async function findMatchingProjectIndex(
  projects: ProjectHandle[],
  project: ProjectHandle,
): Promise<number> {
  for (const [index, item] of projects.entries()) {
    // 同名目录可能位于不同路径，优先用 isSameEntry 精确比较，避免互相覆盖。
    if (item.root.isSameEntry && project.root.isSameEntry) {
      try {
        if (await item.root.isSameEntry(project.root)) {
          return index
        }
        continue
      } catch {
        // isSameEntry 失败时回退到目录名比较。
      }
    }

    if (item.root.name === project.root.name) {
      return index
    }
  }

  return -1
}

export async function validateFlutterProject(root: FileSystemDirectoryHandle): Promise<string[]> {
  const checks: Array<[string, string[]]> = [
    ['缺少 pubspec.yaml，所选目录可能不是 Flutter 项目根目录。', ['pubspec.yaml']],
    [
      '缺少 Android 资源目录 android/app/src/main/res。',
      ['android', 'app', 'src', 'main', 'res'],
    ],
    [
      '缺少 iOS AppIcon 目录 ios/Runner/Assets.xcassets/AppIcon.appiconset。',
      ['ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset'],
    ],
  ]

  const issues: string[] = []
  for (const [message, path] of checks) {
    if (!(await pathExists(root, path))) {
      issues.push(message)
    }
  }

  return issues
}

export async function writeAssetsToProject(
  root: FileSystemDirectoryHandle,
  assets: GeneratedAsset[],
  onProgress?: (current: number, total: number, label: string) => void,
): Promise<WriteReport> {
  const permission = await ensurePermission(root)
  if (permission !== 'granted') {
    throw new Error('浏览器没有授予写入权限。')
  }

  const report: WriteReport = {
    written: [],
    skipped: [],
  }

  for (const [index, asset] of assets.entries()) {
    try {
      const parts = asset.path.split('/').filter(Boolean)
      const fileName = parts.pop()
      if (!fileName) {
        report.skipped.push({ path: asset.path, reason: '输出路径无效' })
        continue
      }
      const dir = await ensureDirectory(root, parts)
      const fileHandle = await dir.getFileHandle(fileName, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(asset.blob)
      await writable.close()
      report.written.push(asset.path)
    } catch (error) {
      report.skipped.push({
        path: asset.path,
        reason: error instanceof Error && error.message ? error.message : '写入失败',
      })
    }
    onProgress?.(index + 1, assets.length, asset.label)
  }

  return report
}

export async function downloadZip(
  assets: GeneratedAsset[],
  prefix = 'generated-app-resources',
  onProgress?: (percent: number) => void,
) {
  const zip = new JSZip()

  for (const asset of assets) {
    zip.file(asset.path, asset.blob)
  }

  const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
    onProgress?.(Math.round(metadata.percent))
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${prefix}-${formatDateStamp(new Date())}.zip`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

async function ensurePermission(root: FileSystemDirectoryHandle): Promise<PermissionState> {
  const descriptor = { mode: 'readwrite' as const }
  if (root.queryPermission) {
    const current = await root.queryPermission(descriptor)
    if (current === 'granted') {
      return current
    }
  }

  if (root.requestPermission) {
    return root.requestPermission(descriptor)
  }

  return 'granted'
}

async function pathExists(root: FileSystemDirectoryHandle, parts: string[]): Promise<boolean> {
  try {
    if (parts.length === 1 && parts[0].includes('.')) {
      await root.getFileHandle(parts[0])
      return true
    }

    let current = root
    for (const part of parts) {
      current = await current.getDirectoryHandle(part)
    }
    return true
  } catch {
    return false
  }
}

async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  parts: string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true })
  }
  return current
}

function createProjectId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function formatDateStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}${month}${day}`
}

function openProjectDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
        database.createObjectStore(PROJECT_STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开项目列表缓存。'))
  })
}

async function readProjectStore(): Promise<ProjectHandle[]> {
  const database = await openProjectDb()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE_NAME, 'readonly')
    const store = transaction.objectStore(PROJECT_STORE_NAME)
    const request = store.get(PROJECT_LIST_KEY)

    request.onsuccess = () => resolve((request.result as ProjectHandle[] | undefined) ?? [])
    request.onerror = () => reject(request.error ?? new Error('读取项目列表失败。'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => database.close()
  })
}

async function writeProjectStore(projects: ProjectHandle[]) {
  const database = await openProjectDb()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(PROJECT_STORE_NAME)
    const request = store.put(projects, PROJECT_LIST_KEY)

    request.onerror = () => reject(request.error ?? new Error('保存项目列表失败。'))
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('保存项目列表失败。'))
    }
  })
}
