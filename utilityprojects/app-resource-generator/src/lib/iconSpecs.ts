export type TaskId = 'android-launcher' | 'android-notification' | 'ios-launcher'

export type DensitySpec = {
  density: string
  scale: number
  legacyLauncherPx: number
  adaptivePx: number
  notificationPx: number
}

export type IosIconSlot = {
  idiom: 'iphone' | 'ipad' | 'ios-marketing'
  size: string
  scale: '1x' | '2x' | '3x'
  pixels: number
  filename: string
}

export const ANDROID_DENSITIES: DensitySpec[] = [
  {
    density: 'mdpi',
    scale: 1,
    legacyLauncherPx: 48,
    adaptivePx: 108,
    notificationPx: 24,
  },
  {
    density: 'hdpi',
    scale: 1.5,
    legacyLauncherPx: 72,
    adaptivePx: 162,
    notificationPx: 36,
  },
  {
    density: 'xhdpi',
    scale: 2,
    legacyLauncherPx: 96,
    adaptivePx: 216,
    notificationPx: 48,
  },
  {
    density: 'xxhdpi',
    scale: 3,
    legacyLauncherPx: 144,
    adaptivePx: 324,
    notificationPx: 72,
  },
  {
    density: 'xxxhdpi',
    scale: 4,
    legacyLauncherPx: 192,
    adaptivePx: 432,
    notificationPx: 96,
  },
]

export const IOS_ICON_SLOTS: IosIconSlot[] = [
  {
    idiom: 'iphone',
    size: '20x20',
    scale: '2x',
    pixels: 40,
    filename: 'Icon-App-20x20@2x.png',
  },
  {
    idiom: 'iphone',
    size: '20x20',
    scale: '3x',
    pixels: 60,
    filename: 'Icon-App-20x20@3x.png',
  },
  {
    idiom: 'iphone',
    size: '29x29',
    scale: '2x',
    pixels: 58,
    filename: 'Icon-App-29x29@2x.png',
  },
  {
    idiom: 'iphone',
    size: '29x29',
    scale: '3x',
    pixels: 87,
    filename: 'Icon-App-29x29@3x.png',
  },
  {
    idiom: 'iphone',
    size: '40x40',
    scale: '2x',
    pixels: 80,
    filename: 'Icon-App-40x40@2x.png',
  },
  {
    idiom: 'iphone',
    size: '40x40',
    scale: '3x',
    pixels: 120,
    filename: 'Icon-App-40x40@3x.png',
  },
  {
    idiom: 'iphone',
    size: '60x60',
    scale: '2x',
    pixels: 120,
    filename: 'Icon-App-60x60@2x.png',
  },
  {
    idiom: 'iphone',
    size: '60x60',
    scale: '3x',
    pixels: 180,
    filename: 'Icon-App-60x60@3x.png',
  },
  {
    idiom: 'ipad',
    size: '20x20',
    scale: '1x',
    pixels: 20,
    filename: 'Icon-App-20x20@1x.png',
  },
  {
    idiom: 'ipad',
    size: '20x20',
    scale: '2x',
    pixels: 40,
    filename: 'Icon-App-20x20@2x-1.png',
  },
  {
    idiom: 'ipad',
    size: '29x29',
    scale: '1x',
    pixels: 29,
    filename: 'Icon-App-29x29@1x.png',
  },
  {
    idiom: 'ipad',
    size: '29x29',
    scale: '2x',
    pixels: 58,
    filename: 'Icon-App-29x29@2x-1.png',
  },
  {
    idiom: 'ipad',
    size: '40x40',
    scale: '1x',
    pixels: 40,
    filename: 'Icon-App-40x40@1x.png',
  },
  {
    idiom: 'ipad',
    size: '40x40',
    scale: '2x',
    pixels: 80,
    filename: 'Icon-App-40x40@2x-1.png',
  },
  {
    idiom: 'ipad',
    size: '76x76',
    scale: '1x',
    pixels: 76,
    filename: 'Icon-App-76x76@1x.png',
  },
  {
    idiom: 'ipad',
    size: '76x76',
    scale: '2x',
    pixels: 152,
    filename: 'Icon-App-76x76@2x.png',
  },
  {
    idiom: 'ipad',
    size: '83.5x83.5',
    scale: '2x',
    pixels: 167,
    filename: 'Icon-App-83.5x83.5@2x.png',
  },
  {
    idiom: 'ios-marketing',
    size: '1024x1024',
    scale: '1x',
    pixels: 1024,
    filename: 'Icon-App-1024x1024@1x.png',
  },
]

export const TASK_COPY: Record<
  TaskId,
  {
    label: string
    shortLabel: string
    sourceHint: string
    officialNotes: string[]
    outputRoot: string
  }
> = {
  'android-launcher': {
    label: 'Android 应用图标',
    shortLabel: '应用图标',
    sourceHint: '推荐上传 1024x1024 PNG/WebP；会生成传统 mipmap 图标和自适应图标前景层。',
    officialNotes: [
      '传统启动图标输出到 mipmap-mdpi 至 mipmap-xxxhdpi，基准尺寸为 48dp。',
      '自适应图标由背景层与前景层组成，设计画布为 108dp，中心 66dp 为安全区。',
      '会生成 ic_launcher.xml 与 ic_launcher_round.xml，可在 AndroidManifest 中使用 @mipmap/ic_launcher。',
    ],
    outputRoot: 'android/app/src/main/res',
  },
  'android-notification': {
    label: 'Android 通知图标',
    shortLabel: '通知图标',
    sourceHint: '推荐上传透明背景的单色图形；Android 5.0+ 会按系统颜色渲染通知小图标。',
    officialNotes: [
      '输出到 drawable-mdpi 至 drawable-xxxhdpi，基准尺寸为 24dp。',
      '通知小图标应是透明背景上的 alpha 蒙版，不应依赖彩色通道。',
      '从应用图标生成时会先识别边缘底色、清理边界残留，再输出白色 alpha 蒙版。',
    ],
    outputRoot: 'android/app/src/main/res',
  },
  'ios-launcher': {
    label: 'iOS 应用图标',
    shortLabel: 'iOS 图标',
    sourceHint: '推荐上传 1024x1024 PNG；App Store 营销图标需要 1024x1024。',
    officialNotes: [
      '输出 AppIcon.appiconset，包含 iPhone、iPad 与 App Store 营销图标槽位。',
      'iOS 图标不应带透明背景；本工具会按指定背景色合成透明区域。',
      '系统会自动应用圆角，不要在源图中预先添加圆角。',
    ],
    outputRoot: 'ios/Runner/Assets.xcassets/AppIcon.appiconset',
  },
}
