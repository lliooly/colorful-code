import Foundation
import XCTest
import ColorfulCodeContracts
@testable import GoldenFixtureSupport

final class GoldenFixtureTests: XCTestCase {
  private func fixtureRoot() throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    guard let path = environment["SCHEMA_GOLDEN_FIXTURE_ROOT"], !path.isEmpty else {
      throw GoldenConformanceError.configuration
    }
    return URL(fileURLWithPath: path, isDirectory: true)
  }

  func testAllManifestFixturesProduceMatchingSwiftResults() throws {
    let results = try GoldenFixtureRunner.run(root: fixtureRoot())
    XCTAssertEqual(results.count, 254)
    XCTAssertTrue(results.allSatisfy(\.matchesExpectation))
    XCTAssertEqual(Set(results.map(\.id)).count, 254)
  }

  func testOptionalNullablePresence() throws {
    let results = try GoldenFixtureRunner.run(root: fixtureRoot())
    XCTAssertEqual(results.first { $0.id == "optional-nullable.absent" }?.presence, .absent)
    XCTAssertEqual(results.first { $0.id == "optional-nullable.null" }?.presence, .null)
    XCTAssertEqual(results.first { $0.id == "optional-nullable.value" }?.presence, .value)
  }

  func testEventOutcomesAndUnknownPreservation() throws {
    let results = try GoldenFixtureRunner.run(root: fixtureRoot())
    XCTAssertEqual(results.first { $0.id == "known-event.malformed.protocol-error" }?.outcome, .protocolError)
    XCTAssertEqual(results.first { $0.id == "unknown.critical" }?.outcome, .resetRequired)
    XCTAssertEqual(results.first { $0.id == "unknown.durable.non-critical" }?.outcome, .unknownNonCritical)
    XCTAssertEqual(results.first { $0.id == "unknown.transient.non-critical" }?.outcome, .unknownNonCritical)
    XCTAssertEqual(
      results.first { $0.id == "unknown.durable.non-critical" }?.preservedCursors,
      ["9007199254740993"]
    )
    XCTAssertEqual(
      results.first { $0.id == "unknown.transient.non-critical" }?.preservedCursors,
      ["9007199254740994", "9007199254740993"]
    )
    XCTAssertEqual(
      results.first { $0.id == "unknown.durable.non-critical" }?.preservedRawEvent,
      true
    )
  }

  func testGeneratedStructsRejectUnknownKeysAsDataCorruption() throws {
    let root = try fixtureRoot()
    let topLevel = try Data(contentsOf: root.appendingPathComponent("invalid/reject.unknown-top-level.json"))
    let nested = try Data(contentsOf: root.appendingPathComponent("invalid/reject.unknown-nested.json"))
    for operation in [
      { _ = try JSONDecoder().decode(HealthResponse.self, from: topLevel) },
      { _ = try JSONDecoder().decode(ApiError.self, from: nested) },
    ] {
      XCTAssertThrowsError(try operation()) { error in
        guard case DecodingError.dataCorrupted = error else {
          return XCTFail("unexpected decoding category")
        }
      }
    }
  }

  func testJsonLinesAreNarrowDeterministicAndPayloadFree() throws {
    let lines = try GoldenFixtureRunner.jsonLines(root: fixtureRoot())
    XCTAssertEqual(lines.count, 254)
    XCTAssertEqual(lines, lines.sorted())
    XCTAssertFalse(lines.joined().contains("not-a-secret-value"))
    for line in lines {
      let object = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String]
      )
      XCTAssertEqual(Set(object.keys), Set(["id", "outcome"]))
      let id = try XCTUnwrap(object["id"])
      let outcome = try XCTUnwrap(object["outcome"])
      XCTAssertFalse(id.isEmpty)
      XCTAssertFalse(outcome.isEmpty)
    }
  }

  func testJsonLinesRejectExpectationMismatchWhileRunRemainsDiagnostic() throws {
    try withCatalogCopy { root in
      try mutateManifest(root) { objects in
        let expectation = objects[0]["expect"] as! String
        objects[0]["expect"] = expectation == "accept" ? "reject" : "accept"
      }

      let results = try GoldenFixtureRunner.run(root: root)
      XCTAssertTrue(results.contains { !$0.matchesExpectation })
      XCTAssertThrowsError(try GoldenFixtureRunner.jsonLines(root: root)) { error in
        XCTAssertEqual(String(describing: error), "golden-conformance: expectation")
        XCTAssertFalse(String(describing: error).contains("not-a-secret-value"))
      }
    }
  }

  func testCliRejectsExpectationMismatchWithoutPayloadOutput() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let executable = environment["SCHEMA_CONFORMANCE_EXECUTABLE"], !executable.isEmpty else {
      throw XCTSkip("SCHEMA_CONFORMANCE_EXECUTABLE is not configured")
    }
    try withCatalogCopy { root in
      try mutateManifest(root) { objects in
        let expectation = objects[0]["expect"] as! String
        objects[0]["expect"] = expectation == "accept" ? "reject" : "accept"
      }
      let outputRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("colorful-swift-output-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(
        at: outputRoot,
        withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700]
      )
      defer { try? FileManager.default.removeItem(at: outputRoot) }

      let process = Process()
      let standardOutput = Pipe()
      let standardError = Pipe()
      process.executableURL = URL(fileURLWithPath: executable)
      process.arguments = [
        "--fixture-root", root.path,
        "--output-root", outputRoot.path,
        "--output-name", "swift.jsonl",
      ]
      process.standardOutput = standardOutput
      process.standardError = standardError
      try process.run()
      process.waitUntilExit()

      XCTAssertNotEqual(process.terminationStatus, 0)
      XCTAssertEqual(standardOutput.fileHandleForReading.readDataToEndOfFile(), Data())
      let error = standardError.fileHandleForReading.readDataToEndOfFile()
      XCTAssertEqual(String(data: error, encoding: .utf8), "swift conformance failed\n")
      XCTAssertFalse(String(data: error, encoding: .utf8)?.contains("not-a-secret-value") == true)
    }
  }

  func testCatalogValidationFailsClosedWithoutExposingValues() throws {
    let mutations: [(URL) throws -> Void] = [
      { root in try mutateManifest(root) { $0.append($0[0]) } },
      { root in try mutateManifest(root) { $0[0]["file"] = "../escape.json" } },
      { root in try mutateManifest(root) { $0[0]["schema"] = "schema:MissingSecretValue" } },
      { root in
        let manifest = try manifestObjects(root)
        try FileManager.default.removeItem(at: root.appendingPathComponent(manifest[0]["file"] as! String))
      },
      { root in try Data("{}".utf8).write(to: root.appendingPathComponent("valid/orphan.json")) },
      { root in try Data().write(to: root.appendingPathComponent("unexpected")) },
      { root in
        let manifest = try manifestObjects(root)
        let first = root.appendingPathComponent(manifest[0]["file"] as! String)
        let second = root.appendingPathComponent(manifest[1]["file"] as! String)
        try FileManager.default.removeItem(at: first)
        try FileManager.default.createSymbolicLink(at: first, withDestinationURL: second)
      },
      { root in
        let manifest = try manifestObjects(root)
        let first = root.appendingPathComponent(manifest[0]["file"] as! String)
        let second = root.appendingPathComponent(manifest[1]["file"] as! String)
        try FileManager.default.removeItem(at: first)
        try FileManager.default.linkItem(at: second, to: first)
      },
    ]
    for mutation in mutations {
      try withCatalogCopy { root in
        try mutation(root)
        XCTAssertThrowsError(try GoldenFixtureRunner.run(root: root)) { error in
          XCTAssertFalse(String(describing: error).contains("MissingSecretValue"))
          XCTAssertFalse(String(describing: error).contains("not-a-secret-value"))
        }
      }
    }
  }

  func testCatalogSnapshotRejectsMixedGenerations() throws {
    let mutations: [(URL) throws -> Void] = [
      { root in
        let manifest = root.appendingPathComponent("manifest.json")
        var data = try Data(contentsOf: manifest)
        data.append(contentsOf: [0x20])
        try data.write(to: manifest, options: .atomic)
      },
      { root in
        let objects = try manifestObjects(root)
        let fixture = root.appendingPathComponent(objects[0]["file"] as! String)
        let data = try Data(contentsOf: fixture)
        let handle = try FileHandle(forWritingTo: fixture)
        try handle.write(contentsOf: data)
        try handle.close()
      },
      { root in
        let objects = try manifestObjects(root)
        let first = root.appendingPathComponent(objects[0]["file"] as! String)
        let second = root.appendingPathComponent(objects[1]["file"] as! String)
        try FileManager.default.removeItem(at: first)
        try FileManager.default.createSymbolicLink(at: first, withDestinationURL: second)
      },
    ]
    for mutation in mutations {
      try withCatalogCopy { root in
        XCTAssertThrowsError(
          try GoldenFixtureRunner.run(root: root) { try mutation(root) }
        ) { error in
          XCTAssertEqual(String(describing: error), "golden-conformance: catalog")
        }
      }
    }
  }

  func testCatalogRejectsOversizedFixtureBeforeDecoding() throws {
    try withCatalogCopy { root in
      let objects = try manifestObjects(root)
      let fixture = root.appendingPathComponent(objects[0]["file"] as! String)
      try Data(count: 4 * 1024 * 1024 + 1).write(to: fixture)
      XCTAssertThrowsError(try GoldenFixtureRunner.run(root: root)) { error in
        XCTAssertEqual(String(describing: error), "golden-conformance: catalog")
      }
    }
  }

  func testCatalogBoundsDirectoryEntryCounts() throws {
    try withCatalogCopy { root in
      let directory = root.appendingPathComponent("valid", isDirectory: true)
      for index in 0 ... 1_024 {
        _ = FileManager.default.createFile(
          atPath: directory.appendingPathComponent("excess-\(index).json").path,
          contents: Data()
        )
      }
      XCTAssertThrowsError(try GoldenFixtureRunner.run(root: root)) { error in
        XCTAssertEqual(String(describing: error), "golden-conformance: catalog")
      }
    }
  }

  private func withCatalogCopy(_ body: (URL) throws -> Void) throws {
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent("colorful-swift-golden-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: try fixtureRoot(), to: destination)
    defer { try? FileManager.default.removeItem(at: destination) }
    try body(destination)
  }
}

private func manifestObjects(_ root: URL) throws -> [[String: Any]] {
  let data = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
  guard let objects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
    throw GoldenConformanceError.manifest
  }
  return objects
}

private func mutateManifest(
  _ root: URL,
  _ mutation: (inout [[String: Any]]) -> Void
) throws {
  var objects = try manifestObjects(root)
  mutation(&objects)
  let data = try JSONSerialization.data(withJSONObject: objects, options: [.sortedKeys])
  try data.write(to: root.appendingPathComponent("manifest.json"), options: .atomic)
}
