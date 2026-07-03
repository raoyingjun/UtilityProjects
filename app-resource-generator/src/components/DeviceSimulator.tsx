import { type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppWindow,
  Bell,
  BellOff,
  BellRing,
  ChevronDown,
  CircleDot,
  Home,
  Moon,
  MousePointerClick,
  PanelTopOpen,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Sun,
  Trash2,
} from 'lucide-react'
import { ANDROID_DENSITIES, TASK_COPY, type TaskId } from '../lib/iconSpecs'
import type { GeneratedAsset, GenerationOptions, SourceImage } from '../lib/imageTools'

type DeviceSimulatorProps = {
  task: TaskId
  source: SourceImage | null
  notificationAppSource?: SourceImage | null
  assets: GeneratedAsset[]
  options: GenerationOptions
  busy: boolean
}

type AppStage = 'home' | 'launching' | 'app' | 'closing'
type LauncherMask = 'circle' | 'squircle' | 'rounded' | 'square'
type WallpaperMode = 'aurora' | 'paper'
type SystemAppearance = 'light' | 'dark'
type AndroidPanel = 'none' | 'widgets' | 'info'
type HomePage = 0 | 1
type IconPlacement = 'grid' | 'dock'
type AndroidIconShape = LauncherMask
type DragOffset = {
  x: number
  y: number
}
type IconDragPoint = DragOffset
type IconDragMoveResult =
  | void
  | DragOffset
  | {
      offset: DragOffset
      rebase?: boolean
    }
type IconImage = {
  dataUrl: string
  generated?: boolean
}
type AppIconImage = {
  dataUrl?: string
  generated?: boolean
}

type PlatformMotionProfile = {
  launchDuration: number
  closeDuration: number
  closeDistance: number
  closeThreshold: number
  closeScaleDrop: number
  closeOpacityDrop: number
  closeTranslateFactor: number
  closeRadius: number
  closeProgressPower: number
}

const platformMotionProfiles: Record<'android' | 'ios', PlatformMotionProfile> = {
  android: {
    launchDuration: 640,
    closeDuration: 760,
    closeDistance: 184,
    closeThreshold: -34,
    closeScaleDrop: 0.54,
    closeOpacityDrop: 0.3,
    closeTranslateFactor: 0.18,
    closeRadius: 28,
    closeProgressPower: 0.92,
  },
  ios: {
    launchDuration: 760,
    closeDuration: 900,
    closeDistance: 224,
    closeThreshold: -38,
    closeScaleDrop: 0.76,
    closeOpacityDrop: 0.22,
    closeTranslateFactor: 0.3,
    closeRadius: 38,
    closeProgressPower: 1.12,
  },
}

const launcherMasks: Array<{ id: LauncherMask; label: string }> = [
  { id: 'circle', label: '圆形' },
  { id: 'squircle', label: '圆角矩形' },
  { id: 'rounded', label: '圆角' },
  { id: 'square', label: '方形' },
]

const sampleApps = [
  ['相册', '#f2bc55'],
  ['地图', '#5c9ceb'],
  ['日历', '#f8f4ed'],
  ['邮件', '#3d8dde'],
  ['音乐', '#d94d64'],
  ['设置', '#8d98a7'],
  ['文件', '#52a58a'],
  ['天气', '#6aa9d8'],
]

const secondaryApps = [
  ['浏览器', '#4b7bec'],
  ['相机', '#3a3f45'],
  ['备忘录', '#f6d365'],
  ['钱包', '#2563eb'],
  ['播客', '#8b5cf6'],
  ['健康', '#ef476f'],
  ['时钟', '#111827'],
  ['商店', '#0ea5e9'],
]

// Fallback brand color when the source has no vibrant color to derive an app icon from.
const DEFAULT_NOTIFICATION_BRAND = '#4b6bd6'

function channelToHex(value: number): string {
  return Math.round(clampValue(value, 0, 255)).toString(16).padStart(2, '0')
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Derive a representative brand color from a source bitmap: weight opaque pixels by how
// vivid they are (saturation × value) so a colored logo dominates over neutral padding.
// Falls back to the average opaque color, then to a neutral brand color for flat/white art.
function extractBrandColor(bitmap: ImageBitmap): string {
  const sampleSize = 32
  const canvas = document.createElement('canvas')
  canvas.width = sampleSize
  canvas.height = sampleSize
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return DEFAULT_NOTIFICATION_BRAND
  }
  ctx.drawImage(bitmap, 0, 0, sampleSize, sampleSize)
  const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize)

  let vividR = 0
  let vividG = 0
  let vividB = 0
  let vividWeight = 0
  let opaqueR = 0
  let opaqueG = 0
  let opaqueB = 0
  let opaqueCount = 0

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 200) {
      continue
    }
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    opaqueR += r
    opaqueG += g
    opaqueB += b
    opaqueCount += 1

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const saturation = max === 0 ? 0 : (max - min) / max
    const value = max / 255
    if (saturation > 0.28 && value > 0.22) {
      const weight = saturation * value
      vividR += r * weight
      vividG += g * weight
      vividB += b * weight
      vividWeight += weight
    }
  }

  if (vividWeight > 0.5) {
    return rgbToHex(vividR / vividWeight, vividG / vividWeight, vividB / vividWeight)
  }
  if (opaqueCount > 0) {
    const r = opaqueR / opaqueCount
    const g = opaqueG / opaqueCount
    const b = opaqueB / opaqueCount
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const saturation = max === 0 ? 0 : (max - min) / max
    if (saturation > 0.12) {
      return rgbToHex(r, g, b)
    }
  }
  return DEFAULT_NOTIFICATION_BRAND
}

function useNotificationBrandColor(source: SourceImage | null | undefined): string {
  const [color, setColor] = useState(DEFAULT_NOTIFICATION_BRAND)
  useEffect(() => {
    if (!source) {
      setColor(DEFAULT_NOTIFICATION_BRAND)
      return
    }
    try {
      setColor(extractBrandColor(source.bitmap))
    } catch {
      setColor(DEFAULT_NOTIFICATION_BRAND)
    }
  }, [source])
  return color
}

// A cohesive, generated app icon: a brand-colored tile with the notification glyph centered,
// so the launcher tile matches the white status-bar silhouette instead of showing raw art.
function NotificationAppIconTile({
  brandColor,
  glyphUrl,
  glyphSize = 22,
}: {
  brandColor: string
  glyphUrl: string | undefined
  glyphSize?: number
}) {
  return (
    <span className="sim-app-icon android-mask squircle notif-app-tile" style={{ backgroundColor: brandColor }}>
      {glyphUrl ? <img src={glyphUrl} alt="" /> : <AppWindow size={glyphSize} />}
    </span>
  )
}

export function DeviceSimulator({
  task,
  source,
  notificationAppSource,
  assets,
  options,
  busy,
}: DeviceSimulatorProps) {
  const imageAssets = useMemo(() => assets.filter((asset) => asset.dataUrl), [assets])
  const launcherIcon = pickAsset(imageAssets, ['mipmap-xxxhdpi/ic_launcher.png']) ?? largestAsset(imageAssets)
  const launcherForeground =
    pickAsset(imageAssets, ['drawable-xxxhdpi/ic_launcher_foreground.png']) ?? launcherIcon
  const launcherMonochrome =
    pickAsset(imageAssets, ['drawable-xxxhdpi/ic_launcher_monochrome.png']) ?? launcherForeground
  const notificationIcon =
    pickAsset(imageAssets, ['drawable-xxxhdpi/ic_stat_app.png', 'drawable-xhdpi/ic_stat_app.png']) ??
    undefined
  // Derive the notification app icon from the notification glyph + a brand color sampled from
  // the source, so the launcher tile is cohesive with the status-bar icon rather than raw art.
  const notificationBrandColor = useNotificationBrandColor(notificationAppSource ?? source)
  const iosIcon =
    pickAsset(imageAssets, [
      'Icon-App-60x60@3x.png',
      'Icon-App-1024x1024@1x.png',
      'Icon-App-83.5x83.5@2x.png',
    ]) ?? largestAsset(imageAssets)

  if (!source) {
    return (
      <section className="simulator-card">
        <div className="simulator-card-head">
          <div>
            <p className="preview-title">真机模拟</p>
            <span>导入素材后可操作主屏、启动、关闭与通知效果。</span>
          </div>
          <AppWindow size={18} />
        </div>
        <div className="simulator-empty">
          <AppWindow size={38} />
          <p>暂无素材</p>
        </div>
      </section>
    )
  }

  if (task === 'android-notification') {
    return (
      <AndroidNotificationSimulator
        brandColor={notificationBrandColor}
        notificationIcon={notificationIcon}
        busy={busy}
      />
    )
  }

  if (task === 'ios-launcher') {
    return <IosLauncherSimulator icon={iosIcon} busy={busy} />
  }

  return (
    <AndroidLauncherSimulator
      foregroundIcon={launcherForeground}
      monochromeIcon={launcherMonochrome}
      backgroundColor={options.backgroundColor}
      monochrome={options.monochrome}
      busy={busy}
    />
  )
}

function AndroidLauncherSimulator({
  foregroundIcon,
  monochromeIcon,
  backgroundColor,
  monochrome,
  busy,
}: {
  foregroundIcon: IconImage | undefined
  monochromeIcon: IconImage | undefined
  backgroundColor: string
  monochrome: boolean
  busy: boolean
}) {
  const [stage, setStage] = useState<AppStage>('home')
  const [mask, setMask] = useState<LauncherMask>('squircle')
  const [themed, setThemed] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [arranging, setArranging] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [homePage, setHomePage] = useState<HomePage>(0)
  const [iconPlacement, setIconPlacement] = useState<IconPlacement>('grid')
  const [iconPage, setIconPage] = useState<HomePage>(0)
  const [appearance, setAppearance] = useState<SystemAppearance>('dark')
  const [panel, setPanel] = useState<AndroidPanel>('none')

  useLaunchTimers(stage, setStage, 'android')
  useEffect(() => {
    setStage('home')
    setThemed(false)
  }, [foregroundIcon?.dataUrl])

  function openApp() {
    if (stage === 'home') {
      setShortcutsOpen(false)
      setDrawerOpen(false)
      setArranging(false)
      setPanel('none')
      setStage('launching')
    }
  }

  function closeApp() {
    if (stage === 'app') {
      setStage('closing')
      return
    }

    if (stage === 'launching' || stage === 'closing') {
      setStage('home')
    }
  }

  return (
    <section className="simulator-card">
      <SimulatorHeader
        title="Android 真机模拟"
        detail="主屏图标、Launcher 遮罩、启动页与关闭回主屏"
        busy={busy}
      />
      <div className="simulator-layout">
        <PhoneShell platform="android" label="Pixel 预览">
          <AndroidHomeScreen
            stage={stage}
            foregroundIcon={foregroundIcon}
            monochromeIcon={monochromeIcon}
            backgroundColor={backgroundColor}
            mask={mask}
            appearance={appearance}
            themed={themed && monochrome}
            shortcutsOpen={shortcutsOpen}
            arranging={arranging}
            drawerOpen={drawerOpen}
            panel={panel}
            homePage={homePage}
            iconPlacement={iconPlacement}
            iconPage={iconPage}
            onOpen={openApp}
            onLongPress={() => setShortcutsOpen(true)}
            onDismissShortcuts={() => setShortcutsOpen(false)}
            onArrangeChange={setArranging}
            onDrawerChange={setDrawerOpen}
            onPanelChange={setPanel}
            onPageChange={setHomePage}
            onIconPlacementChange={setIconPlacement}
            onIconPageChange={setIconPage}
          />
          <AppSurface platform="android" stage={stage} icon={foregroundIcon} backgroundColor={backgroundColor} androidShape={mask} onClose={closeApp} />
        </PhoneShell>

        <div className="simulator-controls" aria-label="Android 应用图标模拟操作">
          <AppLifecycleButton stage={stage} onOpen={openApp} onClose={closeApp} closeLabel="返回主屏" />
          <ControlButton
            icon={Sparkles}
            label={themed ? '关闭主题图标' : '主题图标'}
            onClick={() => setThemed((current) => !current)}
            disabled={!monochrome}
            active={themed && monochrome}
          />
          <ControlButton
            icon={Square}
            label={appearance === 'dark' ? '浅色模式' : '深色模式'}
            onClick={() => setAppearance((current) => (current === 'dark' ? 'light' : 'dark'))}
            disabled={stage !== 'home'}
            active={appearance === 'light'}
          />
          <ControlButton
            icon={AppWindow}
            label={drawerOpen ? '关闭抽屉' : '应用抽屉'}
            onClick={() => setDrawerOpen((current) => !current)}
            disabled={stage !== 'home'}
            active={drawerOpen}
          />
          <ControlButton
            icon={CircleDot}
            label={arranging ? '完成整理' : '整理桌面'}
            onClick={() => {
              setArranging((current) => !current)
              setShortcutsOpen(false)
            }}
            disabled={stage !== 'home'}
            active={arranging}
          />
          <button
            type="button"
            className="sim-reset-button"
            onClick={() => {
              setStage('home')
              setThemed(false)
              setShortcutsOpen(false)
              setArranging(false)
              setDrawerOpen(false)
              setPanel('none')
              setHomePage(0)
              setIconPlacement('grid')
              setIconPage(0)
              setAppearance('dark')
            }}
          >
            <RotateCcw size={15} />
            重置视图
          </button>
          <div className="sim-control-group">
            <span>Launcher 遮罩</span>
            <div className="mask-options">
              {launcherMasks.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={mask === item.id ? 'active' : ''}
                  onClick={() => setMask(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <DensityStrip />
        </div>
      </div>
    </section>
  )
}

function AndroidNotificationSimulator({
  brandColor,
  notificationIcon,
  busy,
}: {
  brandColor: string
  notificationIcon: IconImage | undefined
  busy: boolean
}) {
  const [stage, setStage] = useState<AppStage>('home')
  const [notificationVisible, setNotificationVisible] = useState(true)
  const [shadeOpen, setShadeOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [sendCount, setSendCount] = useState(0)
  const [appearance, setAppearance] = useState<SystemAppearance>('dark')
  const [headsUp, setHeadsUp] = useState(true)

  useLaunchTimers(stage, setStage, 'android')
  useEffect(() => {
    setStage('home')
    setNotificationVisible(true)
    setShadeOpen(false)
    setExpanded(false)
    setHeadsUp(true)
  }, [notificationIcon?.dataUrl])

  function changeShadeOpen(open: boolean) {
    setShadeOpen(open)
    if (open) {
      setHeadsUp(false)
    }
  }

  function clearNotification() {
    setNotificationVisible(false)
    setExpanded(false)
    setHeadsUp(false)
  }

  function sendNotification() {
    setNotificationVisible(true)
    setSendCount((current) => current + 1)
    setStage('home')
    setExpanded(false)
    setShadeOpen(false)
    setHeadsUp(true)
  }

  function toggleShade() {
    changeShadeOpen(!shadeOpen)
  }

  function toggleExpanded() {
    if (!notificationVisible) {
      return
    }
    changeShadeOpen(true)
    setExpanded((current) => !current)
  }

  function openFromNotification() {
    if (!notificationVisible) {
      return
    }
    setShadeOpen(false)
    setHeadsUp(false)
    setStage('launching')
  }

  function closeApp() {
    if (stage === 'app') {
      setStage('closing')
      return
    }

    if (stage === 'launching' || stage === 'closing') {
      setStage('home')
    }
  }

  return (
    <section className="simulator-card">
      <SimulatorHeader
        title="Android 通知真机模拟"
        detail="顶部横幅、下拉/上滑通知栏、横滑清除、深浅色系统；支持鼠标拖拽与触控板双指滑动"
        busy={busy}
      />
      <div className="simulator-layout">
        <PhoneShell platform="android" label="通知预览">
          <AndroidNotificationHome
            brandColor={brandColor}
            notificationIcon={notificationIcon}
            notificationVisible={notificationVisible}
            shadeOpen={shadeOpen}
            expanded={expanded}
            sendCount={sendCount}
            appearance={appearance}
            headsUp={headsUp}
            onShadeOpenChange={changeShadeOpen}
            onOpenNotification={openFromNotification}
            onClear={clearNotification}
            onToggleExpanded={toggleExpanded}
            onDismissHeadsUp={() => setHeadsUp(false)}
          />
          <AppSurface
            platform="android"
            stage={stage}
            icon={{ dataUrl: notificationIcon?.dataUrl }}
            backgroundColor={brandColor}
            insetGlyph
            androidShape="squircle"
            onClose={closeApp}
          />
        </PhoneShell>

        <div className="simulator-controls" aria-label="Android 通知模拟操作">
          <ControlButton icon={BellRing} label="发送通知" onClick={sendNotification} />
          <AppLifecycleButton
            stage={stage}
            onOpen={openFromNotification}
            onClose={closeApp}
            openIcon={MousePointerClick}
            openLabel="点击通知"
            closeLabel="返回主屏"
            disabledWhenHome={!notificationVisible}
          />
          <ControlButton
            icon={PanelTopOpen}
            label={shadeOpen ? '收起通知栏' : '下拉通知栏'}
            onClick={toggleShade}
            active={shadeOpen}
          />
          <ControlButton
            icon={ChevronDown}
            label={expanded ? '折叠通知' : '展开通知'}
            onClick={toggleExpanded}
            disabled={!notificationVisible}
            active={expanded}
          />
          <ControlButton
            icon={appearance === 'dark' ? Sun : Moon}
            label={appearance === 'dark' ? '浅色系统' : '深色系统'}
            onClick={() => setAppearance((current) => (current === 'dark' ? 'light' : 'dark'))}
            active={appearance === 'light'}
          />
          <ControlButton
            icon={Trash2}
            label="清除通知"
            onClick={clearNotification}
            disabled={!notificationVisible}
          />
        </div>
      </div>
    </section>
  )
}

function IosLauncherSimulator({
  icon,
  busy,
}: {
  icon: IconImage | undefined
  busy: boolean
}) {
  const [stage, setStage] = useState<AppStage>('home')
  const [editing, setEditing] = useState(false)
  const [badge, setBadge] = useState(false)
  const [wallpaper, setWallpaper] = useState<WallpaperMode>('aurora')
  const [homePage, setHomePage] = useState<HomePage>(0)
  const [iconPlacement, setIconPlacement] = useState<IconPlacement>('grid')
  const [iconPage, setIconPage] = useState<HomePage>(0)

  useLaunchTimers(stage, setStage, 'ios')
  useEffect(() => {
    setStage('home')
    setEditing(false)
    setHomePage(0)
    setIconPage(0)
    setIconPlacement('grid')
  }, [icon?.dataUrl])

  function openApp() {
    if (stage === 'home') {
      setEditing(false)
      setStage('launching')
    }
  }

  function closeApp() {
    if (stage === 'app') {
      setStage('closing')
      return
    }

    if (stage === 'launching' || stage === 'closing') {
      setStage('home')
    }
  }

  return (
    <section className="simulator-card">
      <SimulatorHeader
        title="iPhone 主屏模拟"
        detail="主屏圆角、长按编辑、角标、启动与 Home 指示条关闭"
        busy={busy}
      />
      <div className="simulator-layout">
        <PhoneShell platform="ios" label="iPhone 预览">
          <IosHomeScreen
            icon={icon}
            stage={stage}
            editing={editing}
            badge={badge}
            wallpaper={wallpaper}
            homePage={homePage}
            iconPlacement={iconPlacement}
            iconPage={iconPage}
            onOpen={openApp}
            onLongPress={() => setEditing(true)}
            onEditChange={setEditing}
            onPageChange={setHomePage}
            onIconPlacementChange={setIconPlacement}
            onIconPageChange={setIconPage}
          />
          <AppSurface platform="ios" stage={stage} icon={icon} onClose={closeApp} />
        </PhoneShell>

        <div className="simulator-controls" aria-label="iOS 应用图标模拟操作">
          <AppLifecycleButton stage={stage} onOpen={openApp} onClose={closeApp} closeLabel="上滑关闭" />
          <ControlButton
            icon={CircleDot}
            label={editing ? '退出编辑' : '长按编辑'}
            onClick={() => setEditing((current) => !current)}
            disabled={stage !== 'home'}
            active={editing}
          />
          <ControlButton
            icon={Bell}
            label={badge ? '隐藏角标' : '显示角标'}
            onClick={() => setBadge((current) => !current)}
            active={badge}
          />
          <ControlButton
            icon={Square}
            label={wallpaper === 'aurora' ? '浅色模式' : '深色模式'}
            onClick={() => setWallpaper((current) => (current === 'aurora' ? 'paper' : 'aurora'))}
            active={wallpaper === 'paper'}
          />
          <ControlButton
            icon={ChevronDown}
            label={homePage === 0 ? '下一屏' : '上一屏'}
            onClick={() => setHomePage((current) => (current === 0 ? 1 : 0))}
            disabled={stage !== 'home'}
            active={homePage === 1}
          />
        </div>
      </div>
    </section>
  )
}

function PhoneShell({
  platform,
  label,
  children,
}: {
  platform: 'android' | 'ios'
  label: string
  children: ReactNode
}) {
  return (
    <div className={`phone-shell ${platform}`} aria-label={label}>
      <div className="phone-side-button volume" />
      <div className="phone-side-button power" />
      <div className="phone-speaker" />
      <div className="phone-camera" />
      <div className="phone-screen">{children}</div>
    </div>
  )
}

function AndroidHomeScreen({
  stage,
  foregroundIcon,
  monochromeIcon,
  backgroundColor,
  mask,
  appearance,
  themed,
  shortcutsOpen,
  arranging,
  drawerOpen,
  panel,
  homePage,
  iconPlacement,
  iconPage,
  onOpen,
  onLongPress,
  onDismissShortcuts,
  onArrangeChange,
  onDrawerChange,
  onPanelChange,
  onPageChange,
  onIconPlacementChange,
  onIconPageChange,
}: {
  stage: AppStage
  foregroundIcon: IconImage | undefined
  monochromeIcon: IconImage | undefined
  backgroundColor: string
  mask: LauncherMask
  appearance: SystemAppearance
  themed: boolean
  shortcutsOpen: boolean
  arranging: boolean
  drawerOpen: boolean
  panel: AndroidPanel
  homePage: HomePage
  iconPlacement: IconPlacement
  iconPage: HomePage
  onOpen: () => void
  onLongPress: () => void
  onDismissShortcuts: () => void
  onArrangeChange: (arranging: boolean) => void
  onDrawerChange: (open: boolean) => void
  onPanelChange: (panel: AndroidPanel) => void
  onPageChange: (page: HomePage) => void
  onIconPlacementChange: (placement: IconPlacement) => void
  onIconPageChange: (page: HomePage) => void
}) {
  const [targetDrag, setTargetDrag] = useState<DragOffset>({ x: 0, y: 0 })
  const homeRef = useRef<HTMLDivElement | null>(null)
  const pageApps = homePage === 0 ? sampleApps.slice(0, 6) : secondaryApps.slice(0, 6)
  const showTargetInGrid = iconPlacement === 'grid' && homePage === iconPage
  const sampleShape: AndroidIconShape = mask
  const pageSwipe = useHorizontalSwipe({
    onSwipe: (direction) => {
      if (drawerOpen || panel !== 'none') {
        return
      }
      onPageChange(direction === 'next' ? 1 : 0)
    },
  })
  const [drawerPull, setDrawerPull] = useState(0)
  const drawerGesture = useVerticalDrag({
    onMove: (deltaY) => {
      setDrawerPull(Math.max(-72, Math.min(72, deltaY)))
    },
    onTap: () => {
      setDrawerPull(0)
      onPanelChange('none')
      onDrawerChange(!drawerOpen)
    },
    onEnd: (deltaY) => {
      setDrawerPull(0)
      if (deltaY < -26) {
        onPanelChange('none')
        onDrawerChange(true)
      } else if (deltaY > 26) {
        onDrawerChange(false)
      }
    },
  })
  const homeWheelRef = useWheelPan({
    enabled: stage === 'home' && !drawerOpen && panel === 'none',
    claim: () => true,
    onEnd: (deltaX, deltaY) => {
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (Math.abs(deltaX) > 46) {
          onPageChange(deltaX > 0 ? 1 : 0)
        }
        return
      }
      if (deltaY > 56) {
        onPanelChange('none')
        onDrawerChange(true)
      }
    },
  })
  const drawerWheelRef = useWheelPan({
    enabled: drawerOpen,
    claim: (deltaX, deltaY) => Math.abs(deltaY) >= Math.abs(deltaX) && deltaY < 0,
    onMove: (_deltaX, deltaY) => {
      setDrawerPull(Math.max(-72, Math.min(72, -deltaY)))
    },
    onEnd: (_deltaX, deltaY) => {
      setDrawerPull(0)
      if (-deltaY > 42) {
        onDrawerChange(false)
      }
    },
  })
  function handleTargetDragMove(offset: DragOffset, point: IconDragPoint): IconDragMoveResult {
    const homeRect = homeRef.current?.getBoundingClientRect()
    const nearLeftEdge = homeRect ? point.x < homeRect.left + 44 : false
    const nearRightEdge = homeRect ? point.x > homeRect.right - 44 : false

    if ((offset.x < -84 || nearLeftEdge) && homePage === 0) {
      const nextOffset = { x: -36, y: offset.y }
      onPageChange(1)
      onIconPageChange(1)
      onIconPlacementChange('grid')
      setTargetDrag(nextOffset)
      return { offset: nextOffset, rebase: true }
    }

    if ((offset.x > 84 || nearRightEdge) && homePage === 1) {
      const nextOffset = { x: 36, y: offset.y }
      onPageChange(0)
      onIconPageChange(0)
      onIconPlacementChange('grid')
      setTargetDrag(nextOffset)
      return { offset: nextOffset, rebase: true }
    }

    setTargetDrag(offset)
    return undefined
  }

  const targetGesture = useIconGesture({
    onTap: onOpen,
    onLongPress: () => {
      onLongPress()
      onArrangeChange(true)
      onDrawerChange(false)
      onPanelChange('none')
    },
    onDragStart: () => {
      onDismissShortcuts()
      onArrangeChange(true)
      onDrawerChange(false)
      onPanelChange('none')
    },
    onDragMove: handleTargetDragMove,
    onDragEnd: (offset, point) => {
      setTargetDrag({ x: 0, y: 0 })
      onDismissShortcuts()
      onArrangeChange(true)
      const homeRect = homeRef.current?.getBoundingClientRect()
      const nearLeftEdge = homeRect ? point.x < homeRect.left + 44 : false
      const nearRightEdge = homeRect ? point.x > homeRect.right - 44 : false
      if (offset.y > 104) {
        onIconPlacementChange('dock')
        return
      }
      if (offset.y < -112) {
        onDrawerChange(true)
        onPanelChange('none')
        return
      }
      if ((offset.x < -82 || nearLeftEdge) && homePage === 0) {
        onPageChange(1)
        onIconPageChange(1)
        onIconPlacementChange('grid')
        return
      }
      if ((offset.x > 82 || nearRightEdge) && homePage === 1) {
        onPageChange(0)
        onIconPageChange(0)
        onIconPlacementChange('grid')
        return
      }
      onIconPlacementChange('grid')
    },
  })
  const dragStyle = {
    '--icon-drag-x': `${targetDrag.x}px`,
    '--icon-drag-y': `${targetDrag.y}px`,
  } as CSSProperties
  const drawerStyle = { '--drawer-pull': `${drawerPull}px` } as CSSProperties
  const activeIcon = themed ? monochromeIcon : foregroundIcon
  const activeMask: AndroidIconShape = mask
  const activeIconClass = `sim-app-icon android-mask ${activeMask} ${themed ? `themed ${appearance}` : ''}`
  const activeIconStyle = themed ? undefined : { backgroundColor }

  function renderTargetApp(extraClass = '') {
    return (
      <button
        type="button"
        className={`home-app target-app draggable-app gesture-target ${targetGesture.dragging ? 'dragging' : ''} ${extraClass}`.trim()}
        style={dragStyle}
        onClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onPageChange(1)
            onIconPageChange(1)
            onIconPlacementChange('grid')
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            onPageChange(0)
            onIconPageChange(0)
            onIconPlacementChange('grid')
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            onIconPlacementChange('dock')
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            onDrawerChange(true)
          }
        }}
        {...targetGesture.bind}
      >
        <span className={activeIconClass} style={activeIconStyle}>
          {activeIcon?.dataUrl ? <img src={activeIcon.dataUrl} alt="" /> : null}
        </span>
        <small>{TASK_COPY['android-launcher'].shortLabel}</small>
      </button>
    )
  }

  function renderDrawerTargetApp() {
    return (
      <button
        type="button"
        className="home-app target-app drawer-target-app"
        onClick={() => {
          onDrawerChange(false)
          onOpen()
        }}
      >
        <span className={activeIconClass} style={activeIconStyle}>
          {activeIcon?.dataUrl ? <img src={activeIcon.dataUrl} alt="" /> : null}
        </span>
        <small>{TASK_COPY['android-launcher'].shortLabel}</small>
      </button>
    )
  }

  return (
    <div
      ref={(element) => {
        homeRef.current = element
        homeWheelRef(element)
      }}
      className={`android-home page-${homePage} ${appearance} ${mask === 'circle' ? 'round-icons' : ''} ${stage === 'home' ? 'active' : ''} ${arranging ? 'arranging' : ''} ${drawerOpen ? 'drawer-open' : ''}`}
      style={{ '--page-index': homePage } as CSSProperties}
      onPointerDown={(event) => {
        if (arranging && !isHomeInteractiveTarget(event.target)) {
          onArrangeChange(false)
        }
        if (shortcutsOpen) {
          onDismissShortcuts()
        }
        pageSwipe.bind.onPointerDown(event)
      }}
      onPointerMove={pageSwipe.bind.onPointerMove}
      onPointerUp={pageSwipe.bind.onPointerUp}
      onPointerCancel={pageSwipe.bind.onPointerCancel}
    >
      <PhoneStatusBar platform="android" />
      <div className="android-at-a-glance">
        <strong>周三 7月1日</strong>
        <span>25°</span>
      </div>
      <div className="android-search">
        <span>搜索应用</span>
      </div>
      <div className="home-grid android-grid">
        {pageApps.map(([label, color]) => (
          <SampleAppIcon label={label} color={color} shape={sampleShape} key={label} />
        ))}
        {showTargetInGrid ? renderTargetApp() : (
          <span className="home-app page-placeholder">
            <span />
            <small>{iconPlacement === 'dock' ? '已在 Dock' : `${iconPage + 1} 屏`}</small>
          </span>
        )}
      </div>
      <div className="home-page-dots" aria-label="主屏分页">
        {[0, 1].map((page) => (
          <button
            type="button"
            key={page}
            className={homePage === page ? 'active' : ''}
            onClick={() => onPageChange(page as HomePage)}
            aria-label={`第 ${page + 1} 屏`}
          />
        ))}
      </div>
      {shortcutsOpen ? (
        <div className="android-app-shortcuts" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={onOpen}>打开</button>
          <button type="button" onClick={() => onArrangeChange(true)}>拖动整理</button>
          <button type="button" onClick={() => {
            onPanelChange('widgets')
            onDismissShortcuts()
          }}>小组件</button>
          <button type="button" onClick={() => {
            onPanelChange('info')
            onDismissShortcuts()
          }}>应用信息</button>
        </div>
      ) : null}
      {arranging ? (
        <div className="android-drag-zones" aria-hidden="true">
          <span className="top-zone">抽屉</span>
          <span className="bottom-zone">Dock</span>
        </div>
      ) : null}
      {drawerOpen ? (
        <div
          className="android-app-drawer"
          style={drawerStyle}
          ref={drawerWheelRef}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="drawer-grabber"
            aria-label="收起应用抽屉"
            {...drawerGesture}
          />
          <div className="drawer-search">搜索所有应用</div>
          <div className="drawer-grid">
            {renderDrawerTargetApp()}
            {[...sampleApps, ...secondaryApps].map(([label, color]) => (
              <SampleAppIcon label={label} color={color} shape={sampleShape} key={label} />
            ))}
          </div>
        </div>
      ) : null}
      {panel !== 'none' ? (
        <div className="android-detail-sheet" onPointerDown={(event) => event.stopPropagation()}>
          <div className="sheet-grabber" />
          {panel === 'widgets' ? (
            <>
              <strong>小组件</strong>
              <p>把当前应用的小组件放到主屏后，可继续拖动调整位置。</p>
              <button type="button" onClick={() => {
                onPanelChange('none')
                onArrangeChange(true)
                onIconPlacementChange('grid')
                onPageChange(0)
              }}>
                添加到主屏
              </button>
            </>
          ) : (
            <>
              <strong>应用信息</strong>
              <p>检查图标、通知、权限与打开方式在系统设置中的入口。</p>
              <button type="button" onClick={() => onPanelChange('none')}>
                完成
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="android-dock">
        {iconPlacement === 'dock' ? renderTargetApp('dock-target') : null}
        {sampleApps.slice(6).map(([label, color]) => (
          <SampleDockIcon label={label} color={color} shape={sampleShape} key={label} />
        ))}
        <button
          type="button"
          className="dock-drawer-button"
          aria-label="应用抽屉"
          {...drawerGesture}
        >
          <AppWindow size={17} />
        </button>
      </div>
    </div>
  )
}

// 顶部悬浮通知横幅（heads-up）：发送通知时从状态栏下方滑入，点按打开、上滑收起。
function AndroidHeadsUp({
  notificationIcon,
  onOpen,
  onDismiss,
}: {
  notificationIcon: IconImage | undefined
  onOpen: () => void
  onDismiss: () => void
}) {
  const [dragY, setDragY] = useState(0)
  const pan = usePointerPan({
    onClaim: (deltaX, deltaY) =>
      deltaY < 0 && Math.abs(deltaY) >= Math.abs(deltaX) ? 'vertical' : 'reject',
    onMove: (_axis, _deltaX, deltaY) => setDragY(Math.max(-160, Math.min(0, deltaY))),
    onEnd: (_axis, _deltaX, deltaY) => {
      if (deltaY < -40) {
        onDismiss()
        return
      }
      setDragY(0)
    },
    onTap: (startTarget) => {
      if (startTarget?.closest('button, [role="button"]')) {
        return
      }
      onOpen()
    },
  })

  return (
    <div
      className="android-heads-up"
      style={{ '--headsup-drag': `${dragY}px` } as CSSProperties}
      {...pan.bind}
    >
      <span className="notification-small-icon">
        {notificationIcon?.dataUrl ? <img src={notificationIcon.dataUrl} alt="" /> : <Bell size={17} />}
      </span>
      <span className="android-heads-up-copy">
        <strong>应用通知 · 现在</strong>
        <small>横幅态检查小图标在深/浅色状态栏中的白色蒙版辨识度。</small>
      </span>
      <button
        type="button"
        className="android-heads-up-open"
        onClick={onOpen}
        aria-label="打开应用"
      >
        <MousePointerClick size={15} />
      </button>
    </div>
  )
}

function AndroidNotificationHome({
  brandColor,
  notificationIcon,
  notificationVisible,
  shadeOpen,
  expanded,
  sendCount,
  appearance,
  headsUp,
  onShadeOpenChange,
  onOpenNotification,
  onClear,
  onToggleExpanded,
  onDismissHeadsUp,
}: {
  brandColor: string
  notificationIcon: IconImage | undefined
  notificationVisible: boolean
  shadeOpen: boolean
  expanded: boolean
  sendCount: number
  appearance: SystemAppearance
  headsUp: boolean
  onShadeOpenChange: (open: boolean) => void
  onOpenNotification: () => void
  onClear: () => void
  onToggleExpanded: () => void
  onDismissHeadsUp: () => void
}) {
  const [shadePull, setShadePull] = useState(0)
  const [notificationDrag, setNotificationDrag] = useState(0)
  const [wheelSwiping, setWheelSwiping] = useState(false)
  const [quickSettings, setQuickSettings] = useState({
    wifi: true,
    bluetooth: true,
    dnd: false,
  })
  const dismissTimerRef = useRef<number | null>(null)
  const onClearRef = useRef(onClear)

  useEffect(() => {
    onClearRef.current = onClear
  }, [onClear])

  const dismissNotification = useCallback((direction: 1 | -1) => {
    setNotificationDrag(direction * 180)
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current)
    }
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null
      onClearRef.current()
    }, 160)
  }, [])

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    setNotificationDrag(0)
    setWheelSwiping(false)
  }, [notificationVisible, sendCount, notificationIcon?.dataUrl])

  useEffect(() => {
    setShadePull(0)
  }, [shadeOpen])

  const shadePan = usePointerPan({
    onClaim: (deltaX, deltaY, startTarget) => {
      if (!shadeOpen) {
        return 'reject'
      }
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        const onCard = Boolean(startTarget?.closest('.sim-notification'))
        return onCard && notificationVisible ? 'horizontal' : 'reject'
      }
      return 'vertical'
    },
    onMove: (axis, deltaX, deltaY) => {
      if (axis === 'horizontal') {
        setNotificationDrag(Math.max(-132, Math.min(132, deltaX)))
        return
      }
      setShadePull(Math.max(-96, Math.min(48, deltaY)))
    },
    onEnd: (axis, deltaX, deltaY) => {
      if (axis === 'horizontal') {
        if (Math.abs(deltaX) > 74) {
          dismissNotification(deltaX > 0 ? 1 : -1)
        } else {
          setNotificationDrag(0)
        }
        return
      }
      setShadePull(0)
      if (deltaY < -42) {
        onShadeOpenChange(false)
      }
    },
    onTap: (startTarget) => {
      if (startTarget?.closest('button, [role="button"], .sim-notification')) {
        return
      }
      onShadeOpenChange(false)
    },
  })

  const homePan = usePointerPan({
    onClaim: (deltaX, deltaY) =>
      !shadeOpen && Math.abs(deltaY) >= Math.abs(deltaX) && deltaY > 0 ? 'vertical' : 'reject',
    onMove: (_axis, _deltaX, deltaY) => {
      setShadePull(Math.max(0, Math.min(180, deltaY)))
    },
    onEnd: (_axis, _deltaX, deltaY) => {
      setShadePull(0)
      if (deltaY > 42) {
        onShadeOpenChange(true)
      }
    },
  })

  const homeWheelRef = useWheelPan({
    enabled: !shadeOpen,
    claim: (deltaX, deltaY) => Math.abs(deltaY) >= Math.abs(deltaX) && deltaY < 0,
    onMove: (_deltaX, deltaY) => {
      setShadePull(Math.max(0, Math.min(180, -deltaY)))
    },
    onEnd: (_deltaX, deltaY) => {
      setShadePull(0)
      if (-deltaY > 42) {
        onShadeOpenChange(true)
      }
    },
  })

  const shadeWheelRef = useWheelPan({
    enabled: shadeOpen,
    claim: (deltaX, deltaY) => Math.abs(deltaY) >= Math.abs(deltaX) && deltaY > 0,
    onMove: (_deltaX, deltaY) => {
      setShadePull(Math.max(-96, Math.min(48, -deltaY)))
    },
    onEnd: (_deltaX, deltaY) => {
      setShadePull(0)
      if (deltaY > 42) {
        onShadeOpenChange(false)
      }
    },
  })

  const cardWheelRef = useWheelPan({
    enabled: shadeOpen && notificationVisible,
    claim: (deltaX, deltaY) => Math.abs(deltaX) > Math.abs(deltaY),
    onMove: (deltaX) => {
      setWheelSwiping(true)
      setNotificationDrag(Math.max(-132, Math.min(132, -deltaX)))
    },
    onEnd: (deltaX) => {
      setWheelSwiping(false)
      if (Math.abs(deltaX) > 74) {
        dismissNotification(deltaX > 0 ? -1 : 1)
        return
      }
      setNotificationDrag(0)
    },
  })

  const cardSwiping = shadePan.claimedAxis === 'horizontal' || wheelSwiping
  const quickSettingItems = [
    ['wifi', 'Wi-Fi'],
    ['bluetooth', '蓝牙'],
    ['dnd', '勿扰'],
  ] as const

  return (
    <div className={`android-home notification-mode ${appearance} active`} ref={homeWheelRef} {...homePan.bind}>
      <PhoneStatusBar platform="android" notificationIcon={notificationVisible ? notificationIcon : undefined} />
      {headsUp && notificationVisible && !shadeOpen ? (
        <AndroidHeadsUp
          key={sendCount}
          notificationIcon={notificationIcon}
          onOpen={onOpenNotification}
          onDismiss={onDismissHeadsUp}
        />
      ) : null}
      <button
        type="button"
        className={shadeOpen ? 'shade-handle shade-handle-hidden' : 'shade-handle'}
        aria-label="下拉通知栏"
        aria-hidden={shadeOpen}
        tabIndex={shadeOpen ? -1 : undefined}
        onClick={() => {
          if (!wasRecentGesture()) {
            onShadeOpenChange(true)
          }
        }}
      >
        <ChevronDown size={14} />
      </button>
      <div className="home-grid android-grid">
        {sampleApps.slice(0, 5).map(([label, color]) => (
          <SampleAppIcon label={label} color={color} shape="rounded" key={label} />
        ))}
        <span className="home-app target-app">
          <NotificationAppIconTile brandColor={brandColor} glyphUrl={notificationIcon?.dataUrl} />
          <small>当前应用</small>
        </span>
      </div>
      <div
        className={shadeOpen ? 'notification-shade open' : 'notification-shade'}
        style={{ '--shade-drag': `${shadePull}px` } as CSSProperties}
        ref={shadeWheelRef}
        {...shadePan.bind}
      >
        <button
          type="button"
          className="notification-shade-grabber"
          aria-label="收起通知栏"
          onClick={() => {
            if (!wasRecentGesture()) {
              onShadeOpenChange(false)
            }
          }}
        />
        <div className="quick-settings">
          {quickSettingItems.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={quickSettings[id] ? 'active' : ''}
              onClick={() => setQuickSettings((current) => ({ ...current, [id]: !current[id] }))}
            >
              {label}
            </button>
          ))}
        </div>
        {notificationVisible ? (
          <div
            className={`sim-notification${expanded ? ' expanded' : ''}${cardSwiping ? ' swiping' : ''}`}
            style={{ '--notification-drag': `${notificationDrag}px` } as CSSProperties}
            ref={cardWheelRef}
          >
            <button type="button" className="notification-main" onClick={onOpenNotification}>
              <span className="notification-small-icon">
                {notificationIcon?.dataUrl ? <img src={notificationIcon.dataUrl} alt="" /> : <Bell size={17} />}
              </span>
              <span>
                <strong>应用通知</strong>
                <small>通知小图标在状态栏和通知卡片中保持白色蒙版。</small>
              </span>
            </button>
            {expanded ? (
              <p className="notification-expanded-copy">
                展开态可检查透明边缘、图形重心和深色系统背景中的辨识度。
              </p>
            ) : null}
            <div className="notification-actions">
              <button type="button" onClick={onToggleExpanded}>
                {expanded ? '折叠' : '展开'}
              </button>
              <button type="button" onClick={onClear}>
                清除
              </button>
            </div>
          </div>
        ) : (
          <div className="no-notification">
            <BellOff size={18} />
            <strong>没有通知</strong>
            <small>横滑或点「清除」后会停在这里；点按「发送通知」重新发送示例。</small>
          </div>
        )}
      </div>
    </div>
  )
}

function IosHomeScreen({
  icon,
  stage,
  editing,
  badge,
  wallpaper,
  homePage,
  iconPlacement,
  iconPage,
  onOpen,
  onLongPress,
  onEditChange,
  onPageChange,
  onIconPlacementChange,
  onIconPageChange,
}: {
  icon: IconImage | undefined
  stage: AppStage
  editing: boolean
  badge: boolean
  wallpaper: WallpaperMode
  homePage: HomePage
  iconPlacement: IconPlacement
  iconPage: HomePage
  onOpen: () => void
  onLongPress: () => void
  onEditChange: (editing: boolean) => void
  onPageChange: (page: HomePage) => void
  onIconPlacementChange: (placement: IconPlacement) => void
  onIconPageChange: (page: HomePage) => void
}) {
  const [targetDrag, setTargetDrag] = useState<DragOffset>({ x: 0, y: 0 })
  const homeRef = useRef<HTMLDivElement | null>(null)
  const pageApps = homePage === 0 ? sampleApps.slice(0, 9) : secondaryApps
  const showTargetInGrid = iconPlacement === 'grid' && homePage === iconPage
  const pageSwipe = useHorizontalSwipe({
    onSwipe: (direction) => onPageChange(direction === 'next' ? 1 : 0),
  })
  const pageWheelRef = useWheelPan({
    enabled: stage === 'home',
    claim: (deltaX, deltaY) => Math.abs(deltaX) > Math.abs(deltaY),
    onEnd: (deltaX) => {
      if (Math.abs(deltaX) > 46) {
        onPageChange(deltaX > 0 ? 1 : 0)
      }
    },
  })
  function handleTargetDragMove(offset: DragOffset, point: IconDragPoint): IconDragMoveResult {
    const homeRect = homeRef.current?.getBoundingClientRect()
    const nearLeftEdge = homeRect ? point.x < homeRect.left + 44 : false
    const nearRightEdge = homeRect ? point.x > homeRect.right - 44 : false

    if ((offset.x < -84 || nearLeftEdge) && homePage === 0) {
      const nextOffset = { x: -36, y: offset.y }
      onPageChange(1)
      onIconPageChange(1)
      onIconPlacementChange('grid')
      setTargetDrag(nextOffset)
      return { offset: nextOffset, rebase: true }
    }

    if ((offset.x > 84 || nearRightEdge) && homePage === 1) {
      const nextOffset = { x: 36, y: offset.y }
      onPageChange(0)
      onIconPageChange(0)
      onIconPlacementChange('grid')
      setTargetDrag(nextOffset)
      return { offset: nextOffset, rebase: true }
    }

    setTargetDrag(offset)
    return undefined
  }

  const targetGesture = useIconGesture({
    onTap: onOpen,
    onLongPress: () => onEditChange(true),
    onDragStart: () => onEditChange(true),
    onDragMove: handleTargetDragMove,
    onDragEnd: (offset, point) => {
      setTargetDrag({ x: 0, y: 0 })
      onEditChange(true)
      const homeRect = homeRef.current?.getBoundingClientRect()
      const nearLeftEdge = homeRect ? point.x < homeRect.left + 44 : false
      const nearRightEdge = homeRect ? point.x > homeRect.right - 44 : false
      if (offset.y > 104) {
        onIconPlacementChange('dock')
        return
      }
      if ((offset.x < -82 || nearLeftEdge) && homePage === 0) {
        onPageChange(1)
        onIconPageChange(1)
        onIconPlacementChange('grid')
        return
      }
      if ((offset.x > 82 || nearRightEdge) && homePage === 1) {
        onPageChange(0)
        onIconPageChange(0)
        onIconPlacementChange('grid')
        return
      }
      onIconPlacementChange('grid')
    },
  })
  const dragStyle = {
    '--icon-drag-x': `${targetDrag.x}px`,
    '--icon-drag-y': `${targetDrag.y}px`,
  } as CSSProperties

  function renderTargetApp(extraClass = '') {
    return (
      <button
        type="button"
        className={`${editing ? 'home-app ios-target editing' : 'home-app ios-target'} draggable-app gesture-target ${targetGesture.dragging ? 'dragging' : ''} ${extraClass}`.trim()}
        style={dragStyle}
        onClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onPageChange(1)
            onIconPageChange(1)
            onIconPlacementChange('grid')
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            onPageChange(0)
            onIconPageChange(0)
            onIconPlacementChange('grid')
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            onIconPlacementChange('dock')
          }
        }}
        {...targetGesture.bind}
      >
        <span className="ios-icon-frame">
          {editing ? <span className="delete-dot">-</span> : null}
          <span className="sim-app-icon ios-mask">
            {icon?.dataUrl ? <img src={icon.dataUrl} alt="" /> : null}
          </span>
          {badge ? <strong className="ios-badge">3</strong> : null}
        </span>
        <small>当前应用</small>
      </button>
    )
  }

  return (
    <div
      ref={(element) => {
        homeRef.current = element
        pageWheelRef(element)
      }}
      className={`ios-home page-${homePage} ${wallpaper} ${stage === 'home' ? 'active' : ''} ${editing ? 'editing-mode' : ''}`}
      onPointerDown={(event) => {
        if (editing && !isHomeInteractiveTarget(event.target)) {
          onEditChange(false)
        }
        pageSwipe.bind.onPointerDown(event)
      }}
      onPointerMove={pageSwipe.bind.onPointerMove}
      onPointerUp={pageSwipe.bind.onPointerUp}
      onPointerCancel={pageSwipe.bind.onPointerCancel}
    >
      <PhoneStatusBar platform="ios" />
      {editing ? (
        <button type="button" className="ios-edit-done" onClick={() => onEditChange(false)}>
          完成
        </button>
      ) : null}
      <div className="home-grid ios-grid">
        {pageApps.map(([label, color]) => (
          <SampleIosIcon label={label} color={color} editing={editing} onLongPress={onLongPress} key={label} />
        ))}
        {showTargetInGrid ? renderTargetApp() : (
          <span className="home-app page-placeholder">
            <span />
            <small>{iconPlacement === 'dock' ? 'Dock' : `${iconPage + 1} 屏`}</small>
          </span>
        )}
      </div>
      <div className="ios-dots" aria-label="主屏分页">
        {[0, 1].map((page) => (
          <button
            type="button"
            key={page}
            className={homePage === page ? 'active' : ''}
            onClick={() => onPageChange(page as HomePage)}
            aria-label={`第 ${page + 1} 屏`}
          />
        ))}
      </div>
      <div className="ios-dock">
        {iconPlacement === 'dock' ? renderTargetApp('dock-target') : null}
        {sampleApps.slice(5, iconPlacement === 'dock' ? 8 : 9).map(([label, color]) => (
          <SampleDockIcon label={label} color={color} key={label} />
        ))}
      </div>
    </div>
  )
}

function AppSurface({
  platform,
  stage,
  icon,
  backgroundColor,
  insetGlyph = false,
  androidShape = 'squircle',
  onClose,
}: {
  platform: 'android' | 'ios'
  stage: AppStage
  icon: IconImage | AppIconImage | undefined
  backgroundColor?: string
  insetGlyph?: boolean
  androidShape?: AndroidIconShape
  onClose: () => void
}) {
  const visible = stage === 'launching' || stage === 'app' || stage === 'closing'
  const [closeDrag, setCloseDrag] = useState(0)
  const motion = platformMotionProfiles[platform]
  const rawCloseProgress = Math.min(1, Math.abs(closeDrag) / motion.closeDistance)
  const closeProgress = 1 - Math.pow(1 - rawCloseProgress, motion.closeProgressPower)
  const closeScale = 1 - closeProgress * motion.closeScaleDrop
  const closeOpacity = 1 - closeProgress * motion.closeOpacityDrop
  const closePreviewY = closeDrag * motion.closeTranslateFactor
  const closeRadius = closeProgress * motion.closeRadius
  const closeShadowY = closeProgress * (platform === 'ios' ? 24 : 18)
  const closeShadowBlur = closeProgress * (platform === 'ios' ? 48 : 36)
  const closeShadowOpacity = closeProgress * (platform === 'ios' ? 0.22 : 0.24)
  const closeContentScale = 1 - closeProgress * (platform === 'ios' ? 0.025 : 0.015)
  const isCloseDragging = closeProgress > 0 && stage === 'app'

  useEffect(() => {
    if ((stage === 'home' || stage === 'launching') && closeDrag !== 0) {
      setCloseDrag(0)
    }
  }, [closeDrag, stage])

  const requestClose = () => {
    if (stage !== 'home') {
      onClose()
    }
  }
  const closeGesture = useVerticalDrag({
    onMove: (deltaY) => {
      setCloseDrag(Math.min(0, Math.max(-motion.closeDistance, deltaY)))
    },
    onTap: () => {
      setCloseDrag(0)
      requestClose()
    },
    onEnd: (deltaY) => {
      if (deltaY < motion.closeThreshold) {
        requestClose()
        return
      }
      setCloseDrag(0)
    },
  })
  const closeWheelRef = useWheelPan({
    enabled: stage === 'app',
    claim: (deltaX, deltaY) => Math.abs(deltaY) > Math.abs(deltaX) && deltaY > 0,
    onMove: (_deltaX, deltaY) => {
      setCloseDrag(Math.min(0, Math.max(-motion.closeDistance, -deltaY)))
    },
    onEnd: (_deltaX, deltaY) => {
      if (-deltaY < motion.closeThreshold) {
        requestClose()
        return
      }
      setCloseDrag(0)
    },
  })

  return (
    <div
      className={`app-surface ${platform} ${stage} ${visible ? 'visible' : ''} ${isCloseDragging ? 'closing-drag' : ''}`}
      aria-hidden={!visible}
      style={{
        '--close-preview-y': `${closePreviewY}px`,
        '--close-scale': closeScale.toFixed(3),
        '--close-opacity': closeOpacity.toFixed(3),
        '--close-progress': closeProgress.toFixed(3),
        '--close-radius': `${closeRadius.toFixed(1)}px`,
        '--close-shadow-y': `${closeShadowY.toFixed(1)}px`,
        '--close-shadow-blur': `${closeShadowBlur.toFixed(1)}px`,
        '--close-shadow-opacity': closeShadowOpacity.toFixed(3),
        '--close-content-scale': closeContentScale.toFixed(3),
      } as CSSProperties}
    >
      <div className="launch-screen">
        <span
          className={`sim-app-icon ${platform === 'ios' ? 'ios-mask' : `android-mask ${androidShape}`} ${icon?.generated ? 'generated-app-icon' : ''} ${insetGlyph ? 'notif-app-tile' : ''}`.trim()}
          style={backgroundColor ? { backgroundColor } : undefined}
        >
          {icon?.dataUrl ? <img src={icon.dataUrl} alt="" /> : <AppWindow size={32} />}
        </span>
        <strong>{stage === 'launching' ? '启动中' : '应用预览'}</strong>
      </div>
      <div className="app-window-preview" ref={closeWheelRef}>
        <div className="app-window-header">
          <span />
          <strong>当前应用</strong>
          <button type="button" onClick={requestClose} title={platform === 'ios' ? '上滑关闭' : '返回主屏'}>
            <Home size={14} />
          </button>
        </div>
        <div className="app-window-content">
          <span>图标已应用到启动入口</span>
          <p>{platform === 'ios' ? '通过 Home 指示条关闭，窗口缩回主屏图标。' : '返回主屏时窗口收缩回 Launcher 图标位置。'}</p>
        </div>
        <button
          type="button"
          className={platform === 'ios' ? 'home-indicator-button' : 'android-gesture-button'}
          aria-label={platform === 'ios' ? '上滑关闭' : '返回主屏'}
          {...closeGesture}
        />
      </div>
    </div>
  )
}

function SimulatorHeader({
  title,
  detail,
  busy,
}: {
  title: string
  detail: string
  busy: boolean
}) {
  return (
    <div className="simulator-card-head">
      <div>
        <p className="preview-title">{title}</p>
        <span>{detail}</span>
      </div>
      <span className={busy ? 'simulator-busy active' : 'simulator-busy'}>
        {busy ? '更新中' : '可操作'}
      </span>
    </div>
  )
}

function ControlButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      className={active ? 'sim-control-button active' : 'sim-control-button'}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      <Icon size={15} />
      <span>{label}</span>
    </button>
  )
}

function AppLifecycleButton({
  stage,
  onOpen,
  onClose,
  openIcon = Play,
  openLabel = '打开应用',
  closeLabel = '返回主屏',
  disabledWhenHome = false,
}: {
  stage: AppStage
  onOpen: () => void
  onClose: () => void
  openIcon?: typeof Play
  openLabel?: string
  closeLabel?: string
  disabledWhenHome?: boolean
}) {
  if (stage === 'app') {
    return <ControlButton icon={Home} label={closeLabel} onClick={onClose} active />
  }

  if (stage === 'launching' || stage === 'closing') {
    return <ControlButton icon={Home} label="返回主屏" onClick={onClose} />
  }

  return (
    <ControlButton
      icon={openIcon}
      label={openLabel}
      onClick={onOpen}
      disabled={disabledWhenHome}
    />
  )
}

function PhoneStatusBar({
  platform,
  notificationIcon,
}: {
  platform: 'android' | 'ios'
  notificationIcon?: IconImage
}) {
  return (
    <div className={`sim-status-bar ${platform}`}>
      <div>
        {notificationIcon?.dataUrl ? (
          <span className="status-notification-dot">
            <img src={notificationIcon.dataUrl} alt="" />
          </span>
        ) : null}
        <strong>09:41</strong>
      </div>
      <div>
        <span>LTE</span>
        <span className="battery" />
      </div>
    </div>
  )
}

function DensityStrip() {
  return (
    <div className="sim-density-strip">
      {ANDROID_DENSITIES.map((item) => (
        <span key={item.density}>
          {item.density}
          <strong>{item.legacyLauncherPx}px</strong>
        </span>
      ))}
    </div>
  )
}

function SampleAppIcon({
  label,
  color,
  shape = 'rounded',
}: {
  label: string
  color: string
  shape?: AndroidIconShape
}) {
  return (
    <span className="home-app sample">
      <span className={`sample-icon android-mask ${shape}`} style={{ backgroundColor: color }}>
        {label.slice(0, 1)}
      </span>
      <small>{label}</small>
    </span>
  )
}

function SampleIosIcon({
  label,
  color,
  editing,
  onLongPress,
}: {
  label: string
  color: string
  editing: boolean
  onLongPress: () => void
}) {
  const pressHandlers = usePressActions(undefined, onLongPress)

  return (
    <span
      className={editing ? 'home-app sample ios-sample editing gesture-target' : 'home-app sample ios-sample gesture-target'}
      role="button"
      tabIndex={0}
      {...pressHandlers}
    >
      <span className="ios-icon-frame">
        {editing ? <span className="delete-dot">-</span> : null}
        <span className="sample-icon ios-mask" style={{ backgroundColor: color }}>
          {label.slice(0, 1)}
        </span>
      </span>
      <small>{label}</small>
    </span>
  )
}

function SampleDockIcon({
  label,
  color,
  shape,
}: {
  label: string
  color: string
  shape?: AndroidIconShape
}) {
  return (
    <span className={`sample-dock-icon ${shape ? `android-mask ${shape}` : ''}`.trim()} style={{ backgroundColor: color }}>
      {label.slice(0, 1)}
    </span>
  )
}

function useLaunchTimers(stage: AppStage, setStage: (stage: AppStage) => void, platform: 'android' | 'ios') {
  const { closeDuration, launchDuration } = platformMotionProfiles[platform]

  useEffect(() => {
    if (stage === 'launching') {
      const timer = window.setTimeout(() => setStage('app'), launchDuration)
      return () => window.clearTimeout(timer)
    }

    if (stage === 'closing') {
      const timer = window.setTimeout(() => setStage('home'), closeDuration)
      return () => window.clearTimeout(timer)
    }

    return undefined
  }, [closeDuration, launchDuration, setStage, stage])
}

function isHomeInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false
  }

  return Boolean(
    target.closest(
      [
        'button',
        '[role="button"]',
        '.home-app',
        '.android-dock',
        '.ios-dock',
        '.home-page-dots',
        '.ios-dots',
        '.android-app-shortcuts',
        '.android-app-drawer',
        '.android-detail-sheet',
        '.android-drag-zones',
        '.sim-status-bar',
        '.android-search',
        '.android-at-a-glance',
      ].join(', '),
    ),
  )
}

function usePressActions(onTap?: () => void, onLongPress?: () => void, delay = 520) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef({ x: 0, y: 0 })
  const longPressedRef = useRef(false)

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      event.stopPropagation()
      event.preventDefault()
      startRef.current = { x: event.clientX, y: event.clientY }
      longPressedRef.current = false
      event.currentTarget.setPointerCapture?.(event.pointerId)
      if (onLongPress) {
        timerRef.current = window.setTimeout(() => {
          longPressedRef.current = true
          onLongPress()
        }, delay)
      }
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const distance = Math.hypot(
        event.clientX - startRef.current.x,
        event.clientY - startRef.current.y,
      )
      if (distance > 10) {
        clearTimer()
      }
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      event.stopPropagation()
      clearTimer()
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      const distance = Math.hypot(
        event.clientX - startRef.current.x,
        event.clientY - startRef.current.y,
      )
      if (!longPressedRef.current && distance <= 10) {
        onTap?.()
      }
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      clearTimer()
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    },
    onPointerLeave() {
      clearTimer()
    },
  }
}

function useIconGesture({
  onTap,
  onLongPress,
  onDragStart,
  onDragMove,
  onDragEnd,
  delay = 460,
}: {
  onTap?: () => void
  onLongPress?: () => void
  onDragStart?: () => void
  onDragMove: (offset: DragOffset, point: IconDragPoint) => IconDragMoveResult
  onDragEnd: (offset: DragOffset, point: IconDragPoint) => void
  delay?: number
}) {
  const [dragging, setDragging] = useState(false)
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<DragOffset>({ x: 0, y: 0 })
  const offsetRef = useRef<DragOffset>({ x: 0, y: 0 })
  const activeRef = useRef(false)
  const longPressedRef = useRef(false)
  const dragStartedRef = useRef(false)
  const onTapRef = useRef(onTap)
  const onLongPressRef = useRef(onLongPress)
  const onDragStartRef = useRef(onDragStart)
  const onDragMoveRef = useRef(onDragMove)
  const onDragEndRef = useRef(onDragEnd)

  useEffect(() => {
    onTapRef.current = onTap
    onLongPressRef.current = onLongPress
    onDragStartRef.current = onDragStart
    onDragMoveRef.current = onDragMove
    onDragEndRef.current = onDragEnd
  }, [onTap, onLongPress, onDragStart, onDragMove, onDragEnd])

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function triggerLongPress() {
    if (!longPressedRef.current) {
      longPressedRef.current = true
      onLongPressRef.current?.()
    }
  }

  function finishDrag(offset: DragOffset, point: IconDragPoint = {
    x: startRef.current.x + offset.x,
    y: startRef.current.y + offset.y,
  }) {
    dragStartedRef.current = false
    setDragging(false)
    onDragEndRef.current(offset, point)
  }

  function applyDragMove(offset: DragOffset, point: IconDragPoint) {
    const result = onDragMoveRef.current(offset, point)
    if (!result) {
      offsetRef.current = offset
      return
    }

    const resolved = 'offset' in result ? result : { offset: result }
    offsetRef.current = resolved.offset
    if (resolved.rebase) {
      startRef.current = {
        x: point.x - resolved.offset.x,
        y: point.y - resolved.offset.y,
      }
    }
  }

  function finishPointerInteraction(clientX: number, clientY: number) {
    const finalRawOffset = {
      x: clientX - startRef.current.x,
      y: clientY - startRef.current.y,
    }
    const distance = Math.hypot(
      finalRawOffset.x,
      finalRawOffset.y,
    )
    if (dragStartedRef.current) {
      finishDrag(clampDragOffset(finalRawOffset), { x: clientX, y: clientY })
      return
    }
    if (distance > 10) {
      onDragStartRef.current?.()
      onDragMoveRef.current({ x: 0, y: 0 }, { x: clientX, y: clientY })
      finishDrag(clampDragOffset(finalRawOffset), { x: clientX, y: clientY })
      return
    }
    if (!longPressedRef.current && distance <= 10) {
      onTapRef.current?.()
    }
  }

  useEffect(() => {
    function finishFromWindow(event: globalThis.PointerEvent | globalThis.MouseEvent) {
      if (!activeRef.current) {
        return
      }
      activeRef.current = false
      clearTimer()
      finishPointerInteraction(event.clientX, event.clientY)
    }

    function cancelFromWindow() {
      if (!activeRef.current) {
        return
      }
      activeRef.current = false
      clearTimer()
      if (dragStartedRef.current) {
        onDragMoveRef.current({ x: 0, y: 0 }, startRef.current)
        finishDrag(offsetRef.current)
      }
    }

    window.addEventListener('pointerup', finishFromWindow)
    window.addEventListener('pointercancel', cancelFromWindow)
    window.addEventListener('mouseup', finishFromWindow)
    window.addEventListener('blur', cancelFromWindow)
    return () => {
      window.removeEventListener('pointerup', finishFromWindow)
      window.removeEventListener('pointercancel', cancelFromWindow)
      window.removeEventListener('mouseup', finishFromWindow)
      window.removeEventListener('blur', cancelFromWindow)
    }
  }, [])

  return {
    dragging,
    bind: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        event.stopPropagation()
        event.preventDefault()
        activeRef.current = true
        dragStartedRef.current = false
        longPressedRef.current = false
        offsetRef.current = { x: 0, y: 0 }
        startRef.current = { x: event.clientX, y: event.clientY }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        timerRef.current = window.setTimeout(triggerLongPress, delay)
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        if (!activeRef.current) {
          return
        }
        const rawOffset = {
          x: event.clientX - startRef.current.x,
          y: event.clientY - startRef.current.y,
        }
        const distance = Math.hypot(rawOffset.x, rawOffset.y)
        if (distance <= 8) {
          return
        }
        event.preventDefault()
        clearTimer()
        if (!dragStartedRef.current) {
          dragStartedRef.current = true
          setDragging(true)
          onDragStartRef.current?.()
        }
        const nextOffset = clampDragOffset(rawOffset)
        applyDragMove(nextOffset, { x: event.clientX, y: event.clientY })
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        event.stopPropagation()
        if (!activeRef.current) {
          return
        }
        activeRef.current = false
        clearTimer()
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        finishPointerInteraction(event.clientX, event.clientY)
      },
      onPointerCancel(event: PointerEvent<HTMLElement>) {
        activeRef.current = false
        clearTimer()
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        if (dragStartedRef.current) {
          onDragMoveRef.current({ x: 0, y: 0 }, { x: event.clientX, y: event.clientY })
          finishDrag(offsetRef.current)
        }
      },
      onPointerLeave() {
        if (!dragStartedRef.current) {
          clearTimer()
        }
      },
    },
  }
}

function clampDragOffset(offset: DragOffset): DragOffset {
  return {
    x: Math.max(-132, Math.min(132, offset.x)),
    y: Math.max(-170, Math.min(170, offset.y)),
  }
}

let lastGestureEndAt = 0

function markGestureEnd() {
  lastGestureEndAt = performance.now()
}

// 拖拽结束后浏览器会补发一个 click；这个时间窗用来吞掉它，避免误触（如收起通知栏、打开通知）。
function wasRecentGesture(windowMs = 420) {
  return performance.now() - lastGestureEndAt < windowMs
}

type PanAxis = 'horizontal' | 'vertical'
type PanClaim = PanAxis | 'reject'

// 统一的指针平移手势：按下时不抢事件（保证子按钮可点击），
// 移动超过 slop 后按方向认领；被认领的手势才捕获指针并阻止冒泡。
function usePointerPan({
  onClaim,
  onMove,
  onEnd,
  onTap,
  slop = 10,
}: {
  onClaim: (deltaX: number, deltaY: number, startTarget: Element | null) => PanClaim
  onMove: (axis: PanAxis, deltaX: number, deltaY: number) => void
  onEnd: (axis: PanAxis, deltaX: number, deltaY: number) => void
  onTap?: (startTarget: Element | null) => void
  slop?: number
}) {
  const [claimedAxis, setClaimedAxis] = useState<PanAxis | null>(null)
  const stateRef = useRef({
    active: false,
    claimed: null as PanClaim | null,
    startX: 0,
    startY: 0,
    startTarget: null as Element | null,
    element: null as HTMLElement | null,
    pointerId: 0,
  })
  const callbacksRef = useRef({ onClaim, onMove, onEnd, onTap })

  useEffect(() => {
    callbacksRef.current = { onClaim, onMove, onEnd, onTap }
  }, [onClaim, onMove, onEnd, onTap])

  const releaseCapture = useCallback(() => {
    const state = stateRef.current
    if (state.element) {
      try {
        state.element.releasePointerCapture?.(state.pointerId)
      } catch {
        // 指针捕获可能已被浏览器释放
      }
    }
  }, [])

  const finishPan = useCallback(
    (clientX: number, clientY: number) => {
      const state = stateRef.current
      if (!state.active) {
        return
      }
      state.active = false
      releaseCapture()
      const deltaX = clientX - state.startX
      const deltaY = clientY - state.startY
      const claimed = state.claimed
      state.claimed = null
      setClaimedAxis(null)
      if (claimed === 'horizontal' || claimed === 'vertical') {
        markGestureEnd()
        callbacksRef.current.onEnd(claimed, deltaX, deltaY)
        return
      }
      if (Math.hypot(deltaX, deltaY) <= slop && !wasRecentGesture()) {
        callbacksRef.current.onTap?.(state.startTarget)
      }
    },
    [releaseCapture, slop],
  )

  const cancelPan = useCallback(() => {
    const state = stateRef.current
    if (!state.active) {
      return
    }
    state.active = false
    releaseCapture()
    const claimed = state.claimed
    state.claimed = null
    setClaimedAxis(null)
    if (claimed === 'horizontal' || claimed === 'vertical') {
      markGestureEnd()
      callbacksRef.current.onEnd(claimed, 0, 0)
    }
  }, [releaseCapture])

  useEffect(() => {
    function finishFromWindow(event: globalThis.PointerEvent | globalThis.MouseEvent) {
      finishPan(event.clientX, event.clientY)
    }

    function cancelFromWindow() {
      cancelPan()
    }

    window.addEventListener('pointerup', finishFromWindow)
    window.addEventListener('mouseup', finishFromWindow)
    window.addEventListener('pointercancel', cancelFromWindow)
    window.addEventListener('blur', cancelFromWindow)
    return () => {
      window.removeEventListener('pointerup', finishFromWindow)
      window.removeEventListener('mouseup', finishFromWindow)
      window.removeEventListener('pointercancel', cancelFromWindow)
      window.removeEventListener('blur', cancelFromWindow)
    }
  }, [cancelPan, finishPan])

  return {
    claimedAxis,
    bind: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        const state = stateRef.current
        state.active = true
        state.claimed = null
        state.startX = event.clientX
        state.startY = event.clientY
        state.startTarget = event.target instanceof Element ? event.target : null
        state.element = event.currentTarget
        state.pointerId = event.pointerId
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const state = stateRef.current
        if (!state.active) {
          return
        }
        const deltaX = event.clientX - state.startX
        const deltaY = event.clientY - state.startY
        if (state.claimed === null) {
          if (Math.hypot(deltaX, deltaY) <= slop) {
            return
          }
          state.claimed = callbacksRef.current.onClaim(deltaX, deltaY, state.startTarget)
          if (state.claimed !== 'reject') {
            setClaimedAxis(state.claimed)
            try {
              state.element?.setPointerCapture?.(state.pointerId)
            } catch {
              // 合成指针无法捕获
            }
          }
        }
        if (state.claimed === 'reject') {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        callbacksRef.current.onMove(state.claimed, deltaX, deltaY)
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        const state = stateRef.current
        if (!state.active) {
          return
        }
        if (state.claimed === 'horizontal' || state.claimed === 'vertical') {
          event.stopPropagation()
        }
        finishPan(event.clientX, event.clientY)
      },
      onPointerCancel() {
        cancelPan()
      },
      onClickCapture(event: MouseEvent<HTMLElement>) {
        if (wasRecentGesture()) {
          event.preventDefault()
          event.stopPropagation()
        }
      },
    },
  }
}

// 触控板双指滑动产生的是 wheel 事件而非指针拖拽；
// 这里把连续的 wheel 事件聚合成一次滑动手势（静默 settleMs 后结束）。
// 约定 delta 方向与系统自然滚动一致：双指上滑 deltaY > 0，双指左滑 deltaX > 0。
function useWheelPan({
  enabled = true,
  claim,
  onMove,
  onEnd,
  slop = 6,
  settleMs = 140,
}: {
  enabled?: boolean
  claim: (deltaX: number, deltaY: number) => boolean
  onMove?: (deltaX: number, deltaY: number) => void
  onEnd: (deltaX: number, deltaY: number) => void
  slop?: number
  settleMs?: number
}) {
  const elementRef = useRef<HTMLElement | null>(null)
  const stateRef = useRef({
    phase: 'idle' as 'idle' | 'claimed' | 'foreign',
    deltaX: 0,
    deltaY: 0,
    timer: null as number | null,
  })
  const callbacksRef = useRef({ enabled, claim, onMove, onEnd })

  useEffect(() => {
    callbacksRef.current = { enabled, claim, onMove, onEnd }
  }, [enabled, claim, onMove, onEnd])

  const resetState = useCallback(() => {
    const state = stateRef.current
    if (state.timer !== null) {
      window.clearTimeout(state.timer)
    }
    state.phase = 'idle'
    state.deltaX = 0
    state.deltaY = 0
    state.timer = null
  }, [])

  useEffect(() => {
    if (!enabled) {
      resetState()
    }
  }, [enabled, resetState])

  useEffect(() => resetState, [resetState])

  const handleWheel = useCallback(
    (event: globalThis.WheelEvent) => {
      const callbacks = callbacksRef.current
      const state = stateRef.current
      if (!callbacks.enabled) {
        return
      }
      const keepAlive = () => {
        if (state.timer !== null) {
          window.clearTimeout(state.timer)
        }
        state.timer = window.setTimeout(resetState, settleMs)
      }
      if (state.phase === 'foreign') {
        keepAlive()
        return
      }
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1
      state.deltaX += event.deltaX * scale
      state.deltaY += event.deltaY * scale
      if (state.phase === 'idle') {
        if (Math.hypot(state.deltaX, state.deltaY) <= slop) {
          keepAlive()
          return
        }
        state.phase = callbacks.claim(state.deltaX, state.deltaY) ? 'claimed' : 'foreign'
        if (state.phase === 'foreign') {
          keepAlive()
          return
        }
      }
      event.preventDefault()
      event.stopPropagation()
      callbacks.onMove?.(state.deltaX, state.deltaY)
      if (state.timer !== null) {
        window.clearTimeout(state.timer)
      }
      state.timer = window.setTimeout(() => {
        const deltaX = state.deltaX
        const deltaY = state.deltaY
        resetState()
        markGestureEnd()
        callbacksRef.current.onEnd(deltaX, deltaY)
      }, settleMs)
    },
    [resetState, settleMs, slop],
  )

  return useCallback(
    (element: HTMLElement | null) => {
      if (elementRef.current) {
        elementRef.current.removeEventListener('wheel', handleWheel)
      }
      elementRef.current = element
      if (element) {
        // React 的 onWheel 是 passive 的，无法 preventDefault 阻止页面滚动，必须手动挂原生监听。
        element.addEventListener('wheel', handleWheel, { passive: false })
      }
    },
    [handleWheel],
  )
}

function useHorizontalSwipe({
  onSwipe,
  threshold = 46,
}: {
  onSwipe: (direction: 'previous' | 'next') => void
  threshold?: number
}) {
  const startRef = useRef<DragOffset>({ x: 0, y: 0 })
  const activeRef = useRef(false)

  return {
    bind: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        startRef.current = { x: event.clientX, y: event.clientY }
        activeRef.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        if (!activeRef.current) {
          return
        }
        const deltaX = event.clientX - startRef.current.x
        const deltaY = event.clientY - startRef.current.y
        if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY)) {
          event.preventDefault()
        }
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        if (!activeRef.current) {
          return
        }
        activeRef.current = false
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        const deltaX = event.clientX - startRef.current.x
        const deltaY = event.clientY - startRef.current.y
        if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) {
          return
        }
        onSwipe(deltaX < 0 ? 'next' : 'previous')
      },
      onPointerCancel(event: PointerEvent<HTMLElement>) {
        activeRef.current = false
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      },
    },
  }
}

function isNestedInteractiveTarget(target: EventTarget | null, root: HTMLElement) {
  if (!(target instanceof Element)) {
    return false
  }

  const interactive = target.closest('button, a, input, select, textarea, [role="button"], [contenteditable="true"]')
  return Boolean(interactive && root.contains(interactive) && interactive !== root)
}

function useVerticalDrag({
  onMove,
  onEnd,
  onTap,
  tapThreshold = 8,
}: {
  onMove: (deltaY: number) => void
  onEnd: (deltaY: number) => void
  onTap?: () => void
  tapThreshold?: number
}) {
  const startYRef = useRef(0)
  const activeRef = useRef(false)
  const movedRef = useRef(false)
  const deltaRef = useRef(0)
  const captureTargetRef = useRef<HTMLElement | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  const suppressClickUntilRef = useRef(0)
  const onMoveRef = useRef(onMove)
  const onEndRef = useRef(onEnd)
  const onTapRef = useRef(onTap)

  useEffect(() => {
    onMoveRef.current = onMove
    onEndRef.current = onEnd
    onTapRef.current = onTap
  }, [onMove, onEnd, onTap])

  const releasePointerCapture = useCallback(() => {
    if (captureTargetRef.current && pointerIdRef.current !== null) {
      try {
        captureTargetRef.current.releasePointerCapture?.(pointerIdRef.current)
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    captureTargetRef.current = null
    pointerIdRef.current = null
  }, [])

  const finishDrag = useCallback((deltaY: number) => {
    if (!activeRef.current) {
      return
    }
    activeRef.current = false
    releasePointerCapture()
    suppressClickUntilRef.current = Date.now() + 350
    if (!movedRef.current && Math.abs(deltaY) <= tapThreshold) {
      if (!wasRecentGesture()) {
        onTapRef.current?.()
      }
      return
    }
    markGestureEnd()
    onEndRef.current(deltaY)
  }, [releasePointerCapture, tapThreshold])

  const cancelDrag = useCallback(() => {
    if (!activeRef.current) {
      return
    }
    activeRef.current = false
    releasePointerCapture()
    suppressClickUntilRef.current = Date.now() + 350
    deltaRef.current = 0
    onMoveRef.current(0)
  }, [releasePointerCapture])

  useEffect(() => {
    function finishFromWindow(event: globalThis.PointerEvent | globalThis.MouseEvent) {
      finishDrag(event.clientY - startYRef.current)
    }

    window.addEventListener('pointerup', finishFromWindow)
    window.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('mouseup', finishFromWindow)
    window.addEventListener('blur', cancelDrag)
    return () => {
      window.removeEventListener('pointerup', finishFromWindow)
      window.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('mouseup', finishFromWindow)
      window.removeEventListener('blur', cancelDrag)
    }
  }, [cancelDrag, finishDrag])

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (isNestedInteractiveTarget(event.target, event.currentTarget)) {
        return
      }
      event.stopPropagation()
      event.preventDefault()
      startYRef.current = event.clientY
      activeRef.current = true
      movedRef.current = false
      deltaRef.current = 0
      captureTargetRef.current = event.currentTarget
      pointerIdRef.current = event.pointerId
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (!activeRef.current) {
        return
      }
      const deltaY = event.clientY - startYRef.current
      if (Math.abs(deltaY) > tapThreshold) {
        movedRef.current = true
      }
      deltaRef.current = deltaY
      event.preventDefault()
      onMoveRef.current(deltaY)
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      finishDrag(event.clientY - startYRef.current)
    },
    onPointerCancel() {
      cancelDrag()
    },
    onClick(event: MouseEvent<HTMLElement>) {
      if (isNestedInteractiveTarget(event.target, event.currentTarget)) {
        return
      }
      event.stopPropagation()
      event.preventDefault()
      if (Date.now() < suppressClickUntilRef.current || wasRecentGesture()) {
        return
      }
      onMoveRef.current(0)
      onTapRef.current?.()
    },
  }
}

function pickAsset(assets: GeneratedAsset[], patterns: string[]): GeneratedAsset | undefined {
  return patterns
    .map((pattern) => assets.find((asset) => asset.path.includes(pattern)))
    .find(Boolean)
}

function largestAsset(assets: GeneratedAsset[]): GeneratedAsset | undefined {
  return [...assets].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
}
