# Plan: Increase stress slider granularity

## Goal
Allow the Section 4 interest rate stress test slider to be adjusted in 0.01% increments instead of 0.1%, for finer-grained sensitivity analysis.

## Changes
Two edits to `/Users/avardon/Programming/bostadskalkyl/bostadskalkyl.html`:

1. Slider step attribute: `step="0.1"` → `step="0.01"` on the Section 4 stress test slider input.
2. JS display formatting: `stressRate.toFixed(1)` → `stressRate.toFixed(2)` so the displayed value reflects the new granularity.

## Type
refactor (UI granularity adjustment)

PLAN COMPLETE: title=Increase stress slider granularity, type=refactor
