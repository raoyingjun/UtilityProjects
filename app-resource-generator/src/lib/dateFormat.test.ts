import { describe, expect, it } from 'vitest'
import { formatSimulatorDate, formatSimulatorWeekdayFirst } from './dateFormat'

describe('formatSimulatorDate', () => {
  it('formats month/day with the Chinese weekday label', () => {
    // 2024-01-07 is a Sunday.
    expect(formatSimulatorDate(new Date(2024, 0, 7))).toBe('1月7日 周日')
  })

  it('maps each weekday to the correct label', () => {
    expect(formatSimulatorDate(new Date(2024, 0, 8))).toBe('1月8日 周一') // Monday
    expect(formatSimulatorDate(new Date(2024, 0, 13))).toBe('1月13日 周六') // Saturday
  })

  it('uses two-digit day numbers verbatim (no zero padding)', () => {
    expect(formatSimulatorDate(new Date(2026, 11, 25))).toMatch(/^12月25日 周[日一二三四五六]$/)
  })

  it('defaults to the current date and returns a well-formed string', () => {
    expect(formatSimulatorDate()).toMatch(/^\d{1,2}月\d{1,2}日 周[日一二三四五六]$/)
  })
})

describe('formatSimulatorWeekdayFirst', () => {
  it('puts the weekday label before the month/day', () => {
    expect(formatSimulatorWeekdayFirst(new Date(2024, 0, 7))).toBe('周日 1月7日')
  })

  it('defaults to the current date and returns a well-formed string', () => {
    expect(formatSimulatorWeekdayFirst()).toMatch(/^周[日一二三四五六] \d{1,2}月\d{1,2}日$/)
  })
})
