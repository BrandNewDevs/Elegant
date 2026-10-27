// Draws the installer window's background: a drag-to-Applications arrow between the two icon slots. The committed
// app/assets/dmg-background.png (and the @2x) come from this; regenerate them with
//   swift scripts/dmg-background.swift assets
// Keep the size and the slot centres in step with scripts/dmg-settings.py.
//
// Finder draws icon labels in black or white depending on the viewer's appearance, whatever the background is, so the
// background is a mid-tone grey-blue that both read on, and the arrow is white at a moderate opacity.
import AppKit

let size = CGSize(width: 660, height: 400)
let appCentre = CGPoint(x: 180, y: 190)
let applicationsCentre = CGPoint(x: 480, y: 190)

func render(scale: CGFloat) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size // 144 dpi for the @2x, so Finder lays it out at 660x400 points
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    defer { NSGraphicsContext.restoreGraphicsState() }

    let top = NSColor(srgbRed: 0.50, green: 0.55, blue: 0.64, alpha: 1)
    let bottom = NSColor(srgbRed: 0.38, green: 0.43, blue: 0.52, alpha: 1)
    NSGradient(starting: top, ending: bottom)!.draw(in: NSRect(origin: .zero, size: size), angle: -90)

    // AppKit's origin is bottom-left; the slot centres above are measured from the top, as Finder does.
    let y = size.height - appCentre.y
    let arrow = NSBezierPath()
    arrow.lineWidth = 7
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    let x0 = appCentre.x + 95, x1 = applicationsCentre.x - 95
    arrow.move(to: CGPoint(x: x0, y: y))
    arrow.line(to: CGPoint(x: x1, y: y))
    arrow.move(to: CGPoint(x: x1 - 22, y: y + 22))
    arrow.line(to: CGPoint(x: x1, y: y))
    arrow.line(to: CGPoint(x: x1 - 22, y: y - 22))
    NSColor.white.withAlphaComponent(0.8).setStroke()
    arrow.stroke()

    return rep.representation(using: .png, properties: [:])!
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: swift scripts/dmg-background.swift <output directory>\n".utf8))
    exit(1)
}
let out = URL(fileURLWithPath: CommandLine.arguments[1])
try render(scale: 1).write(to: out.appendingPathComponent("dmg-background.png"))
try render(scale: 2).write(to: out.appendingPathComponent("dmg-background@2x.png"))
