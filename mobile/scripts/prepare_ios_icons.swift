// Tauri 2.12.3 writes RGBA even with an opaque iOS background. Apple rejects
// any alpha channel in the marketing icon; normalize generated iOS assets only.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let icons = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension == "png" }
precondition(!icons.isEmpty, "No iOS icons found")
for file in icons {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let context = CGContext(data: nil, width: image.width, height: image.height,
                                  bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
        fatalError("Unable to decode iOS icon: \(file.lastPathComponent)")
    }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(rect)
    context.draw(image, in: rect)
    guard let opaque = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fatalError("Unable to encode iOS icon")
    }
    CGImageDestinationAddImage(destination, opaque, nil)
    precondition(CGImageDestinationFinalize(destination), "Unable to save iOS icon")
    guard let check = CGImageSourceCreateWithURL(file as CFURL, nil),
          let result = CGImageSourceCreateImageAtIndex(check, 0, nil) else { fatalError("Invalid output PNG") }
    precondition([CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast].contains(result.alphaInfo), "Icon still has alpha")
}
print("Verified \(icons.count) opaque RGB iOS icons")
