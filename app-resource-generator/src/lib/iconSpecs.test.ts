import { describe, expect, it } from 'vitest'
import {
  ANDROID_DENSITIES,
  IOS_ICON_SLOTS,
  TASK_COPY,
  type TaskId,
} from './iconSpecs'

describe('ANDROID_DENSITIES', () => {
  it('covers the five standard densities in ascending scale order', () => {
    expect(ANDROID_DENSITIES.map((d) => d.density)).toEqual([
      'mdpi',
      'hdpi',
      'xhdpi',
      'xxhdpi',
      'xxxhdpi',
    ])
    const scales = ANDROID_DENSITIES.map((d) => d.scale)
    expect(scales).toEqual([...scales].sort((a, b) => a - b))
  })

  it('derives every pixel size from the density scale and base dp', () => {
    for (const spec of ANDROID_DENSITIES) {
      // Launcher base 48dp, adaptive base 108dp, notification base 24dp.
      expect(spec.legacyLauncherPx).toBe(Math.round(48 * spec.scale))
      expect(spec.adaptivePx).toBe(Math.round(108 * spec.scale))
      expect(spec.notificationPx).toBe(Math.round(24 * spec.scale))
    }
  })
})

describe('IOS_ICON_SLOTS', () => {
  it('has a pixel count equal to point size times scale for every slot', () => {
    for (const slot of IOS_ICON_SLOTS) {
      const points = Number.parseFloat(slot.size.split('x')[0])
      const scale = Number.parseInt(slot.scale, 10)
      expect(slot.pixels).toBe(Math.round(points * scale))
    }
  })

  it('has a unique filename for every slot', () => {
    const names = IOS_ICON_SLOTS.map((s) => s.filename)
    expect(new Set(names).size).toBe(names.length)
  })

  it('includes the required App Store marketing icon at 1024px', () => {
    const marketing = IOS_ICON_SLOTS.filter((s) => s.idiom === 'ios-marketing')
    expect(marketing).toHaveLength(1)
    expect(marketing[0].pixels).toBe(1024)
  })

  it('only uses the three recognised idioms', () => {
    for (const slot of IOS_ICON_SLOTS) {
      expect(['iphone', 'ipad', 'ios-marketing']).toContain(slot.idiom)
    }
  })
})

describe('TASK_COPY', () => {
  const tasks: TaskId[] = ['android-launcher', 'android-notification', 'ios-launcher']

  it('provides complete copy for every task id', () => {
    for (const task of tasks) {
      const copy = TASK_COPY[task]
      expect(copy).toBeTruthy()
      expect(copy.label.length).toBeGreaterThan(0)
      expect(copy.shortLabel.length).toBeGreaterThan(0)
      expect(copy.sourceHint.length).toBeGreaterThan(0)
      expect(copy.officialNotes.length).toBeGreaterThan(0)
      expect(copy.outputRoot.length).toBeGreaterThan(0)
    }
  })

  it('routes iOS output under the AppIcon.appiconset path', () => {
    expect(TASK_COPY['ios-launcher'].outputRoot).toContain('AppIcon.appiconset')
  })

  it('routes both Android tasks under the res directory', () => {
    expect(TASK_COPY['android-launcher'].outputRoot).toContain('android/app/src/main/res')
    expect(TASK_COPY['android-notification'].outputRoot).toContain('android/app/src/main/res')
  })
})
