# BIII — brand assets

The **BIII** mark: the **B** is the brand; the **III** are the three trust lenses BIII
composes — reputation · standing · on-chain settlement — drawn as three colored bars.
Vector SVG only (crisp at any size, editable, no raster blur).

## Files

| File | Use |
| --- | --- |
| `biii-icon.svg` | square badge (rounded), the mark alone — favicon, app icon, avatar |
| `biii-icon-maskable.svg` | full-bleed square, art inside the safe zone — PWA `maskable` icon |
| `biii-wordmark.svg` | horizontal `B` + three bars, dark ink — on light backgrounds |
| `biii-wordmark-dark.svg` | same, white ink — on dark backgrounds |

Served by the app at `/brand/<file>` and wired into `manifest.json` + `index.html`.

## Palette

| Hex | Role |
| --- | --- |
| `#0052ff` | Base blue (primary) |
| `#16c784` | bullish green |
| `#f7931a` | Bitcoin orange |
| `#06080d` | deep black (ink/ground) |
| `#ffffff` | surface |

Bar order is always blue → green → orange (Base · bullish · Bitcoin). The ground is
`#06080d` — a deep near-black, never a flat `#000`.
