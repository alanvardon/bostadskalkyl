import { describe, it, expect } from 'vitest'
import { pct, formatWithSpaces, parseFormatted, fmtCompact } from './format'

describe('formatters', () => {
  it('formatWithSpaces groups thousands', () => expect(formatWithSpaces(5_850_000)).toBe('5 850 000'))
  it('formatWithSpaces rounds', () => expect(formatWithSpaces(1234.6)).toBe('1 235'))
  it('pct: one decimal', () => expect(pct(10)).toBe('10.0%'))
  it('parseFormatted strips spaces', () => expect(parseFormatted('5 850 000')).toBe(5_850_000))
  it('parseFormatted treats comma as decimal', () => expect(parseFormatted('3,5')).toBe(3.5))
  it('parseFormatted invalid → 0', () => expect(parseFormatted('abc')).toBe(0))
})

describe('fmtCompact', () => {
  it('millions → mnkr with one decimal under 10', () => expect(fmtCompact(4_200_000)).toBe('4,2 mnkr'))
  it('millions ≥ 10 round to whole', () => expect(fmtCompact(12_000_000)).toBe('12 mnkr'))
  it('exactly one million', () => expect(fmtCompact(1_000_000)).toBe('1 mnkr'))
  it('thousands → tkr, whole when ≥ 10', () => expect(fmtCompact(120_000)).toBe('120 tkr'))
  it('thousands keep one decimal under 10', () => expect(fmtCompact(4_500)).toBe('4,5 tkr'))
  it('sub-thousand → kr', () => expect(fmtCompact(950)).toBe('950 kr'))
  it('rounds sub-thousand', () => expect(fmtCompact(949.6)).toBe('950 kr'))
  it('negative gets a minus sign', () => expect(fmtCompact(-50_000)).toBe('−50 tkr'))
  it('signed prefixes + for positive', () => expect(fmtCompact(120_000, true)).toBe('+120 tkr'))
  it('signed leaves zero unsigned', () => expect(fmtCompact(0, true)).toBe('0 kr'))
})
