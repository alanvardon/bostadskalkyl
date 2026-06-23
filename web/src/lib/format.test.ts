import { describe, it, expect } from 'vitest'
import { pct, formatWithSpaces, parseFormatted } from './format'

describe('formatters', () => {
  it('formatWithSpaces groups thousands', () => expect(formatWithSpaces(5_850_000)).toBe('5 850 000'))
  it('formatWithSpaces rounds', () => expect(formatWithSpaces(1234.6)).toBe('1 235'))
  it('pct: one decimal', () => expect(pct(10)).toBe('10.0%'))
  it('parseFormatted strips spaces', () => expect(parseFormatted('5 850 000')).toBe(5_850_000))
  it('parseFormatted treats comma as decimal', () => expect(parseFormatted('3,5')).toBe(3.5))
  it('parseFormatted invalid → 0', () => expect(parseFormatted('abc')).toBe(0))
})
