import { describe, expect, it } from 'vitest'
import {
  assignGenerationOption,
  buildSourceFixPlan,
  isFixableItem,
  type SourceFixPlanConfig,
} from './sourceDiagnostics'
import type { GenerationOptions, SourceImage, SourceImageStats } from './imageTools'
import type { TaskId } from './iconSpecs'

const BASE_STATS: SourceImageStats = {
  visiblePixelRatio: 0.5,
  opaquePixelRatio: 0.5,
  contentAreaRatio: 0.7,
  contentWidthRatio: 0.8,
  contentHeightRatio: 0.8,
  edgeOpaqueRatio: 0.5,
  colorfulPixelRatio: 0.02,
  averageLuminance: 0.5,
}

type SourceOverrides = Partial<Omit<SourceImage, 'stats'>> & {
  stats?: Partial<SourceImageStats>
}

function makeSource(overrides: SourceOverrides = {}): SourceImage {
  const stats: SourceImageStats = { ...BASE_STATS, ...(overrides.stats ?? {}) }
  return {
    // bitmap is never touched by buildSourceFixPlan; a stub keeps the type happy.
    bitmap: {} as ImageBitmap,
    width: 1024,
    height: 1024,
    objectUrl: 'blob:stub',
    fileName: 'icon.png',
    fileType: 'image/png',
    fileSize: 1000,
    contentBounds: { x: 0, y: 0, width: 1024, height: 1024 },
    hasTransparency: false,
    ...overrides,
    stats,
  }
}

function makeOptions(overrides: Partial<GenerationOptions> = {}): GenerationOptions {
  return {
    taskId: 'ios-launcher',
    backgroundColor: '#ffffff',
    scale: 0.8,
    trim: false,
    padding: 0,
    foregroundPercent: 60,
    monochrome: false,
    enhanceLowResolution: false,
    normalizeOutputFormat: true,
    preserveTransparentLayers: false,
    notificationAlphaMask: false,
    removeSolidBackground: false,
    flattenTransparency: false,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<SourceFixPlanConfig> = {}): SourceFixPlanConfig {
  return {
    task: 'ios-launcher',
    source: makeSource(),
    options: makeOptions(),
    notificationSourceMode: 'custom',
    ...overrides,
  }
}

function ids(plan: ReturnType<typeof buildSourceFixPlan>): string[] {
  return plan.items.map((item) => item.id)
}

describe('buildSourceFixPlan — ready state', () => {
  it('reports a single ok item when a clean square PNG needs no fixes', () => {
    const plan = buildSourceFixPlan(makeConfig())
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].kind).toBe('ok')
    expect(plan.items[0].id).toBe('source-ready')
    expect(plan.canApply).toBe(false)
    expect(plan.fixCount).toBe(0)
    expect(plan.autoCount).toBe(0)
    expect(plan.summary).toBe('素材已符合当前要求')
    expect(Object.keys(plan.patch)).toHaveLength(0)
  })
})

describe('buildSourceFixPlan — format handling', () => {
  it('adds an auto note when the source is a non-PNG raster that will be re-encoded', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ fileType: 'image/webp' }) }),
    )
    expect(ids(plan)).toContain('format-normalized')
    const item = plan.items.find((i) => i.id === 'format-normalized')!
    expect(item.kind).toBe('auto')
  })

  it('adds an auto note for SVG explaining rasterisation', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ fileType: 'image/svg+xml' }) }),
    )
    const item = plan.items.find((i) => i.id === 'format-normalized')!
    expect(item.detail).toContain('SVG')
  })

  it('flags an unsupported format as potentially undecodable', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ fileType: 'image/gif' }) }),
    )
    expect(ids(plan)).toContain('format-unsupported')
  })

  it('normalises mime types with parameters and casing', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ fileType: 'IMAGE/PNG; charset=binary' }) }),
    )
    // PNG needs no format note at all.
    expect(ids(plan)).not.toContain('format-normalized')
    expect(ids(plan)).not.toContain('format-unsupported')
  })
})

describe('buildSourceFixPlan — geometry fixes', () => {
  it('offers a square-canvas fix that enables trim when the source is non-square', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ width: 1024, height: 768 }) }),
    )
    const item = plan.items.find((i) => i.id === 'canvas-square')!
    expect(isFixableItem(item)).toBe(true)
    expect(item.patch).toEqual({ trim: true })
    expect(plan.actionLabels).toContain('修正画布比例')
  })

  it('offers a low-resolution enhancement when a raster is below the target size', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ width: 512, height: 512 }) }),
    )
    const item = plan.items.find((i) => i.id === 'source-size')!
    expect(isFixableItem(item)).toBe(true)
    expect(item.patch).toEqual({ enhanceLowResolution: true })
  })

  it('does not flag low resolution for a scalable SVG', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        source: makeSource({ width: 64, height: 64, fileType: 'image/svg+xml' }),
      }),
    )
    expect(ids(plan)).not.toContain('source-size')
  })

  it('uses the 96px notification threshold rather than 1024 for notification tasks', () => {
    const smallButOk = buildSourceFixPlan(
      makeConfig({
        task: 'android-notification',
        options: makeOptions({ taskId: 'android-notification' }),
        source: makeSource({ width: 128, height: 128, hasTransparency: true }),
      }),
    )
    expect(ids(smallButOk)).not.toContain('source-size')

    // Below the 96px notification target it is flagged.
    const tooSmall = buildSourceFixPlan(
      makeConfig({
        task: 'android-notification',
        options: makeOptions({ taskId: 'android-notification' }),
        source: makeSource({ width: 80, height: 80, hasTransparency: true }),
      }),
    )
    expect(ids(tooSmall)).toContain('source-size')
  })

  it('flags android-launcher against its real 432px max output, not a hardcoded 1024', () => {
    // 600px exceeds every android-launcher raster (largest is the 432px adaptive foreground),
    // so upscaling/enhancement would be a no-op — it must not be flagged as low resolution.
    const okSource = buildSourceFixPlan(
      makeConfig({
        task: 'android-launcher',
        options: makeOptions({ taskId: 'android-launcher' }),
        source: makeSource({ width: 600, height: 600 }),
      }),
    )
    expect(ids(okSource)).not.toContain('source-size')

    // 320px is below the 432px output, so enhancement is genuinely applicable.
    const lowSource = buildSourceFixPlan(
      makeConfig({
        task: 'android-launcher',
        options: makeOptions({ taskId: 'android-launcher' }),
        source: makeSource({ width: 320, height: 320 }),
      }),
    )
    const item = lowSource.items.find((i) => i.id === 'source-size')!
    expect(isFixableItem(item)).toBe(true)
    // The wording must not promise a 1024px target that android-launcher never produces.
    expect(item.detail).not.toContain('1024')
    expect(item.detail).toContain('432')
  })

  it('keeps the accurate 1024px target wording for iOS', () => {
    const plan = buildSourceFixPlan(
      makeConfig({ source: makeSource({ width: 512, height: 512 }) }),
    )
    const item = plan.items.find((i) => i.id === 'source-size')!
    expect(item.detail).toContain('1024x1024')
  })
})

describe('buildSourceFixPlan — android launcher', () => {
  it('offers background, monochrome and safe-zone fixes for a transparent edge-to-edge icon', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        task: 'android-launcher',
        options: makeOptions({
          taskId: 'android-launcher',
          backgroundColor: '#00000000',
          scale: 0.95,
          padding: 0,
          foregroundPercent: 80,
        }),
        source: makeSource({
          hasTransparency: true,
          stats: { contentWidthRatio: 0.98, contentHeightRatio: 0.98, contentAreaRatio: 0.9 },
        }),
      }),
    )
    expect(ids(plan)).toContain('android-safe-zone')
    expect(ids(plan)).toContain('android-background')
    expect(ids(plan)).toContain('android-monochrome')

    const background = plan.items.find((i) => i.id === 'android-background')!
    expect(background.patch).toEqual({ backgroundColor: '#f4f7fb' })

    const monochrome = plan.items.find((i) => i.id === 'android-monochrome')!
    expect(monochrome.patch).toEqual({ monochrome: true })

    const safeZone = plan.items.find((i) => i.id === 'android-safe-zone')!
    expect(safeZone.patch).toMatchObject({
      scale: 0.82,
      padding: 8,
      foregroundPercent: 66,
    })
  })

  it('demotes the monochrome fix to an ok note when monochrome is already enabled', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        task: 'android-launcher',
        options: makeOptions({ taskId: 'android-launcher', monochrome: true }),
      }),
    )
    const item = plan.items.find((i) => i.id === 'android-monochrome')
    // With monochrome already true the patch is empty, so it degrades to a non-fixable note.
    if (item) {
      expect(isFixableItem(item)).toBe(false)
    }
  })
})

describe('buildSourceFixPlan — android notification', () => {
  it('adds an auto colour note for a colourful source', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        task: 'android-notification',
        options: makeOptions({ taskId: 'android-notification' }),
        source: makeSource({
          hasTransparency: true,
          stats: { colorfulPixelRatio: 0.3 },
        }),
      }),
    )
    const item = plan.items.find((i) => i.id === 'notification-color')!
    expect(item.kind).toBe('auto')
  })

  it('auto-samples background for an app-derived icon but offers a fix for custom sources', () => {
    const appPlan = buildSourceFixPlan(
      makeConfig({
        task: 'android-notification',
        notificationSourceMode: 'app',
        options: makeOptions({ taskId: 'android-notification' }),
        source: makeSource({ hasTransparency: false }),
      }),
    )
    const appItem = appPlan.items.find((i) => i.id === 'notification-background')!
    expect(appItem.kind).toBe('auto')

    const customPlan = buildSourceFixPlan(
      makeConfig({
        task: 'android-notification',
        notificationSourceMode: 'custom',
        options: makeOptions({ taskId: 'android-notification' }),
        source: makeSource({ hasTransparency: false }),
      }),
    )
    const customItem = customPlan.items.find((i) => i.id === 'notification-background')!
    expect(customItem.kind).toBe('fix')
    expect(customItem.patch).toMatchObject({ removeSolidBackground: true })
  })
})

describe('buildSourceFixPlan — ios launcher', () => {
  it('adds an alpha-flatten note and removes export padding for a padded transparent icon', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        task: 'ios-launcher',
        options: makeOptions({ taskId: 'ios-launcher', padding: 10 }),
        source: makeSource({ hasTransparency: true }),
      }),
    )
    expect(ids(plan)).toContain('ios-alpha')
    const padding = plan.items.find((i) => i.id === 'ios-padding')!
    expect(padding.patch).toEqual({ padding: 0 })
  })

  it('offers to shrink the subject when content touches the rounded-corner edge', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        task: 'ios-launcher',
        options: makeOptions({ taskId: 'ios-launcher', scale: 1.1 }),
        source: makeSource({
          stats: { contentWidthRatio: 0.97, contentHeightRatio: 0.97 },
        }),
      }),
    )
    const item = plan.items.find((i) => i.id === 'ios-edge-fit')!
    expect(item.patch).toEqual({ scale: 0.9 })
  })
})

describe('buildSourceFixPlan — plan aggregation', () => {
  it('merges every fixable patch into a single combined patch', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        task: 'android-launcher',
        options: makeOptions({
          taskId: 'android-launcher',
          backgroundColor: '#00000000',
          monochrome: false,
        }),
        source: makeSource({ width: 800, height: 600 }),
      }),
    )
    // Non-square -> trim; transparent bg -> backgroundColor; no monochrome -> monochrome.
    expect(plan.patch).toMatchObject({
      trim: true,
      backgroundColor: '#f4f7fb',
      monochrome: true,
    })
    expect(plan.canApply).toBe(true)
    expect(plan.fixCount).toBeGreaterThanOrEqual(3)
  })

  it('summarises mixed auto and fix counts', () => {
    const plan = buildSourceFixPlan(
      makeConfig({
        source: makeSource({ width: 1024, height: 768, fileType: 'image/webp' }),
      }),
    )
    expect(plan.summary).toBe(`自动处理 ${plan.autoCount} 项，${plan.fixCount} 项可优化`)
  })
})

describe('isFixableItem', () => {
  it('is false for ok/auto items and true only for fix items with a non-empty patch', () => {
    expect(isFixableItem({ id: 'a', kind: 'ok', title: '', detail: '' })).toBe(false)
    expect(isFixableItem({ id: 'b', kind: 'auto', title: '', detail: '' })).toBe(false)
    expect(isFixableItem({ id: 'c', kind: 'fix', title: '', detail: '', patch: {} })).toBe(false)
    expect(
      isFixableItem({ id: 'd', kind: 'fix', title: '', detail: '', patch: { trim: true } }),
    ).toBe(true)
  })
})

describe('assignGenerationOption', () => {
  it('assigns each known option key with the right type', () => {
    const patch: Partial<GenerationOptions> = {}
    assignGenerationOption(patch, 'taskId', 'ios-launcher' as TaskId)
    assignGenerationOption(patch, 'backgroundColor', '#123456')
    assignGenerationOption(patch, 'scale', 0.9)
    assignGenerationOption(patch, 'trim', true)
    assignGenerationOption(patch, 'padding', 12)
    assignGenerationOption(patch, 'foregroundPercent', 70)
    assignGenerationOption(patch, 'monochrome', true)
    expect(patch).toEqual({
      taskId: 'ios-launcher',
      backgroundColor: '#123456',
      scale: 0.9,
      trim: true,
      padding: 12,
      foregroundPercent: 70,
      monochrome: true,
    })
  })
})
