# Dark contrast audit

WCAG sRGB relative luminance, minimum 4.5:1 for all text sizes. Ratios rounded to two decimals. Main tokens already passed; legacy light surfaces and graph colors needed overrides.

## Fixed pairs

| Text | Before foreground/background | Before | After foreground/background | After |
|---|---|---:|---|---:|
| Tooltip body | #d7e0ee / #ffffff | 1.33 | #d7e0ee / #141e33 | 12.50 |
| Tooltip muted | #a5b3c8 / #ffffff | 2.13 | #a5b3c8 / #141e33 | 7.82 |
| Control hover ink | #d7e0ee / #edf2f9 | 1.18 | #d7e0ee / #141e33 | 12.50 |
| Control hover muted | #a5b3c8 / #edf2f9 | 1.89 | #a5b3c8 / #141e33 | 7.82 |
| Contract legend | #9624b5 / #141e33 | 2.55 | #8fb8ff / #141e33 | 8.29 |
| Impact legend | #b92d3b / #141e33 | 2.77 | #ffada5 / #141e33 | 9.32 |
| Last network statistic | #2c77da / #141e33 | 3.77 | #8fb8ff / #141e33 | 8.29 |
| Node heading | #edf3ff / #ffe2e5 | 1.09 | #edf3ff / #3e242b | 12.64 |
| Node directory | #a5b3c8 / #ffe2e5 | 1.75 | #a5b3c8 / #3e242b | 6.62 |
| Node heading | #edf3ff / #fff0f1 | 1.01 | #edf3ff / #3e242b | 12.64 |
| Node directory | #a5b3c8 / #fff0f1 | 1.92 | #a5b3c8 / #3e242b | 6.62 |
| Node heading | #edf3ff / #eef5ff | 1.01 | #edf3ff / #1d355b | 11.02 |
| Node directory | #a5b3c8 / #eef5ff | 1.94 | #a5b3c8 / #1d355b | 5.77 |
| Edited badge blue | #ffffff / #2c77b5 | 4.76 | #ffffff / #141e33 | 16.62 |
| Edited badge purple | #ffffff / #a646c0 | 4.93 | #ffffff / #141e33 | 16.62 |

## Complete semantic palette matrix

This conservatively checks every text token on every general surface, including combinations not currently used. Borders, dots and focus outlines are non-text. Status surfaces and fixed-color badges follow below.

| Text | bg | surface | line-soft | floor |
|---|---:|---:|---:|---:|
| ink (#d7e0ee) | 13.53 | 12.50 | 10.94 | 9.22 |
| heading (#edf3ff) | 16.16 | 14.93 | 13.08 | 11.02 |
| muted (#a5b3c8) | 8.47 | 7.82 | 6.85 | 5.77 |
| accent-text (#8fb8ff) | 8.97 | 8.29 | 7.26 | 6.11 |
| danger (#ffada5) | 10.09 | 9.32 | 8.16 | 6.87 |
| ok (#88dca5) | 10.99 | 10.15 | 8.89 | 7.49 |
| warn (#f5cf89) | 12.14 | 11.22 | 9.82 | 8.27 |
| purple (#8fb8ff) | 8.97 | 8.29 | 7.26 | 6.11 |

| Additional pair | Ratio |
|---|---:|
| #f5cf89 / #352914 | 9.58 |
| #88dca5 / #19392e | 7.70 |
| #ffada5 / #3e242b | 7.89 |
| #edf3ff / #3e242b | 12.64 |
| #a5b3c8 / #3e242b | 6.62 |
| #ffffff / #075fa8 | 6.54 |
| #ffffff / #9624b5 | 6.53 |
| #ffffff / #141e33 | 16.62 |
| #245b9e / #e1edff | 5.79 |
| #7a1f1f / #fff4f4 | 9.54 |

Dynamic owner labels now use ink on an opaque surface instead of arbitrary owner colors at 85% opacity. Syntax spans inherit ink in dark mode because CodeMirror basicSetup supplies light-only highlighting. Timeline flash uses the dark floor, not an accent/white mixture. Graph activity uses ink/surface. Diff row backgrounds blend 12% owner color with surface; even the brightest possible owner (white) keeps muted text above 4.5:1. The PNG has a 36px rounded white plate with 4px padding. These are static contrast calculations, not a hosted screenshot verification.
