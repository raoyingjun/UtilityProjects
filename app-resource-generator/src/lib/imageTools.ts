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
  fileType: string
  fileSize: number
  contentBounds: ImageBounds
  hasTransparency: boolean
  stats: SourceImageStats
}

export type SourceImageStats = {
  visiblePixelRatio: number
  opaquePixelRatio: number
  contentAreaRatio: number
  contentWidthRatio: number
  contentHeightRatio: number
  edgeOpaqueRatio: number
  colorfulPixelRatio: number
  averageLuminance: number
}

export type GenerationOptions = {
  taskId: TaskId
  backgroundColor: string
  scale: number
  trim: boolean
  padding: number
  foregroundPercent: number
  monochrome: boolean
  enhanceLowResolution: boolean
  normalizeOutputFormat: boolean
  preserveTransparentLayers: boolean
  notificationAlphaMask: boolean
  removeSolidBackground: boolean
  flattenTransparency: boolean
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

// Linear (planar) model of the background per channel: value ≈ a·(x-cx) + b·(y-cy) + c.
// A single dominant colour cannot represent a gradient background, so the end of the gradient
// farthest from that colour survives as a residual band. Fitting a plane subtracts the gradient.
type ChannelPlanes = {
  cx: number
  cy: number
  r: [number, number, number]
  g: [number, number, number]
  b: [number, number, number]
}

type NotificationBackground = RgbColor & {
  confidence: number
  edgeDistanceMean: number
  edgeDistanceStd: number
  plane: ChannelPlanes | null
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

const MAX_SOURCE_PIXELS = 64_000_000
const ANALYSIS_PIXEL_LIMIT = 1_600_000
const EXPORT_RENDER_CONCURRENCY = 4

export function isSupportedImageFile(file: File): boolean {
  const type = (file.type || inferImageMimeType(file.name)).split(';')[0]?.trim().toLowerCase()
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/svg+xml'
}

export async function loadSourceImage(file: File): Promise<SourceImage> {
  const bitmap = await createImageBitmap(file)
  if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
    const size = `${bitmap.width}x${bitmap.height}`
    bitmap.close()
    throw new Error(`素材尺寸过大（${size}），请缩小到 8192x8192 以内后再导入。`)
  }
  const analysis = analyzeBitmap(bitmap)

  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    objectUrl: URL.createObjectURL(file),
    fileName: file.name,
    fileType: file.type || inferImageMimeType(file.name),
    fileSize: file.size,
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
  const assets: GeneratedAsset[] = new Array<GeneratedAsset>(jobs.length)
  const total = jobs.length
  let completed = 0

  config.onProgress?.({
    current: 0,
    total,
    percent: 0,
    label: '准备图像资源',
    phase: 'prepare',
  })

  async function runJob(job: AssetJob, index: number) {
    if ('render' in job) {
      const blob = await job.render()
      assets[index] = await makeImageAsset(
        {
          path: job.path,
          blob,
          width: job.width,
          height: job.height,
          label: job.label,
          group: job.group,
        },
        includeDataUrls,
      )
    } else {
      assets[index] = await makeTextAsset(job)
    }

    completed += 1
    config.onProgress?.({
      current: completed,
      total,
      percent: Math.round((completed / total) * 100),
      label: job.label,
      phase: completed === total ? 'done' : 'encode',
    })
  }

  // Canvas 绘制在主线程串行，PNG 编码（toBlob）在后台线程，并发可显著缩短导出耗时。
  let cursor = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(EXPORT_RENDER_CONCURRENCY, jobs.length)) },
    async () => {
      while (cursor < jobs.length) {
        const index = cursor
        cursor += 1
        await runJob(jobs[index], index)
      }
    },
  )
  await Promise.all(workers)

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
            enhanceLowResolution: options.enhanceLowResolution,
            removeSolidBackground: false,
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
            enhanceLowResolution: options.enhanceLowResolution,
            removeSolidBackground: false,
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
            backgroundColor: options.preserveTransparentLayers ? '#00000000' : options.backgroundColor,
            scale: options.foregroundPercent / 100,
            trim: options.trim,
            padding: options.padding,
            enhanceLowResolution: options.enhanceLowResolution,
            removeSolidBackground: false,
            mode: 'contain',
            opaque: false,
            roundMask: false,
          }),
      },
    )

    if (options.monochrome) {
      jobs.push({
        path: `android/app/src/main/res/drawable-${spec.density}/ic_launcher_monochrome.png`,
        width: spec.adaptivePx,
        height: spec.adaptivePx,
        label: `${spec.density} 主题单色层`,
        group: '主题图标单色层',
        render: () =>
          renderPng(source, {
            size: spec.adaptivePx,
            backgroundColor: '#00000000',
            scale: options.foregroundPercent / 100,
            trim: options.trim,
            padding: options.padding,
            enhanceLowResolution: options.enhanceLowResolution,
            removeSolidBackground: options.removeSolidBackground,
            mode: 'notification-mask',
            opaque: false,
            roundMask: false,
          }),
      })
    }
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
        enhanceLowResolution: options.enhanceLowResolution,
        removeSolidBackground: options.removeSolidBackground,
        mode: options.notificationAlphaMask ? 'notification-mask' : 'contain',
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
        backgroundColor: options.flattenTransparency ? options.backgroundColor : '#00000000',
        scale: options.scale,
        trim: options.trim,
        padding: options.padding,
        enhanceLowResolution: options.enhanceLowResolution,
        removeSolidBackground: false,
        mode: 'contain',
        opaque: options.flattenTransparency,
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
    ? '\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />'
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
    enhanceLowResolution: boolean
    removeSolidBackground: boolean
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
    // ic_launcher_round must be a full circle: launchers that use android:roundIcon apply a
    // circular mask, so the asset itself is a circle (diameter = icon size), not a rounded square.
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.clip()
  }

  if (params.opaque || params.backgroundColor !== '#00000000') {
    // Canvas fillStyle 直接支持 CSS #RRGGBB / #RRGGBBAA 十六进制。
    ctx.fillStyle = params.opaque ? normalizeOpaqueHex(params.backgroundColor) : params.backgroundColor
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
  const drawRect: ImageBounds = { x: dx, y: dy, width: drawWidth, height: drawHeight }
  // Only the upscaling case benefits: enhancing means Lanczos reconstruction + unsharp acutance.
  const upscaleRatio = Math.max(drawWidth / bounds.width, drawHeight / bounds.height)
  const useEnhance = params.enhanceLowResolution && upscaleRatio > 1.12

  if (params.mode === 'notification-mask') {
    const mask = document.createElement('canvas')
    mask.width = size
    mask.height = size
    const maskCtx = requireContext(mask, true)
    drawScaledSource(maskCtx, source, bounds, drawRect, useEnhance)
    const imageData = maskCtx.getImageData(0, 0, size, size)
    applyNotificationMask(imageData, size, drawRect, params.removeSolidBackground)
    maskCtx.putImageData(imageData, 0, 0)
    ctx.drawImage(mask, 0, 0)
  } else {
    drawScaledSource(ctx, source, bounds, drawRect, useEnhance)
  }

  if (useEnhance) {
    enhanceLowResolutionCanvas(ctx, size, drawRect, params.mode === 'notification-mask')
  }

  if (params.roundMask) {
    ctx.restore()
  }

  return canvasToBlob(canvas)
}

// When upscaling a low-resolution source, canvas drawImage falls back to bilinear interpolation,
// which looks soft. A Lanczos-3 (windowed-sinc) resample reconstructs sharper edges — the same
// high-quality filter ImageMagick/GIMP use — with premultiplied alpha so transparent icon edges
// don't fringe. For downscaling or when enhancement is off we keep the native drawImage path.
function drawScaledSource(
  ctx: CanvasRenderingContext2D,
  source: SourceImage,
  bounds: ImageBounds,
  drawRect: ImageBounds,
  useLanczos: boolean,
) {
  if (!useLanczos) {
    ctx.drawImage(
      source.bitmap,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      drawRect.x,
      drawRect.y,
      drawRect.width,
      drawRect.height,
    )
    return
  }

  const srcWidth = Math.max(1, Math.round(bounds.width))
  const srcHeight = Math.max(1, Math.round(bounds.height))
  const dstWidth = Math.max(1, Math.round(drawRect.width))
  const dstHeight = Math.max(1, Math.round(drawRect.height))

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = srcWidth
  srcCanvas.height = srcHeight
  const srcCtx = requireContext(srcCanvas, true)
  srcCtx.imageSmoothingEnabled = false
  srcCtx.drawImage(source.bitmap, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, srcWidth, srcHeight)
  const srcData = srcCtx.getImageData(0, 0, srcWidth, srcHeight)

  const resized = resizeLanczos(srcData.data, srcWidth, srcHeight, dstWidth, dstHeight)
  const scaled = document.createElement('canvas')
  scaled.width = dstWidth
  scaled.height = dstHeight
  const scaledCtx = requireContext(scaled, true)
  const scaledImage = scaledCtx.createImageData(dstWidth, dstHeight)
  scaledImage.data.set(resized)
  scaledCtx.putImageData(scaledImage, 0, 0)
  // Draw at rounded offsets so freshly sharpened pixels aren't re-blurred by sub-pixel placement.
  ctx.drawImage(scaled, Math.round(drawRect.x), Math.round(drawRect.y))
}

export const LANCZOS_WINDOW = 3

// Lanczos-3 kernel: sinc(x) * sinc(x / a), zero outside [-a, a]. The reconstruction filter that
// keeps upscaled edges crisp instead of bilinear-soft. Exported for deterministic unit testing.
export function lanczosKernel(x: number): number {
  if (x === 0) {
    return 1
  }
  if (Math.abs(x) >= LANCZOS_WINDOW) {
    return 0
  }
  const piX = Math.PI * x
  return (LANCZOS_WINDOW * Math.sin(piX) * Math.sin(piX / LANCZOS_WINDOW)) / (piX * piX)
}

type AxisContribution = {
  start: number
  weights: number[]
}

function buildAxisContributions(srcLength: number, dstLength: number): AxisContribution[] {
  const scale = dstLength / srcLength
  const invScale = 1 / scale
  // Downscaling widens the support to anti-alias; upscaling keeps the native window.
  const filterScale = scale < 1 ? scale : 1
  const support = LANCZOS_WINDOW / filterScale
  const contributions: AxisContribution[] = new Array(dstLength)

  for (let i = 0; i < dstLength; i += 1) {
    const center = (i + 0.5) * invScale - 0.5
    const start = Math.max(0, Math.floor(center - support))
    const end = Math.min(srcLength - 1, Math.ceil(center + support))
    const weights: number[] = []
    let sum = 0

    for (let j = start; j <= end; j += 1) {
      const weight = lanczosKernel((j - center) * filterScale)
      weights.push(weight)
      sum += weight
    }

    if (sum !== 0) {
      for (let k = 0; k < weights.length; k += 1) {
        weights[k] /= sum
      }
    }

    contributions[i] = { start, weights }
  }

  return contributions
}

// High-quality separable Lanczos resample with premultiplied alpha. Works on raw RGBA bytes so it
// runs off the main canvas and stays deterministic (unit-testable without a DOM).
export function resizeLanczos(
  src: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8ClampedArray {
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    return new Uint8ClampedArray(src)
  }

  const pixelCount = srcWidth * srcHeight
  const premultiplied = new Float32Array(pixelCount * 4)
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4
    const alpha = src[offset + 3] / 255
    premultiplied[offset] = src[offset] * alpha
    premultiplied[offset + 1] = src[offset + 1] * alpha
    premultiplied[offset + 2] = src[offset + 2] * alpha
    premultiplied[offset + 3] = src[offset + 3]
  }

  // Horizontal pass: srcWidth -> dstWidth.
  const horizontal = new Float32Array(dstWidth * srcHeight * 4)
  const xContrib = buildAxisContributions(srcWidth, dstWidth)
  for (let y = 0; y < srcHeight; y += 1) {
    for (let x = 0; x < dstWidth; x += 1) {
      const contribution = xContrib[x]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < contribution.weights.length; k += 1) {
        const sampleOffset = (y * srcWidth + contribution.start + k) * 4
        const weight = contribution.weights[k]
        r += premultiplied[sampleOffset] * weight
        g += premultiplied[sampleOffset + 1] * weight
        b += premultiplied[sampleOffset + 2] * weight
        a += premultiplied[sampleOffset + 3] * weight
      }
      const target = (y * dstWidth + x) * 4
      horizontal[target] = r
      horizontal[target + 1] = g
      horizontal[target + 2] = b
      horizontal[target + 3] = a
    }
  }

  // Vertical pass: srcHeight -> dstHeight, then un-premultiply back to straight alpha.
  const output = new Uint8ClampedArray(dstWidth * dstHeight * 4)
  const yContrib = buildAxisContributions(srcHeight, dstHeight)
  for (let x = 0; x < dstWidth; x += 1) {
    for (let y = 0; y < dstHeight; y += 1) {
      const contribution = yContrib[y]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < contribution.weights.length; k += 1) {
        const sampleOffset = ((contribution.start + k) * dstWidth + x) * 4
        const weight = contribution.weights[k]
        r += horizontal[sampleOffset] * weight
        g += horizontal[sampleOffset + 1] * weight
        b += horizontal[sampleOffset + 2] * weight
        a += horizontal[sampleOffset + 3] * weight
      }
      const target = (y * dstWidth + x) * 4
      const alpha = clamp(a, 0, 255)
      const unpremultiply = alpha > 0 ? 255 / alpha : 0
      output[target] = r * unpremultiply
      output[target + 1] = g * unpremultiply
      output[target + 2] = b * unpremultiply
      output[target + 3] = alpha
    }
  }

  return output
}

function applyNotificationMask(
  imageData: ImageData,
  canvasSize: number,
  drawRect: ImageBounds,
  removeSolidBackground: boolean,
) {
  const data = imageData.data
  // A source with virtually no transparency has no silhouette in its alpha channel; painted
  // white it would collapse into a solid block (the reported "白色背景块"). Force background
  // extraction for such opaque sources — e.g. a full-bleed app icon reused for notifications —
  // so they still yield a legible white silhouette regardless of the removeSolidBackground toggle.
  const opaqueCoverage = measureOpaqueCoverage(data, canvasSize, drawRect)
  const shouldRemoveBackground = removeSolidBackground || opaqueCoverage > 0.92
  const background = shouldRemoveBackground
    ? estimateNotificationBackground(data, canvasSize, drawRect)
    : null
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
    const pixel = index / 4
    const fallbackAlpha = background
      ? alpha *
        smoothStep(
          clamp(background.edgeDistanceMean + background.edgeDistanceStd * 1.2 + 8, 16, 70),
          112,
          backgroundDistanceAt(
            background,
            pixel % canvasSize,
            Math.floor(pixel / canvasSize),
            data[index],
            data[index + 1],
            data[index + 2],
          ),
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

function enhanceLowResolutionCanvas(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  drawRect: ImageBounds,
  sharpenAlpha: boolean,
) {
  const imageData = ctx.getImageData(0, 0, canvasSize, canvasSize)
  const data = imageData.data
  const original = new Uint8ClampedArray(data)
  const rect = normalizeRect(
    {
      x: drawRect.x - 1,
      y: drawRect.y - 1,
      width: drawRect.width + 2,
      height: drawRect.height + 2,
    },
    canvasSize,
  )
  const amount = sharpenAlpha ? 0.42 : 0.58
  const threshold = sharpenAlpha ? 2 : 4

  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const pixel = y * canvasSize + x
      const offset = pixel * 4
      const sourceAlpha = original[offset + 3]
      if (sourceAlpha <= 4) {
        continue
      }

      for (let channel = 0; channel < 3; channel += 1) {
        data[offset + channel] = sharpenChannel(
          original,
          canvasSize,
          x,
          y,
          channel,
          amount,
          threshold,
        )
      }

      if (sharpenAlpha) {
        data[offset + 3] = sharpenChannel(
          original,
          canvasSize,
          x,
          y,
          3,
          amount * 0.72,
          threshold,
        )
      } else {
        data[offset + 3] = sourceAlpha
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
}

function sharpenChannel(
  data: Uint8ClampedArray,
  canvasSize: number,
  x: number,
  y: number,
  channel: number,
  amount: number,
  threshold: number,
): number {
  const center = sampleChannel(data, canvasSize, x, y, channel)
  const blur =
    (center * 4 +
      sampleChannel(data, canvasSize, x - 1, y, channel) * 2 +
      sampleChannel(data, canvasSize, x + 1, y, channel) * 2 +
      sampleChannel(data, canvasSize, x, y - 1, channel) * 2 +
      sampleChannel(data, canvasSize, x, y + 1, channel) * 2 +
      sampleChannel(data, canvasSize, x - 1, y - 1, channel) +
      sampleChannel(data, canvasSize, x + 1, y - 1, channel) +
      sampleChannel(data, canvasSize, x - 1, y + 1, channel) +
      sampleChannel(data, canvasSize, x + 1, y + 1, channel)) /
    16
  const diff = center - blur

  if (Math.abs(diff) < threshold) {
    return center
  }

  return Math.round(clamp(center + diff * amount, 0, 255))
}

function sampleChannel(
  data: Uint8ClampedArray,
  canvasSize: number,
  x: number,
  y: number,
  channel: number,
): number {
  const sx = clamp(x, 0, canvasSize - 1)
  const sy = clamp(y, 0, canvasSize - 1)
  return data[(sy * canvasSize + sx) * 4 + channel]
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
  const sampleX: number[] = []
  const sampleY: number[] = []
  const sampleR: number[] = []
  const sampleG: number[] = []
  const sampleB: number[] = []
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
      sampleX.push(x)
      sampleY.push(y)
      sampleR.push(r)
      sampleG.push(g)
      sampleB.push(b)
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

  const plane = fitBackgroundPlanes(rect, sampleX, sampleY, sampleR, sampleG, sampleB)
  const model: NotificationBackground = {
    ...background,
    confidence,
    edgeDistanceMean: 0,
    edgeDistanceStd: 0,
    plane,
  }

  // Residuals are now measured against the local (planar) background, so a clean gradient collapses
  // to near-zero noise and the removal thresholds stay tight instead of straddling the gradient.
  const edgeDistances = new Array<number>(sampleCount)
  for (let i = 0; i < sampleCount; i += 1) {
    edgeDistances[i] = backgroundDistanceAt(model, sampleX[i], sampleY[i], sampleR[i], sampleG[i], sampleB[i])
  }

  const edgeDistanceMean =
    edgeDistances.reduce((total, value) => total + value, 0) / Math.max(1, edgeDistances.length)
  const edgeDistanceStd = Math.sqrt(
    edgeDistances.reduce((total, value) => total + (value - edgeDistanceMean) ** 2, 0) /
      Math.max(1, edgeDistances.length),
  )

  model.edgeDistanceMean = edgeDistanceMean
  model.edgeDistanceStd = edgeDistanceStd
  return model
}

// Least-squares fit of a background plane per channel, with one robust refit that drops samples far
// from the initial fit (e.g. a foreground mark that reaches the sampled edge ring).
function fitBackgroundPlanes(
  rect: ImageBounds,
  xs: number[],
  ys: number[],
  rs: number[],
  gs: number[],
  bs: number[],
): ChannelPlanes | null {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dx = xs.map((x) => x - cx)
  const dy = ys.map((y) => y - cy)

  let coeffs = solvePlanes(dx, dy, rs, gs, bs)
  if (!coeffs) {
    return null
  }

  const residuals = dx.map((_, i) => planeResidual(coeffs!, dx[i], dy[i], rs[i], gs[i], bs[i]))
  const meanResidual = residuals.reduce((total, value) => total + value, 0) / residuals.length
  const cutoff = meanResidual * 2 + 24
  const kdx: number[] = []
  const kdy: number[] = []
  const kr: number[] = []
  const kg: number[] = []
  const kb: number[] = []
  for (let i = 0; i < residuals.length; i += 1) {
    if (residuals[i] <= cutoff) {
      kdx.push(dx[i])
      kdy.push(dy[i])
      kr.push(rs[i])
      kg.push(gs[i])
      kb.push(bs[i])
    }
  }

  if (kdx.length >= Math.max(12, residuals.length * 0.5) && kdx.length < residuals.length) {
    coeffs = solvePlanes(kdx, kdy, kr, kg, kb) ?? coeffs
  }

  return { cx, cy, ...coeffs }
}

function solvePlanes(
  dx: number[],
  dy: number[],
  rs: number[],
  gs: number[],
  bs: number[],
): Pick<ChannelPlanes, 'r' | 'g' | 'b'> | null {
  const r = fitPlaneChannel(dx, dy, rs)
  const g = fitPlaneChannel(dx, dy, gs)
  const b = fitPlaneChannel(dx, dy, bs)
  if (!r || !g || !b) {
    return null
  }
  return { r, g, b }
}

function planeResidual(
  coeffs: Pick<ChannelPlanes, 'r' | 'g' | 'b'>,
  dx: number,
  dy: number,
  r: number,
  g: number,
  b: number,
): number {
  const pr = coeffs.r[0] * dx + coeffs.r[1] * dy + coeffs.r[2]
  const pg = coeffs.g[0] * dx + coeffs.g[1] * dy + coeffs.g[2]
  const pb = coeffs.b[0] * dx + coeffs.b[1] * dy + coeffs.b[2]
  return Math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2)
}

// Least-squares plane v ≈ a·dx + b·dy + c via the 3x3 normal equations. Returns null if degenerate.
export function fitPlaneChannel(
  dx: number[],
  dy: number[],
  vs: number[],
): [number, number, number] | null {
  let sxx = 0
  let sxy = 0
  let sx = 0
  let syy = 0
  let sy = 0
  let sxv = 0
  let syv = 0
  let sv = 0
  const n = vs.length
  for (let i = 0; i < n; i += 1) {
    const x = dx[i]
    const y = dy[i]
    const v = vs[i]
    sxx += x * x
    sxy += x * y
    sx += x
    syy += y * y
    sy += y
    sxv += x * v
    syv += y * v
    sv += v
  }

  return solveLinear3([sxx, sxy, sx, sxy, syy, sy, sx, sy, n], [sxv, syv, sv])
}

// Gaussian elimination with partial pivoting for a 3x3 system (row-major matrix + rhs).
function solveLinear3(m: number[], v: number[]): [number, number, number] | null {
  const a = [
    [m[0], m[1], m[2], v[0]],
    [m[3], m[4], m[5], v[1]],
    [m[6], m[7], m[8], v[2]],
  ]

  for (let col = 0; col < 3; col += 1) {
    let pivot = col
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-8) {
      return null
    }
    const swap = a[col]
    a[col] = a[pivot]
    a[pivot] = swap
    for (let row = 0; row < 3; row += 1) {
      if (row === col) {
        continue
      }
      const factor = a[row][col] / a[col][col]
      for (let c = col; c < 4; c += 1) {
        a[row][c] -= factor * a[col][c]
      }
    }
  }

  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]]
}

function backgroundColorAt(background: NotificationBackground, x: number, y: number): RgbColor {
  const plane = background.plane
  if (!plane) {
    return { r: background.r, g: background.g, b: background.b }
  }
  const dx = x - plane.cx
  const dy = y - plane.cy
  return {
    r: clamp(plane.r[0] * dx + plane.r[1] * dy + plane.r[2], 0, 255),
    g: clamp(plane.g[0] * dx + plane.g[1] * dy + plane.g[2], 0, 255),
    b: clamp(plane.b[0] * dx + plane.b[1] * dy + plane.b[2], 0, 255),
  }
}

function backgroundDistanceAt(
  background: NotificationBackground,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): number {
  return colorDistance(r, g, b, backgroundColorAt(background, x, y))
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
      const distance = backgroundDistanceAt(background, x, y, data[offset], data[offset + 1], data[offset + 2])
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

// Fraction of the drawn area that is (near-)fully opaque in the source. When this is close
// to 1 the source carries no silhouette in its alpha channel, so a plain white-fill mask
// would collapse into a solid block.
function measureOpaqueCoverage(
  data: Uint8ClampedArray,
  canvasSize: number,
  drawRect: ImageBounds,
): number {
  const rect = normalizeRect(drawRect, canvasSize)
  let opaque = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (data[(y * canvasSize + x) * 4 + 3] > 232) {
        opaque += 1
      }
    }
  }

  return opaque / Math.max(1, rect.width * rect.height)
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

function analyzeBitmap(
  bitmap: ImageBitmap,
): Pick<SourceImage, 'contentBounds' | 'hasTransparency' | 'stats'> {
  // 超大素材按比例缩小后分析，统计比率不变，内容边界再映射回源图坐标。
  const analysisScale = Math.min(1, Math.sqrt(ANALYSIS_PIXEL_LIMIT / (bitmap.width * bitmap.height)))
  const width = Math.max(1, Math.round(bitmap.width * analysisScale))
  const height = Math.max(1, Math.round(bitmap.height * analysisScale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = requireContext(canvas, true)
  ctx.drawImage(bitmap, 0, 0, width, height)
  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let hasTransparency = false
  let visiblePixels = 0
  let opaquePixels = 0
  let edgeSamples = 0
  let edgeOpaqueSamples = 0
  let colorfulPixels = 0
  let luminanceTotal = 0
  const edgeInset = Math.max(1, Math.round(Math.min(width, height) * 0.06))

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const r = data[offset]
      const g = data[offset + 1]
      const b = data[offset + 2]
      const alpha = data[offset + 3]
      if (alpha < 250) {
        hasTransparency = true
      }
      if (alpha > 8) {
        visiblePixels += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      if (alpha > 250) {
        opaquePixels += 1
      }

      const onEdge =
        x < edgeInset ||
        x >= width - edgeInset ||
        y < edgeInset ||
        y >= height - edgeInset
      if (onEdge) {
        edgeSamples += 1
        if (alpha > 250) {
          edgeOpaqueSamples += 1
        }
      }

      if (alpha > 24) {
        const maxChannel = Math.max(r, g, b)
        const minChannel = Math.min(r, g, b)
        const saturation = maxChannel === 0 ? 0 : (maxChannel - minChannel) / maxChannel
        if (saturation > 0.18 && maxChannel - minChannel > 28) {
          colorfulPixels += 1
        }
        luminanceTotal += relativeLuminance(r, g, b)
      }
    }
  }

  const totalPixels = Math.max(1, width * height)
  const visiblePixelRatio = visiblePixels / totalPixels
  const sampledBounds =
    maxX < 0 || maxY < 0
      ? {
          x: 0,
          y: 0,
          width,
          height,
        }
      : {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        }
  const stats: SourceImageStats = {
    visiblePixelRatio,
    opaquePixelRatio: opaquePixels / totalPixels,
    contentAreaRatio: (sampledBounds.width * sampledBounds.height) / totalPixels,
    contentWidthRatio: sampledBounds.width / Math.max(1, width),
    contentHeightRatio: sampledBounds.height / Math.max(1, height),
    edgeOpaqueRatio: edgeOpaqueSamples / Math.max(1, edgeSamples),
    colorfulPixelRatio: colorfulPixels / Math.max(1, visiblePixels),
    averageLuminance: luminanceTotal / Math.max(1, visiblePixels),
  }

  return {
    contentBounds: mapBoundsToSource(sampledBounds, width, height, bitmap),
    hasTransparency,
    stats,
  }
}

function mapBoundsToSource(
  sampledBounds: ImageBounds,
  sampledWidth: number,
  sampledHeight: number,
  bitmap: ImageBitmap,
): ImageBounds {
  if (sampledWidth === bitmap.width && sampledHeight === bitmap.height) {
    return sampledBounds
  }

  const scaleX = bitmap.width / sampledWidth
  const scaleY = bitmap.height / sampledHeight
  // 外扩 1 个采样像素，避免降采样丢失细窄边缘。
  const x = clamp(Math.floor((sampledBounds.x - 1) * scaleX), 0, bitmap.width - 1)
  const y = clamp(Math.floor((sampledBounds.y - 1) * scaleY), 0, bitmap.height - 1)
  const maxX = clamp(Math.ceil((sampledBounds.x + sampledBounds.width + 1) * scaleX), x + 1, bitmap.width)
  const maxY = clamp(Math.ceil((sampledBounds.y + sampledBounds.height + 1) * scaleY), y + 1, bitmap.height)

  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
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

function normalizeOpaqueHex(color: string): string {
  if (!color.startsWith('#')) {
    return '#ffffff'
  }

  const hex = color.slice(1).toLowerCase()
  if (hex.length === 3 || hex.length === 4) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
  }

  if (hex.length >= 6 && /^[0-9a-f]{6}/.test(hex)) {
    return `#${hex.slice(0, 6)}`
  }

  return '#ffffff'
}

function inferImageMimeType(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (extension === 'png') {
    return 'image/png'
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg'
  }
  if (extension === 'webp') {
    return 'image/webp'
  }
  if (extension === 'svg') {
    return 'image/svg+xml'
  }

  return 'image/*'
}

function relativeLuminance(r: number, g: number, b: number): number {
  const srgb = [r, g, b].map((value) => {
    const channel = value / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })

  return srgb[0] * 0.2126 + srgb[1] * 0.7152 + srgb[2] * 0.0722
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
