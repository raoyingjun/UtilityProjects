const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function formatSimulatorDate(date = new Date()): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_LABELS[date.getDay()]}`
}

export function formatSimulatorWeekdayFirst(date = new Date()): string {
  return `${WEEKDAY_LABELS[date.getDay()]} ${date.getMonth() + 1}月${date.getDate()}日`
}
