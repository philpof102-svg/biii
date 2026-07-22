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
| `#2f6bff` | trust · Base (primary) |
| `#16b364` | verified · safe |
| `#f5921b` | signal |
| `#0b1220` | ground (ink) |
| `#ffffff` | surface |

Bar order is always blue → green → orange. The ground is `#0b1220`; never pure black.
