import { ANDROID_DENSITIES, IOS_ICON_SLOTS, type TaskId } from './iconSpecs'

export type ImageBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type SourceImage = {
  bitmap: ImageBitmap
  width: number
  height: number
  objectUrl: string
  fileName: string
  contentBounds: ImageBounds
  hasTransparency: boolean
}

export type GenerationOptions = {
  taskId: TaskId
  backgroundColor: string
  scale: number
  trim: boolean
  padding: number
  foregroundPercent: number
  monochrome: boolean
}

export type GenerationMode = 'preview' | 'export'

export type GenerationProgress = {
  current: number
  total: number
  percent: number
  label: string
  phase: 'prepare' | 'render' | 'encode' | 'done'
}

export type GeneratedAsset = {
  path: string
  blob: Blob
  width?: number
  height?: number
  label: string
  group: string
  dataUrl: string
}

export type GenerateAssetsConfig = {
  mode?: GenerationMode
  includeDataUrls?: boolean
  onProgress?: (progress: GenerationProgress) => void
}

type DrawMode = 'contain' | 'notification-mask'

type RgbColor = {
  r: number
  g: number
  b: number
}

type NotificationBackground = RgbColor & {
  confidence: number
  edgeDistanceMean: number
  edgeDistanceStd: number
}

type ImageJob = {
  path: string
  width: number
  height: number
  label: string
  group: string
  render: () => Promise<Blob>
}

type TextJob = {
  path: string
  label: string
  group: string
  text: string
  type: string
}

type AssetJob = ImageJob | TextJob

export async function loadSourceImage(file: File): Promise<SourceImage> {
  const bitmap = await createImageBitmap(file)
  const analysis = analyzeBitmap(bitmap)

  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    objectUrl: URL.createObjectURL(file),
    fileName: file.name,
    ...analysis,
  }
}

export async function generateAssets(
  source: SourceImage,
  options: GenerationOptions,
  config: GenerateAssetsConfig = {},
): Promise<GeneratedAsset[]> {
  const mode = config.mode ?? 'export'
  const includeDataUrls = config.includeDataUrls ?? mode === 'preview'
  const jobs = createJobs(source, options, mode)
  const assets: GeneratedAsset[] = []
  const total = jobs.length

  config.onProgress?.({
    current: 0,
    total,
    percent: 0,
    label: '准备图像资源',
    phase: 'prepare',
  })

  for (const [index, job] of jobs.entries()) {
    const current = index + 1
    config.onProgress?.({
      current,
      total,
      percent: Math.round(((current - 0.35) / total) * 100),
      label: job.label,
      phase: 'render',
    })

    if ('render' in job) {
      const blob = await job.render()
      assets.push(
        await makeImageAsset(
          {
            path: job.path,
            blob,
            width: job.width,
            height: job.height,
            label: job.label,
            group: job.group,
          },
          includeDataUrls,
        ),
      )
    } else {
      assets.push(await makeTextAsset(job))
    }

    config.onProgress?.({
      current,
      total,
      percent: Math.round((current / total) * 100),
      label: job.label,
      phase: current === total ? 'done' : 'encode',
    })
  }

  return assets
}

function createJobs(
  source: SourceImage,
  options: GenerationOptions,
  mode: GenerationMode,
): AssetJob[] {
  if (options.taskId === 'android-launcher') {
    return createAndroidLauncherJobs(source, options, mode)
  }

  if (options.taskId === 'android-notification') {
    return createAndroidNotificationJobs(source, options, mode)
  }

  return createIosLauncherJobs(source, options, mode)
}

function createAndroidLauncherJobs(
  source: SourceImage,
  options: GenerationOptions,
  mode: GenerationMode,
): AssetJob[] {
  const jobs: AssetJob[] = []
  const densities = mode === 'preview' ? [ANDROID_DENSITIES.at(-1)!] : ANDROID_DENSITIES

  for (const spec of densities) {
    jobs.push(
      {
        path: `android/app/src/main/res/mipmap-${spec.density}/ic_launcher.png`,
        width: spec.legacyLauncherPx,
        height: spec.legacyLauncherPx,
        label: `${spec.density} ${spec.legacyLauncherPx}px`,
        group: '传统启动图标',
        render: () =>
          renderPng(source, {
            size: spec.legacyLauncherPx,
            backgroundColor: options.backgroundColor,
            scale: options.scale,
            trim: options.trim,
            padding: options.padding,
            mode: 'contain',
            opaque: false,
            roundMask: false,
          }),
      },
      {
        path: `android/app/src/main/res/mipmap-${spec.density}/ic_launcher_round.png`,
        width: spec.legacyLauncherPx,
        height: spec.legacyLauncherPx,
        label: `${spec.density} 圆形`,
        group: '圆形启动图标',
        render: () =>
          renderPng(source, {
            size: spec.legacyLauncherPx,
            backgroundColor: options.backgroundColor,
            scale: options.scale,
            trim: options.trim,
            padding: options.padding,
            mode: 'contain',
            opaque: false,
            roundMask: true,
          }),
      },
      {
        path: `android/app/src/main/res/drawable-${spec.density}/ic_launcher_foreground.png`,
        width: spec.adaptivePx,
        height: spec.adaptivePx,
        label: `${spec.density} 前景层`,
        group: '自适应图标前景',
        render: () =>
          renderPng(source, {
            size: spec.adaptivePx,
            backgroundColor: '#00000000',
            scale: options.foregroundPercent / 100,
            trim: options.trim,
            padding: options.padding,
            mode: 'contain',
            opaque: false,
            roundMask: false,
          }),
      },
    )
  }

  if (mode === 'export') {
    jobs.push(
      {
        path: 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
        text: adaptiveIconXml(options.monochrome),
        label: 'ic_launcher.xml',
        group: '自适应图标配置',
        type: 'application/xml;charset=utf-8',
      },
      {
        path: 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
        text: adaptiveIconXml(options.monochrome),
        label: 'ic_launcher_round.xml',
        group: '自适应图标配置',
        type: 'application/xml;charset=utf-8',
      },
      {
        path: 'android/app/src/main/res/values/ic_launcher_background.xml',
        text: colorXml(options.backgroundColor),
        label: '背景色配置',
        group: '自适应图标配置',
        type: 'application/xml;charset=utf-8',
      },
    )
  }

  return jobs
}

function createAndroidNotificationJobs(
  source: SourceImage,
  options: GenerationOptions,
  mode: GenerationMode,
): AssetJob[] {
  const previewDensities = ANDROID_DENSITIES.filter(({ density }) =>
    ['xhdpi', 'xxxhdpi'].includes(density),
  )
  const densities = mode === 'preview' ? previewDensities : ANDROID_DENSITIES

  return densities.map((spec) => ({
    path: `android/app/src/main/res/drawable-${spec.density}/ic_stat_app.png`,
    width: spec.notificationPx,
    height: spec.notificationPx,
    label: `${spec.density} ${spec.notificationPx}px`,
    group: '通知小图标',
    render: () =>
      renderPng(source, {
        size: spec.notificationPx,
        backgroundColor: '#00000000',
        scale: options.scale,
        trim: options.trim,
        padding: options.padding,
        mode: 'notification-mask',
        opaque: false,
        roundMask: false,
      }),
  }))
}

function createIosLauncherJobs(
  source: SourceImage,
  options: GenerationOptions,
  mode: GenerationMode,
): AssetJob[] {
  const slots =
    mode === 'preview'
      ? IOS_ICON_SLOTS.filter(({ pixels }) => [80, 120, 180, 1024].includes(pixels))
      : IOS_ICON_SLOTS
  const jobs: AssetJob[] = slots.map((slot) => ({
    path: `ios/Runner/Assets.xcassets/AppIcon.appiconset/${slot.filename}`,
    width: slot.pixels,
    height: slot.pixels,
    label: `${slot.idiom} ${slot.size}@${slot.scale}`,
    group: 'AppIcon.appiconset',
    render: () =>
      renderPng(source, {
        size: slot.pixels,
        backgroundColor: options.backgroundColor,
        scale: options.scale,
        trim: options.trim,
        padding: options.padding,
        mode: 'contain',
        opaque: true,
        roundMask: false,
      }),
  }))

  if (mode === 'export') {
    jobs.push({
      path: 'ios/Runner/Assets.xcassets/AppIcon.appiconset/Contents.json',
      text: JSON.stringify(
        {
          images: IOS_ICON_SLOTS.map(({ idiom, size, scale, filename }) => ({
            size,
            idiom,
            filename,
            scale,
          })),
          info: {
            version: 1,
            author: 'xcode',
          },
        },
        null,
        2,
      ),
      label: 'Contents.json',
      group: 'AppIcon.appiconset',
      type: 'application/json;charset=utf-8',
    })
  }

  return jobs
}

function adaptiveIconXml(includeMonochrome: boolean): string {
  const monochrome = includeMonochrome
    ? '\n    <monochrome android:drawable="@drawable/ic_launcher_foreground" />'
    : ''

  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />${monochrome}
</adaptive-icon>
`
}

function colorXml(color: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${normalizeOpaqueHex(color)}</color>
</resources>
`
}

async function renderPng(
  source: SourceImage,
  params: {
    size: number
    backgroundColor: string
    scale: number
    trim: boolean
    padding: number
    mode: DrawMode
    opaque: boolean
    roundMask: boolean
  },
): Promise<Blob> {
  const size = params.size
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = requireContext(canvas, false)

  if (params.roundMask) {
    ctx.save()
    roundedRect(ctx, 0, 0, size, size, size * 0.225)
    ctx.clip()
  }

  if (params.opaque || params.backgroundColor !== '#00000000') {
    ctx.fillStyle = normalizeCanvasColor(params.backgroundColor)
    ctx.fillRect(0, 0, size, size)
  }

  const bounds = params.trim
    ? source.contentBounds
    : {
        x: 0,
        y: 0,
        width: source.width,
        height: source.height,
      }
  const paddedSize = Math.max(1, size * (1 - params.padding / 100))
  const drawScale =
    Math.min(paddedSize / bounds.width, paddedSize / bounds.height) * params.scale
  const drawWidth = bounds.width * drawScale
  const drawHeight = bounds.height * drawScale
  const dx = (size - drawWidth) / 2
  const dy = (size - drawHeight) / 2

  if (params.mode === 'notification-mask') {
    const mask = document.createElement('canvas')
    mask.width = size
    mask.height = size
    const maskCtx = requireContext(mask, true)
    maskCtx.drawImage(
      source.bitmap,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      dx,
      dy,
      drawWidth,
      drawHeight,
    )
    const imageData = maskCtx.getImageData(0, 0, size, size)
    applyNotificationMask(imageData, size, {
      x: dx,
      y: dy,
      width: drawWidth,
      height: drawHeight,
    })
    maskCtx.putImageData(imageData, 0, 0)
    ctx.drawImage(mask, 0, 0)
  } else {
    ctx.drawImage(
      source.bitmap,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      dx,
      dy,
      drawWidth,
      drawHeight,
    )
  }

  if (params.roundMask) {
    ctx.restore()
  }

  return canvasToBlob(canvas)
}

function applyNotificationMask(
  imageData: ImageData,
  canvasSize: number,
  drawRect: ImageBounds,
) {
  const data = imageData.data
  const background = estimateNotificationBackground(data, canvasSize, drawRect)
  const extractedAlpha = background
    ? buildBackgroundRemovedAlpha(data, canvasSize, drawRect, background)
    : null
  const alphaCoverage = extractedAlpha ? measureAlphaCoverage(extractedAlpha, canvasSize, drawRect) : 0
  const useExtractedAlpha = Boolean(
    extractedAlpha && alphaCoverage > 0.015 && alphaCoverage < 0.72,
  )
  const selectedAlpha = useExtractedAlpha ? extractedAlpha : null
  const finalAlpha = new Uint8ClampedArray(canvasSize * canvasSize)

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]
    const fallbackAlpha = background
      ? alpha *
        smoothStep(
          clamp(background.edgeDistanceMean + background.edgeDistanceStd * 1.2 + 8, 16, 70),
          112,
          colorDistance(data[index], data[index + 1], data[index + 2], background),
        )
      : alpha
    const nextAlpha = selectedAlpha
      ? selectedAlpha[index / 4]
      : fallbackAlpha

    finalAlpha[index / 4] = Math.round(clamp(nextAlpha, 0, 255))
  }

  const cleanedAlpha = background
    ? cleanNotificationEdgeAlpha(finalAlpha, canvasSize, drawRect)
    : finalAlpha

  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255
    data[index + 1] = 255
    data[index + 2] = 255
    data[index + 3] = cleanedAlpha[index / 4]
  }
}

function estimateNotificationBackground(
  data: Uint8ClampedArray,
  canvasSize: number,
  drawRect: ImageBounds,
): NotificationBackground | null {
  // Launcher icons often include an opaque tile; edge sampling separates that tile from the foreground mark.
  const rect = normalizeRect(drawRect, canvasSize)
  const edgeSize = Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.08))
  const bins = new Map<string, { count: number; r: number; g: number; b: number }>()
  let sampleCount = 0

  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x < rect.x + edgeSize ||
        x >= rect.x + rect.width - edgeSize ||
        y < rect.y + edgeSize ||
        y >= rect.y + rect.height - edgeSize
      if (!onEdge) {
        continue
      }

      const offset = (y * canvasSize + x) * 4
      const alpha = data[offset + 3]
      if (alpha < 180) {
        continue
      }

      const r = data[offset]
      const g = data[offset + 1]
      const b = data[offset + 2]
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`
      const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
      bin.count += 1
      bin.r += r
      bin.g += g
      bin.b += b
      bins.set(key, bin)
      sampleCount += 1
    }
  }

  if (sampleCount < Math.max(8, rect.width + rect.height)) {
    return null
  }

  const dominant = [...bins.values()].sort((a, b) => b.count - a.count)[0]
  const background = {
    r: dominant.r / dominant.count,
    g: dominant.g / dominant.count,
    b: dominant.b / dominant.count,
  }
  const dominantRatio = dominant.count / sampleCount
  const cornerConfidence = getCornerBackgroundConfidence(data, canvasSize, rect, background)
  const confidence = dominantRatio * 0.62 + cornerConfidence * 0.38

  if (confidence < 0.22) {
    return null
  }

  const edgeDistances: number[] = []
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x < rect.x + edgeSize ||
        x >= rect.x + rect.width - edgeSize ||
        y < rect.y + edgeSize ||
        y >= rect.y + rect.height - edgeSize
      if (!onEdge) {
        continue
      }
      const offset = (y * canvasSize + x) * 4
      if (data[offset + 3] < 180) {
        continue
      }
      edgeDistances.push(
        colorDistance(data[offset], data[offset + 1], data[offset + 2], background),
      )
    }
  }

  const edgeDistanceMean =
    edgeDistances.reduce((total, value) => total + value, 0) / Math.max(1, edgeDistances.length)
  const edgeDistanceStd = Math.sqrt(
    edgeDistances.reduce((total, value) => total + (value - edgeDistanceMean) ** 2, 0) /
      Math.max(1, edgeDistances.length),
  )

  return {
    ...background,
    confidence,
    edgeDistanceMean,
    edgeDistanceStd,
  }
}

function buildBackgroundRemovedAlpha(
  data: Uint8ClampedArray,
  canvasSize: number,
  drawRect: ImageBounds,
  background: NotificationBackground,
): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(canvasSize * canvasSize)
  const rect = normalizeRect(drawRect, canvasSize)
  const low = clamp(background.edgeDistanceMean + background.edgeDistanceStd * 1.4 + 10, 20, 78)
  const high = low + 46

  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const pixel = y * canvasSize + x
      const offset = pixel * 4
      const sourceAlpha = data[offset + 3]
      if (sourceAlpha <= 0) {
        continue
      }
      const distance = colorDistance(data[offset], data[offset + 1], data[offset + 2], background)
      alpha[pixel] = Math.round(sourceAlpha * smoothStep(low, high, distance))
    }
  }

  return alpha
}

function cleanNotificationEdgeAlpha(
  alpha: Uint8ClampedArray,
  canvasSize: number,
  drawRect: ImageBounds,
): Uint8ClampedArray {
  const cleaned = new Uint8ClampedArray(alpha)
  const rect = normalizeRect(drawRect, canvasSize)
  const edgeThreshold = getNotificationEdgeAlphaThreshold(cleaned, canvasSize, rect)

  removeEdgeConnectedAlpha(cleaned, canvasSize, rect, edgeThreshold)
  suppressLowAlpha(cleaned, 18)

  return cleaned
}

function getNotificationEdgeAlphaThreshold(
  alpha: Uint8ClampedArray,
  canvasSize: number,
  rect: ImageBounds,
): number {
  const values: number[] = []

  for (let x = rect.x; x < rect.x + rect.width; x += 1) {
    collectAlpha(alpha, canvasSize, x, rect.y, values)
    collectAlpha(alpha, canvasSize, x, rect.y + rect.height - 1, values)
  }

  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y += 1) {
    collectAlpha(alpha, canvasSize, rect.x, y, values)
    collectAlpha(alpha, canvasSize, rect.x + rect.width - 1, y, values)
  }

  if (!values.length) {
    return 96
  }

  values.sort((a, b) => a - b)
  const p90 = values[Math.floor((values.length - 1) * 0.9)]
  return Math.round(clamp(p90 + 28, 96, 220))
}

function collectAlpha(
  alpha: Uint8ClampedArray,
  canvasSize: number,
  x: number,
  y: number,
  values: number[],
) {
  const value = alpha[y * canvasSize + x]
  if (value > 0) {
    values.push(value)
  }
}

function removeEdgeConnectedAlpha(
  alpha: Uint8ClampedArray,
  canvasSize: number,
  rect: ImageBounds,
  threshold: number,
) {
  const visited = new Uint8Array(canvasSize * canvasSize)
  const queue: number[] = []

  const enqueue = (x: number, y: number) => {
    if (
      x < rect.x ||
      x >= rect.x + rect.width ||
      y < rect.y ||
      y >= rect.y + rect.height
    ) {
      return
    }

    const pixel = y * canvasSize + x
    if (visited[pixel] || alpha[pixel] === 0 || alpha[pixel] > threshold) {
      return
    }

    visited[pixel] = 1
    alpha[pixel] = 0
    queue.push(pixel)
  }

  for (let x = rect.x; x < rect.x + rect.width; x += 1) {
    enqueue(x, rect.y)
    enqueue(x, rect.y + rect.height - 1)
  }

  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y += 1) {
    enqueue(rect.x, y)
    enqueue(rect.x + rect.width - 1, y)
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pixel = queue[cursor]
    const x = pixel % canvasSize
    const y = Math.floor(pixel / canvasSize)
    enqueue(x - 1, y)
    enqueue(x + 1, y)
    enqueue(x, y - 1)
    enqueue(x, y + 1)
  }
}

function suppressLowAlpha(alpha: Uint8ClampedArray, threshold: number) {
  for (let index = 0; index < alpha.length; index += 1) {
    if (alpha[index] <= threshold) {
      alpha[index] = 0
    }
  }
}

function getCornerBackgroundConfidence(
  data: Uint8ClampedArray,
  canvasSize: number,
  rect: ImageBounds,
  background: RgbColor,
): number {
  const cornerSize = Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.16))
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width - cornerSize, rect.y],
    [rect.x, rect.y + rect.height - cornerSize],
    [rect.x + rect.width - cornerSize, rect.y + rect.height - cornerSize],
  ] as const
  let sampleCount = 0
  let matchingCount = 0

  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + cornerSize; y += 1) {
      for (let x = startX; x < startX + cornerSize; x += 1) {
        const offset = (y * canvasSize + x) * 4
        if (data[offset + 3] < 180) {
          continue
        }
        sampleCount += 1
        if (colorDistance(data[offset], data[offset + 1], data[offset + 2], background) < 54) {
          matchingCount += 1
        }
      }
    }
  }

  return sampleCount ? matchingCount / sampleCount : 0
}

function measureAlphaCoverage(
  alpha: Uint8ClampedArray,
  canvasSize: number,
  drawRect: ImageBounds,
): number {
  const rect = normalizeRect(drawRect, canvasSize)
  let visible = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (alpha[y * canvasSize + x] > 24) {
        visible += 1
      }
    }
  }

  return visible / Math.max(1, rect.width * rect.height)
}

function normalizeRect(rect: ImageBounds, canvasSize: number): ImageBounds {
  const x = clamp(Math.floor(rect.x), 0, canvasSize - 1)
  const y = clamp(Math.floor(rect.y), 0, canvasSize - 1)
  const maxX = clamp(Math.ceil(rect.x + rect.width), x + 1, canvasSize)
  const maxY = clamp(Math.ceil(rect.y + rect.height), y + 1, canvasSize)

  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
  }
}

function analyzeBitmap(bitmap: ImageBitmap): Pick<SourceImage, 'contentBounds' | 'hasTransparency'> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = requireContext(canvas, true)
  ctx.drawImage(bitmap, 0, 0)
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  const data = imageData.data

  let minX = bitmap.width
  let minY = bitmap.height
  let maxX = -1
  let maxY = -1
  let hasTransparency = false

  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const alpha = data[(y * bitmap.width + x) * 4 + 3]
      if (alpha < 250) {
        hasTransparency = true
      }
      if (alpha > 8) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return {
      contentBounds: {
        x: 0,
        y: 0,
        width: bitmap.width,
        height: bitmap.height,
      },
      hasTransparency,
    }
  }

  return {
    contentBounds: {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
    hasTransparency,
  }
}

async function makeImageAsset(
  asset: Omit<GeneratedAsset, 'dataUrl'>,
  includeDataUrl: boolean,
): Promise<GeneratedAsset> {
  return {
    ...asset,
    dataUrl: includeDataUrl ? await blobToDataUrl(asset.blob) : '',
  }
}

async function makeTextAsset({
  path,
  text,
  label,
  group,
  type,
}: TextJob): Promise<GeneratedAsset> {
  return {
    path,
    blob: new Blob([text], { type }),
    label,
    group,
    dataUrl: '',
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法从画布生成 PNG。'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取图像失败。'))
    reader.readAsDataURL(blob)
  })
}

function requireContext(
  canvas: HTMLCanvasElement,
  willReadFrequently: boolean,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', {
    willReadFrequently,
  })
  if (!ctx) {
    throw new Error('当前浏览器不支持 Canvas 2D。')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}

function normalizeCanvasColor(color: string): string {
  if (color.length === 9) {
    return `#${color.slice(7, 9)}${color.slice(1, 7)}`
  }

  return color
}

function normalizeOpaqueHex(color: string): string {
  if (!color.startsWith('#')) {
    return '#ffffff'
  }

  return `#${color.slice(1, 7).padEnd(6, 'f')}`
}

function colorDistance(r: number, g: number, b: number, target: RgbColor): number {
  return Math.sqrt((r - target.r) ** 2 + (g - target.g) ** 2 + (b - target.b) ** 2)
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  const x = clamp((value - edge0) / Math.max(1, edge1 - edge0), 0, 1)
  return x * x * (3 - 2 * x)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
