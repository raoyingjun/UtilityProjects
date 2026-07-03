import { describe, expect, it } from 'vitest'
import {
  conflictingSiblingNames,
  isAndroidResBucket,
  extractLauncherBackgroundHex,
  mergeLauncherBackgroundColor,
  writeAssetsToProject,
  type FileSystemDirectoryHandle,
} from './projectFiles'
import type { GeneratedAsset } from './imageTools'

// Minimal in-memory File System Access API mock — enough to exercise writeAssetsToProject.
class MockDir {
  kind = 'directory' as const
  name: string
  dirs = new Map<string, MockDir>()
  files = new Map<string, string>()
  constructor(name: string) {
    this.name = name
  }
  async queryPermission() {
    return 'granted' as PermissionState
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name)
    if (!dir) {
      if (!options?.create) throw new Error('NotFoundError')
      dir = new MockDir(name)
      this.dirs.set(name, dir)
    }
    return dir as unknown as FileSystemDirectoryHandle
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new Error('NotFoundError')
      this.files.set(name, '')
    }
    const store = this.files
    return {
      kind: 'file' as const,
      name,
      getFile: async () => ({ text: async () => store.get(name) ?? '' }) as unknown as File,
      createWritable: async () => ({
        write: async (data: Blob | string) => {
          store.set(name, typeof data === 'string' ? data : await (data as Blob).text())
        },
        close: async () => {},
      }),
    }
  }
  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new Error('NotFoundError')
    }
  }
}

async function seedDir(root: MockDir, parts: string[]): Promise<MockDir> {
  let current = root
  for (const part of parts) {
    current = (await current.getDirectoryHandle(part, { create: true })) as unknown as MockDir
  }
  return current
}

function asset(path: string, content: string): GeneratedAsset {
  return { path, blob: new Blob([content]), label: path, group: 'g', dataUrl: '' }
}

describe('writeAssetsToProject — conflict avoidance', () => {
  it('removes same-name .webp and merges the color into existing colors.xml', async () => {
    const root = new MockDir('AIPhotos')
    const resParts = ['android', 'app', 'src', 'main', 'res']
    const mipmap = await seedDir(root, [...resParts, 'mipmap-mdpi'])
    mipmap.files.set('ic_launcher.webp', 'OLD-WEBP') // pre-existing flutter_launcher_icons output
    const values = await seedDir(root, [...resParts, 'values'])
    values.files.set(
      'colors.xml',
      '<resources>\n    <color name="notification_color">#FF7026</color>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>',
    )

    const report = await writeAssetsToProject(root as unknown as FileSystemDirectoryHandle, [
      asset('android/app/src/main/res/mipmap-mdpi/ic_launcher.png', 'NEW-PNG'),
      asset(
        'android/app/src/main/res/values/ic_launcher_background.xml',
        '<resources>\n    <color name="ic_launcher_background">#f4f7fb</color>\n</resources>',
      ),
    ])

    // our png written, the conflicting old .webp removed
    expect(mipmap.files.has('ic_launcher.png')).toBe(true)
    expect(mipmap.files.has('ic_launcher.webp')).toBe(false)

    // color merged into colors.xml (our value), no duplicate, sibling color intact
    const colors = values.files.get('colors.xml') ?? ''
    expect((colors.match(/name="ic_launcher_background"/g) ?? []).length).toBe(1)
    expect(colors).toContain('#f4f7fb')
    expect(colors).not.toContain('#FFFFFF')
    expect(colors).toContain('notification_color')

    // the separate ic_launcher_background.xml was NOT created
    expect(values.files.has('ic_launcher_background.xml')).toBe(false)
    expect(report.written).toContain('android/app/src/main/res/values/colors.xml')
  })

  it('writes the standalone ic_launcher_background.xml when the project has no colors.xml', async () => {
    const root = new MockDir('Fresh')
    const values = await seedDir(root, ['android', 'app', 'src', 'main', 'res', 'values'])

    await writeAssetsToProject(root as unknown as FileSystemDirectoryHandle, [
      asset(
        'android/app/src/main/res/values/ic_launcher_background.xml',
        '<resources>\n    <color name="ic_launcher_background">#f4f7fb</color>\n</resources>',
      ),
    ])

    expect(values.files.has('ic_launcher_background.xml')).toBe(true)
    expect(values.files.get('ic_launcher_background.xml')).toContain('#f4f7fb')
  })
})

describe('conflictingSiblingNames', () => {
  it('lists same-name rasters in other extensions for a written png', () => {
    expect(conflictingSiblingNames('ic_launcher.png')).toEqual([
      'ic_launcher.webp',
      'ic_launcher.jpg',
      'ic_launcher.jpeg',
    ])
  })

  it('handles a written webp (would remove the png/jpg siblings)', () => {
    expect(conflictingSiblingNames('ic_launcher_round.webp')).toEqual([
      'ic_launcher_round.png',
      'ic_launcher_round.jpg',
      'ic_launcher_round.jpeg',
    ])
  })

  it('returns nothing for non-raster files (xml/json) or extensionless names', () => {
    expect(conflictingSiblingNames('ic_launcher.xml')).toEqual([])
    expect(conflictingSiblingNames('Contents.json')).toEqual([])
    expect(conflictingSiblingNames('README')).toEqual([])
  })
})

describe('isAndroidResBucket', () => {
  it('is true for mipmap/drawable buckets, false otherwise', () => {
    expect(isAndroidResBucket('mipmap-mdpi')).toBe(true)
    expect(isAndroidResBucket('mipmap-anydpi-v26')).toBe(true)
    expect(isAndroidResBucket('drawable-xxhdpi')).toBe(true)
    expect(isAndroidResBucket('values')).toBe(false)
    expect(isAndroidResBucket('AppIcon.appiconset')).toBe(false)
  })
})

describe('extractLauncherBackgroundHex', () => {
  it('reads the color value from our generated xml', () => {
    expect(
      extractLauncherBackgroundHex(
        '<resources>\n    <color name="ic_launcher_background">#f4f7fb</color>\n</resources>',
      ),
    ).toBe('#f4f7fb')
  })

  it('trims and tolerates extra whitespace', () => {
    expect(
      extractLauncherBackgroundHex('<color name="ic_launcher_background" > #ABCDEF </color>'),
    ).toBe('#ABCDEF')
  })

  it('returns null when the color is absent', () => {
    expect(extractLauncherBackgroundHex('<resources></resources>')).toBeNull()
  })
})

describe('mergeLauncherBackgroundColor', () => {
  const withColor = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="notification_color">#FF7026</color>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>`

  const withoutColor = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="notification_color">#FF7026</color>
</resources>`

  it('replaces an existing ic_launcher_background without duplicating it', () => {
    const out = mergeLauncherBackgroundColor(withColor, '#f4f7fb')
    expect((out.match(/name="ic_launcher_background"/g) ?? []).length).toBe(1)
    expect(out).toContain('<color name="ic_launcher_background">#f4f7fb</color>')
    expect(out).not.toContain('#FFFFFF')
    // untouched sibling color survives
    expect(out).toContain('<color name="notification_color">#FF7026</color>')
  })

  it('inserts the color before </resources> when missing', () => {
    const out = mergeLauncherBackgroundColor(withoutColor, '#f4f7fb')
    expect((out.match(/name="ic_launcher_background"/g) ?? []).length).toBe(1)
    expect(out).toContain('<color name="ic_launcher_background">#f4f7fb</color>')
    expect((out.match(/<\/resources>/g) ?? []).length).toBe(1)
  })

  it('appends when there is no </resources> tag (malformed fallback)', () => {
    const out = mergeLauncherBackgroundColor('<resources>', '#123456')
    expect(out).toContain('<color name="ic_launcher_background">#123456</color>')
  })
})
