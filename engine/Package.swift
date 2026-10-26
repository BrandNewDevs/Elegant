// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "engine",
    platforms: [.macOS("14.2")],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", .upToNextMinor(from: "1.1.1")),
    ],
    targets: [
        .executableTarget(
            name: "engine",
            dependencies: [
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "SpeakerKit", package: "argmax-oss-swift"),
            ],
            path: "Sources/engine"
        ),
        .testTarget(name: "engineTests", dependencies: ["engine"], path: "Tests/engineTests"),
    ]
)
