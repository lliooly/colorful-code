// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "ColorfulCodeContracts",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "ColorfulCodeContracts", targets: ["ColorfulCodeContracts"]),
    .executable(name: "ColorfulCodeConformance", targets: ["ColorfulCodeConformance"]),
  ],
  targets: [
    .target(name: "ColorfulCodeContracts"),
    .target(
      name: "GoldenFixtureSupport",
      dependencies: ["ColorfulCodeContracts"]
    ),
    .executableTarget(
      name: "ColorfulCodeConformance",
      dependencies: ["GoldenFixtureSupport"]
    ),
    .testTarget(
      name: "ColorfulCodeContractsTests",
      dependencies: ["ColorfulCodeContracts", "GoldenFixtureSupport"]
    ),
  ]
)
