import { describe, expect, it } from 'vitest'
import {
  isSupportedImageFile,
  lanczosKernel,
  resizeLanczos,
  fitPlaneChannel,
  LANCZOS_WINDOW,
} from './imageTools'

function file(name: string, type: string): File {
  return new File([new Uint8Array([0])], name, { type })
}

function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data.set(rgba, i * 4)
  }
  return data
}

describe('isSupportedImageFile', () => {
  it('accepts the four supported mime types', () => {
    expect(isSupportedImageFile(file('a.png', 'image/png'))).toBe(true)
    expect(isSupportedImageFile(file('a.jpg', 'image/jpeg'))).toBe(true)
    expect(isSupportedImageFile(file('a.webp', 'image/webp'))).toBe(true)
    expect(isSupportedImageFile(file('a.svg', 'image/svg+xml'))).toBe(true)
  })

  it('rejects unsupported raster types', () => {
    expect(isSupportedImageFile(file('a.gif', 'image/gif'))).toBe(false)
    expect(isSupportedImageFile(file('a.bmp', 'image/bmp'))).toBe(false)
    expect(isSupportedImageFile(file('a.txt', 'text/plain'))).toBe(false)
  })

  it('falls back to the filename extension when the mime type is missing', () => {
    expect(isSupportedImageFile(file('logo.PNG', ''))).toBe(true)
    expect(isSupportedImageFile(file('photo.JPEG', ''))).toBe(true)
    expect(isSupportedImageFile(file('vector.svg', ''))).toBe(true)
    expect(isSupportedImageFile(file('unknown.gif', ''))).toBe(false)
  })

  it('ignores mime-type parameters and casing', () => {
    expect(isSupportedImageFile(file('a.png', 'IMAGE/PNG; charset=binary'))).toBe(true)
  })
})

describe('lanczosKernel', () => {
  it('peaks at 1 for x=0', () => {
    expect(lanczosKernel(0)).toBe(1)
  })

  it('is zero outside the ±window support', () => {
    expect(lanczosKernel(LANCZOS_WINDOW)).toBe(0)
    expect(lanczosKernel(-LANCZOS_WINDOW)).toBe(0)
    expect(lanczosKernel(4)).toBe(0)
  })

  it('crosses zero at nonzero integers (sinc property)', () => {
    expect(lanczosKernel(1)).toBeCloseTo(0, 10)
    expect(lanczosKernel(2)).toBeCloseTo(0, 10)
  })

  it('is symmetric', () => {
    expect(lanczosKernel(1.37)).toBeCloseTo(lanczosKernel(-1.37), 12)
    expect(lanczosKernel(0.5)).toBeCloseTo(lanczosKernel(-0.5), 12)
  })
})

describe('resizeLanczos', () => {
  it('returns an identical copy when dimensions are unchanged', () => {
    const src = solid(3, 3, [12, 34, 56, 200])
    const out = resizeLanczos(src, 3, 3, 3, 3)
    expect(Array.from(out)).toEqual(Array.from(src))
    expect(out).not.toBe(src) // a copy, not the same reference
  })

  it('produces an output buffer sized for the target dimensions', () => {
    const out = resizeLanczos(solid(4, 4, [0, 0, 0, 255]), 4, 4, 8, 6)
    expect(out.length).toBe(8 * 6 * 4)
  })

  it('preserves a constant opaque colour when upscaling (weights sum to 1)', () => {
    const out = resizeLanczos(solid(2, 2, [100, 150, 200, 255]), 2, 2, 5, 5)
    for (let i = 0; i < 5 * 5; i += 1) {
      expect(Math.abs(out[i * 4] - 100)).toBeLessThanOrEqual(1)
      expect(Math.abs(out[i * 4 + 1] - 150)).toBeLessThanOrEqual(1)
      expect(Math.abs(out[i * 4 + 2] - 200)).toBeLessThanOrEqual(1)
      expect(out[i * 4 + 3]).toBe(255)
    }
  })

  it('preserves a constant colour when downscaling', () => {
    const out = resizeLanczos(solid(6, 6, [80, 80, 80, 255]), 6, 6, 2, 2)
    for (let i = 0; i < 2 * 2; i += 1) {
      expect(Math.abs(out[i * 4] - 80)).toBeLessThanOrEqual(1)
      expect(out[i * 4 + 3]).toBe(255)
    }
  })

  it('keeps fully transparent pixels transparent (no colour fringing)', () => {
    const out = resizeLanczos(solid(2, 2, [0, 0, 0, 0]), 2, 2, 4, 4)
    for (let i = 0; i < 4 * 4; i += 1) {
      expect(out[i * 4 + 3]).toBe(0)
    }
  })

  it('never yields NaN or out-of-range channel values on a non-trivial image', () => {
    const src = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 255, 255, 255, 255, 255, 0,
    ]) // 2x2 with varied colour + alpha
    const out = resizeLanczos(src, 2, 2, 7, 7)
    for (const value of out) {
      expect(Number.isNaN(value)).toBe(false)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(255)
    }
  })
})

describe('fitPlaneChannel (gradient background model)', () => {
  function grid(fn: (x: number, y: number) => number, span = 3) {
    const dx: number[] = []
    const dy: number[] = []
    const v: number[] = []
    for (let y = -span; y <= span; y += 1) {
      for (let x = -span; x <= span; x += 1) {
        dx.push(x)
        dy.push(y)
        v.push(fn(x, y))
      }
    }
    return { dx, dy, v }
  }

  it('recovers the coefficients of a known linear gradient', () => {
    const { dx, dy, v } = grid((x, y) => 2 * x + 3 * y + 50)
    const p = fitPlaneChannel(dx, dy, v)!
    expect(p[0]).toBeCloseTo(2, 6)
    expect(p[1]).toBeCloseTo(3, 6)
    expect(p[2]).toBeCloseTo(50, 6)
  })

  it('fits a constant field to zero slope', () => {
    const { dx, dy, v } = grid(() => 128)
    const p = fitPlaneChannel(dx, dy, v)!
    expect(p[0]).toBeCloseTo(0, 6)
    expect(p[1]).toBeCloseTo(0, 6)
    expect(p[2]).toBeCloseTo(128, 6)
  })

  it('returns null for a degenerate single-point system', () => {
    expect(fitPlaneChannel([0, 0, 0], [0, 0, 0], [10, 10, 10])).toBeNull()
  })

  it('returns null when samples are collinear (no 2D spread)', () => {
    expect(fitPlaneChannel([-2, -1, 0, 1, 2], [0, 0, 0, 0, 0], [1, 2, 3, 4, 5])).toBeNull()
  })
})
