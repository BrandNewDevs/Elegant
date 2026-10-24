// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "engine",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(name: "engine", path: "Sources/engine"),
        .testTarget(name: "engineTests", dependencies: ["engine"], path: "Tests/engineTests"),
    ]
)
