import { describe, it, expect } from 'vitest'
import { todayISO } from './date'

describe('todayISO', () => {
  it('returns the local date as zero-padded YYYY-MM-DD', () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const expected = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    expect(todayISO()).toBe(expected)
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
