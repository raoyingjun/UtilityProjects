import { ANDROID_DENSITIES, IOS_ICON_SLOTS, type TaskId } from './iconSpecs'
import type { GenerationOptions, SourceImage } from './imageTools'

export type SourceFixKind = 'ok' | 'auto' | 'fix'

export type SourceFixItem = {
  id: string
  kind: SourceFixKind
  title: string
  detail: string
  actionLabel?: string
  patch?: Partial<GenerationOptions>
}

export type FixableSourceFixItem = SourceFixItem & {
  kind: 'fix'
  patch: Partial<GenerationOptions>
}

export type SourceFixPlan = {
  items: SourceFixItem[]
  patch: Partial<GenerationOptions>
  actionLabels: string[]
  autoCount: number
  fixCount: number
  canApply: boolean
  summary: string
}

export type SourceFixPlanConfig = {
  task: TaskId
  source: SourceImage
  options: GenerationOptions
  notificationSourceMode: 'app' | 'custom'
}

type PatchEntry = {
  key: keyof GenerationOptions
  value: GenerationOptions[keyof GenerationOptions]
  label: string
}

const PNG_OUTPUT_FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])

export function buildSourceFixPlan({
  task,
  source,
  options,
  notificationSourceMode,
}: SourceFixPlanConfig): SourceFixPlan {
  const items: SourceFixItem[] = []
  const format = normalizeMimeType(source.fileType)
  const minDimension = Math.min(source.width, source.height)
  const requiredDimension = maxOutputDimension(task)
  const scalableVector = format === 'image/svg+xml'
  const isNonSquare = source.width !== source.height
  const contentTouchesEdge =
    source.stats.contentWidthRatio > 0.94 || source.stats.contentHeightRatio > 0.94
  const sparseTransparentContent = source.hasTransparency && source.stats.contentAreaRatio < 0.58

  if (!PNG_OUTPUT_FORMATS.has(format)) {
    items.push(
      makeAutoItem(
        'format-unsupported',
        '图片格式可能无法稳定解码',
        '如果当前浏览器已成功解码，导出时会把素材重新编码成各平台稳定支持的 PNG 资源。',
      ),
    )
  } else if (format !== 'image/png') {
    items.push(
      makeAutoItem(
        'format-normalized',
        '输出格式会统一为 PNG',
        format === 'image/svg+xml'
          ? 'SVG 会先由浏览器渲染，再输出为各平台需要的 PNG 资源。'
          : '当前素材可导入，导出时会重新编码为 PNG 资源。',
      ),
    )
  }

  if (isNonSquare) {
    items.push(
      makeFixItem(
        options,
        'canvas-square',
        '画布不是正方形',
        options.trim
          ? '生成时会居中放入正方形画布，避免 Android 和 iOS 图标槽位变形。'
          : '建议先裁掉透明边缘，再居中放入正方形画布。',
        '修正画布比例',
        [{ key: 'trim', value: true, label: '裁剪透明边缘' }],
      ),
    )
  }

  if (minDimension < requiredDimension && !scalableVector) {
    items.push(
      makeFixItem(
        options,
        'source-size',
        '源图分辨率偏低',
        lowResolutionDetail(task, requiredDimension),
        '增强清晰度',
        [{ key: 'enhanceLowResolution', value: true, label: '低分辨率清晰度增强' }],
      ),
    )
  }

  if (sparseTransparentContent) {
    items.push(
      makeFixItem(
        options,
        'transparent-padding',
        '透明留白较多',
        options.trim
          ? '已启用透明边缘裁剪，生成时会用实际内容边界参与缩放。'
          : '建议裁剪透明边缘，再按目标平台补回安全边距。',
        '裁剪透明留白',
        isNonSquare ? [] : [{ key: 'trim', value: true, label: '启用透明裁剪' }],
      ),
    )
  }

  if (source.stats.visiblePixelRatio < 0.015) {
    items.push(
      makeFixItem(
        options,
        'low-visible-coverage',
        '可见内容过少',
        '素材主体占比很小，应用后会尝试放大可见主体、收紧边距并增强放大后的边缘清晰度。',
        '放大可见主体',
        getSparseContentEntries(task, options),
      ),
    )
  }

  if (task === 'android-launcher') {
    appendAndroidLauncherFixes(items, source, options, contentTouchesEdge)
  }

  if (task === 'android-notification') {
    appendAndroidNotificationFixes(items, source, options, notificationSourceMode, contentTouchesEdge)
  }

  if (task === 'ios-launcher') {
    appendIosLauncherFixes(items, source, options, contentTouchesEdge)
  }

  if (!items.length) {
    items.push({
      id: 'source-ready',
      kind: 'ok',
      title: '素材符合当前资源要求',
      detail: '可以直接进入参数调整和导出。',
    })
  }

  const fixableItems = items.filter(isFixableItem)
  const patch = mergeItemPatches(fixableItems)
  const actionLabels = fixableItems.map((item) => item.actionLabel ?? item.title)
  const autoCount = items.filter((item) => item.kind === 'auto').length
  const fixCount = fixableItems.length

  return {
    items,
    patch,
    actionLabels,
    autoCount,
    fixCount,
    canApply: fixableItems.length > 0,
    summary: buildSummary(autoCount, fixCount),
  }
}

export function isFixableItem(item: SourceFixItem): item is FixableSourceFixItem {
  return item.kind === 'fix' && Boolean(item.patch && Object.keys(item.patch).length)
}

function appendAndroidLauncherFixes(
  items: SourceFixItem[],
  source: SourceImage,
  options: GenerationOptions,
  contentTouchesEdge: boolean,
) {
  if (contentTouchesEdge) {
    items.push(
      makeFixItem(
        options,
        'android-safe-zone',
        '内容接近图标边缘',
        options.scale > 0.82 || options.padding < 8 || options.foregroundPercent > 66
          ? 'Android 自适应图标存在安全区，建议收小前景并保留边距，避免不同形状蒙版裁掉主体。'
          : '当前参数已按 Android 自适应图标安全区收小主体。',
        '优化安全区',
        [
          { key: 'scale', value: Math.min(options.scale, 0.82), label: '收小启动图标主体' },
          { key: 'padding', value: Math.max(options.padding, 8), label: '补充图标边距' },
          {
            key: 'foregroundPercent',
            value: Math.min(options.foregroundPercent, 66),
            label: '前景层收回安全区',
          },
        ],
      ),
    )
  }

  if (options.backgroundColor === '#00000000') {
    items.push(
      makeFixItem(
        options,
        'android-background',
        '启动图标背景为透明',
        '传统启动图标和部分启动器预览需要明确背景色，建议自动补一个浅色背景。',
        '补背景色',
        [{ key: 'backgroundColor', value: '#f4f7fb', label: '补启动图标背景色' }],
      ),
    )
  }

  if (!options.monochrome) {
    items.push(
      makeFixItem(
        options,
        'android-monochrome',
        '未生成主题单色层',
        'Android 主题图标需要单色层；可从当前素材自动生成 alpha 蒙版。',
        '生成单色层',
        [{ key: 'monochrome', value: true, label: '生成主题单色层' }],
      ),
    )
  }

  if (source.hasTransparency && source.stats.contentAreaRatio < 0.72) {
    items.push(
      makeAutoItem(
        'android-transparent-source',
        '透明素材会分层输出',
        '传统图标会合成背景，自适应图标前景层会保留透明通道。',
      ),
    )
  }
}

function appendAndroidNotificationFixes(
  items: SourceFixItem[],
  source: SourceImage,
  options: GenerationOptions,
  notificationSourceMode: 'app' | 'custom',
  contentTouchesEdge: boolean,
) {
  const colorful = source.stats.colorfulPixelRatio > 0.08
  const likelySolidBackground = !source.hasTransparency || source.stats.edgeOpaqueRatio > 0.72

  if (colorful) {
    items.push(
      makeAutoItem(
        'notification-color',
        '通知小图标不能依赖彩色通道',
        'Android 通知栏会按系统样式为小图标着色，导出时会把当前素材转换为白色 alpha 蒙版。',
      ),
    )
  }

  if (likelySolidBackground) {
    if (notificationSourceMode === 'app') {
      items.push(
        makeAutoItem(
          'notification-background',
          '检测到应用图标底色',
          '从应用图标生成通知图标时会采样边缘底色并自动清理，保留前景形状作为通知图标。',
        ),
      )
    } else {
      items.push(
        makeFixItem(
          options,
          'notification-background',
          '检测到不透明背景或底色',
          '应用后会采样边缘底色并尝试移除背景，保留前景形状作为通知图标。',
          '移除通知底色',
          [{ key: 'removeSolidBackground', value: true, label: '移除边缘底色' }],
        ),
      )
    }
  }

  if (contentTouchesEdge || likelySolidBackground || colorful || options.padding < 12) {
    items.push(
      makeFixItem(
        options,
        'notification-mask-fit',
        '通知图标需要安全边距',
        options.backgroundColor !== '#00000000' ||
          !options.trim ||
          options.padding < 12 ||
          options.scale > 0.74
          ? '建议使用透明画布、适当缩小主体，并输出白色 alpha 蒙版。'
          : '当前参数已按通知图标规则保留透明背景和安全边距。',
        '优化通知蒙版',
        [
          { key: 'backgroundColor', value: '#00000000', label: '保持通知透明背景' },
          { key: 'trim', value: true, label: '裁剪通知图标边缘' },
          { key: 'padding', value: Math.max(options.padding, 12), label: '补通知安全边距' },
          { key: 'scale', value: Math.min(options.scale, 0.74), label: '收小通知主体' },
        ],
      ),
    )
  }

  if (notificationSourceMode === 'custom' && colorful && likelySolidBackground) {
    items.push(
      makeFixItem(
        options,
        'notification-custom-complex',
        '通知专用素材仍偏复杂',
        '应用后会尽量移除底色、转成单色 alpha 形状并收小主体；复杂照片或多层渐变仍建议人工换成更简洁的线稿。',
        '简化通知图形',
        [
          { key: 'notificationAlphaMask', value: true, label: '生成通知 alpha 蒙版' },
          { key: 'removeSolidBackground', value: true, label: '移除边缘底色' },
          { key: 'backgroundColor', value: '#00000000', label: '保持通知透明背景' },
          { key: 'trim', value: true, label: '裁剪通知图标边缘' },
          { key: 'padding', value: Math.max(options.padding, 14), label: '补通知安全边距' },
          { key: 'scale', value: Math.min(options.scale, 0.72), label: '收小通知主体' },
        ],
      ),
    )
  }
}

function appendIosLauncherFixes(
  items: SourceFixItem[],
  source: SourceImage,
  options: GenerationOptions,
  contentTouchesEdge: boolean,
) {
  if (source.hasTransparency) {
    items.push(
      makeAutoItem(
        'ios-alpha',
        'iOS 图标会合成不透明 PNG',
        '透明区域会按当前背景色合成，系统会自行应用圆角蒙版。',
      ),
    )
  }

  if (contentTouchesEdge && options.scale > 0.9) {
    items.push(
      makeFixItem(
        options,
        'ios-edge-fit',
        '主体接近 iOS 圆角蒙版边缘',
        '建议轻微缩小主体，避免系统圆角或深色/浅色模式下视觉拥挤。',
        '收小 iOS 主体',
        [{ key: 'scale', value: 0.9, label: '收小 iOS 主体' }],
      ),
    )
  }

  if (options.padding !== 0) {
    items.push(
      makeFixItem(
        options,
        'ios-padding',
        'iOS 图标不需要额外导出边距',
        'iOS 会按正方形图标再应用系统圆角，建议使用画布构图本身控制留白。',
        '移除额外边距',
        [{ key: 'padding', value: 0, label: '移除 iOS 额外边距' }],
      ),
    )
  }
}

function getSparseContentEntries(task: TaskId, options: GenerationOptions): PatchEntry[] {
  if (task === 'android-notification') {
    return [
      { key: 'trim', value: true, label: '裁剪通知图标边缘' },
      { key: 'padding', value: Math.min(options.padding, 8), label: '收紧通知安全边距' },
      { key: 'scale', value: Math.max(options.scale, 0.9), label: '放大通知主体' },
      { key: 'notificationAlphaMask', value: true, label: '生成通知 alpha 蒙版' },
      { key: 'enhanceLowResolution', value: true, label: '低分辨率清晰度增强' },
    ]
  }

  if (task === 'ios-launcher') {
    return [
      { key: 'trim', value: true, label: '裁剪透明边缘' },
      { key: 'padding', value: 0, label: '移除 iOS 额外边距' },
      { key: 'scale', value: Math.max(options.scale, 1.08), label: '放大 iOS 主体' },
      { key: 'enhanceLowResolution', value: true, label: '低分辨率清晰度增强' },
    ]
  }

  return [
    { key: 'trim', value: true, label: '裁剪透明边缘' },
    { key: 'padding', value: Math.min(options.padding, 2), label: '收紧图标边距' },
    { key: 'scale', value: Math.max(options.scale, 1.12), label: '放大图标主体' },
    { key: 'foregroundPercent', value: Math.max(options.foregroundPercent, 72), label: '放大前景层主体' },
    { key: 'enhanceLowResolution', value: true, label: '低分辨率清晰度增强' },
  ]
}

function makeAutoItem(id: string, title: string, detail: string): SourceFixItem {
  return {
    id,
    kind: 'auto',
    title,
    detail,
  }
}

function makeFixItem(
  options: GenerationOptions,
  id: string,
  title: string,
  detail: string,
  actionLabel: string,
  entries: PatchEntry[],
): SourceFixItem {
  const patch = buildPatch(options, entries)
  if (!Object.keys(patch).length) {
    return {
      id,
      kind: 'ok',
      title,
      detail,
    }
  }

  return {
    id,
    kind: 'fix',
    title,
    detail,
    actionLabel,
    patch,
  }
}

function buildPatch(options: GenerationOptions, entries: PatchEntry[]): Partial<GenerationOptions> {
  const patch: Partial<GenerationOptions> = {}

  for (const entry of entries) {
    if (options[entry.key] !== entry.value) {
      assignGenerationOption(patch, entry.key, entry.value)
    }
  }

  return patch
}

function mergeItemPatches(items: SourceFixItem[]): Partial<GenerationOptions> {
  return items.reduce<Partial<GenerationOptions>>(
    (patch, item) => ({
      ...patch,
      ...item.patch,
    }),
    {},
  )
}

export function assignGenerationOption(
  patch: Partial<GenerationOptions>,
  key: keyof GenerationOptions,
  value: GenerationOptions[keyof GenerationOptions],
) {
  if (key === 'taskId') {
    patch.taskId = value as TaskId
  }
  if (key === 'backgroundColor') {
    patch.backgroundColor = value as string
  }
  if (key === 'scale') {
    patch.scale = value as number
  }
  if (key === 'trim') {
    patch.trim = value as boolean
  }
  if (key === 'padding') {
    patch.padding = value as number
  }
  if (key === 'foregroundPercent') {
    patch.foregroundPercent = value as number
  }
  if (key === 'monochrome') {
    patch.monochrome = value as boolean
  }
  if (key === 'enhanceLowResolution') {
    patch.enhanceLowResolution = value as boolean
  }
  if (key === 'normalizeOutputFormat') {
    patch.normalizeOutputFormat = value as boolean
  }
  if (key === 'preserveTransparentLayers') {
    patch.preserveTransparentLayers = value as boolean
  }
  if (key === 'notificationAlphaMask') {
    patch.notificationAlphaMask = value as boolean
  }
  if (key === 'removeSolidBackground') {
    patch.removeSolidBackground = value as boolean
  }
  if (key === 'flattenTransparency') {
    patch.flattenTransparency = value as boolean
  }
}

function buildSummary(autoCount: number, fixCount: number): string {
  if (autoCount && fixCount) {
    return `自动处理 ${autoCount} 项，${fixCount} 项可优化`
  }

  if (autoCount) {
    return `自动处理 ${autoCount} 项`
  }

  if (fixCount) {
    return `${fixCount} 项可优化`
  }

  return '素材已符合当前要求'
}

// The largest raster this task actually exports. Sources at or above this size never need
// upscaling for any output, so flagging them as "low resolution" (and offering a sharpen pass
// that would only ever downscale) is misleading. Android launcher tops out at the adaptive
// foreground (432px), notifications at 96px, iOS at the 1024px marketing icon.
function maxOutputDimension(task: TaskId): number {
  if (task === 'android-notification') {
    return Math.max(...ANDROID_DENSITIES.map((spec) => spec.notificationPx))
  }
  if (task === 'android-launcher') {
    return Math.max(...ANDROID_DENSITIES.map((spec) => spec.adaptivePx))
  }
  return Math.max(...IOS_ICON_SLOTS.map((slot) => slot.pixels))
}

function lowResolutionDetail(task: TaskId, requiredDimension: number): string {
  const caveat = '这能改善观感，但不能恢复源图没有的真实细节。'
  if (task === 'android-notification') {
    return `可在放大到通知图标目标尺寸后增强边缘清晰度；${caveat}`
  }
  if (task === 'ios-launcher') {
    return `可在放大到 ${requiredDimension}x${requiredDimension} 营销图标等目标尺寸后增强边缘和局部对比；${caveat}`
  }
  return `可在放大到各密度图标目标尺寸（最大 ${requiredDimension}px）后增强边缘和局部对比；${caveat}`
}

function normalizeMimeType(fileType: string): string {
  return fileType.split(';')[0]?.trim().toLowerCase() || 'image/*'
}
