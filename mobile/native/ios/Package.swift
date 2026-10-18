// swift-tools-version:5.5
import PackageDescription
let package = Package(
    name: "tauri-plugin-yuanheng-native",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-yuanheng-native", type: .static, targets: ["tauri-plugin-yuanheng-native"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-yuanheng-native", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
