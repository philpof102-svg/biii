# Rasterise web/brand/biii-og.svg to the Base Dashboard thumbnail (1.91:1, max 1 MB).
# The SVG uses <text>, which scripts/brand-icon-png.js refuses by design; GDI+ has the very font
# the SVG asks for first (Segoe UI), so this transcribes the card instead: every coordinate below
# is COPIED from the SVG, not invented. Divergence bound: letter-spacing (1-2px) is not applied.
# Canvas is authored 1200x630; the exported crop keeps the top 1200x628 (1.9108:1 vs 1.91 asked),
# dropping 2 bottom rows of flat background.
Add-Type -AssemblyName System.Drawing

$W = 1200; $H = 630; $OUT = 628
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Brush([string]$hex) { New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function RoundBar($g, $b, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); $g.FillPath($b, $p); $p.Dispose()
}

# <rect width=1200 height=630 fill=#06080d> + the 6px tricolour top strip
$g.FillRectangle((Brush '#06080d'), 0, 0, $W, $H)
$g.FillRectangle((Brush '#0052ff'), 0, 0, 1200, 6)
$g.FillRectangle((Brush '#16c784'), 400, 0, 200, 6)
$g.FillRectangle((Brush '#f7931a'), 600, 0, 200, 6)

# <text x=486 y=360 weight=700 size=150 fill=#ffffff>B</text>  (SVG y is the BASELINE;
# GDI DrawString wants the em-box TOP: top = baseline - ascent(px))
$fam = New-Object System.Drawing.FontFamily('Segoe UI')
$bold = [System.Drawing.FontStyle]::Bold
$fB = New-Object System.Drawing.Font('Segoe UI', 150, $bold, [System.Drawing.GraphicsUnit]::Pixel)
$ascB = 150 * $fam.GetCellAscent($bold) / $fam.GetEmHeight($bold)
$g.DrawString('B', $fB, (Brush '#ffffff'), 486 - 12, 360 - $ascB)  # -12: GDI left bearing padding

# the three bars: x 606/648/690, y 238, 26x112, rx 13
RoundBar $g (Brush '#0052ff') 606 238 26 112 13
RoundBar $g (Brush '#16c784') 648 238 26 112 13
RoundBar $g (Brush '#f7931a') 690 238 26 112 13

# the two centred taglines (y = baseline)
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$reg = [System.Drawing.FontStyle]::Regular
$f34 = New-Object System.Drawing.Font('Segoe UI', 34, $reg, [System.Drawing.GraphicsUnit]::Pixel)
$f24 = New-Object System.Drawing.Font('Segoe UI', 24, $reg, [System.Drawing.GraphicsUnit]::Pixel)
$asc34 = 34 * $fam.GetCellAscent($reg) / $fam.GetEmHeight($reg)
$asc24 = 24 * $fam.GetCellAscent($reg) / $fam.GetEmHeight($reg)
$g.DrawString('safe to pay ' + [char]0xB7 + ' token-genuineness verdicts on Base', $f34, (Brush '#cdd8e8'), 600, 432 - $asc34, $center)
$g.DrawString('fail-closed ' + [char]0xB7 + ' non-custodial ' + [char]0xB7 + ' re-verifiable on-chain', $f24, (Brush '#6f8098'), 600, 480 - $asc24, $center)

$g.Dispose()
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle(0, 0, $W, $OUT)), $bmp.PixelFormat)
$path = 'D:\Users\VolKov\veilleIA\biii\web\brand\biii-og-1200x628.png'
$crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose(); $bmp.Dispose()
$fi = Get-Item $path
'{0}  {1} bytes  ratio={2:N4}' -f $fi.Name, $fi.Length, (1200 / $OUT)
