import Foundation
import Darwin
import ColorfulCodeContracts

private let maximumCatalogFileBytes = 4 * 1024 * 1024
private let maximumCatalogBytes = 16 * 1024 * 1024
private let maximumCatalogDirectoryEntries = 1_024

enum GoldenConformanceError: Error, CustomStringConvertible {
  case configuration
  case catalog
  case manifest
  case fixture(String)
  case unknownSchemaTarget
  case protocolError
  case criticalUnknownEvent
  case expectationMismatch

  var description: String {
    switch self {
    case .configuration: "golden-conformance: configuration"
    case .catalog: "golden-conformance: catalog"
    case .manifest: "golden-conformance: manifest"
    case .fixture(let id): "golden-conformance: fixture \(id)"
    case .unknownSchemaTarget: "golden-conformance: schema-target"
    case .protocolError: "golden-conformance: protocol-error"
    case .criticalUnknownEvent: "golden-conformance: critical-unknown-event"
    case .expectationMismatch: "golden-conformance: expectation"
    }
  }
}

enum FixtureExpectation: String, Codable, Equatable, Sendable {
  case accept
  case reject
}

enum FixtureOutcome: String, Codable, Equatable, Sendable {
  case known
  case unknownNonCritical
  case resetRequired
  case protocolError
}

enum FixturePresence: String, Codable, Equatable, Sendable {
  case absent
  case null
  case value
}

struct GoldenFixtureResult: Codable, Sendable {
  let id: String
  let expect: FixtureExpectation
  let accepted: Bool
  let expectedOutcome: FixtureOutcome?
  let outcome: FixtureOutcome?
  let presence: FixturePresence?
  let preservedCursors: [String]
  let preservedRawEvent: Bool

  var matchesExpectation: Bool {
    accepted == (expect == .accept) && outcome == expectedOutcome
  }
}

private struct DynamicCodingKey: CodingKey {
  let stringValue: String
  let intValue: Int?

  init?(stringValue: String) {
    self.stringValue = stringValue
    self.intValue = nil
  }

  init?(intValue: Int) {
    self.stringValue = String(intValue)
    self.intValue = intValue
  }
}

private struct ManifestEntry: Decodable, Sendable {
  let id: String
  let schema: String
  let file: String
  let expect: FixtureExpectation
  let expectedOutcome: FixtureOutcome?

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case id
    case schema
    case file
    case expect
    case expectedOutcome
  }

  init(from decoder: Decoder) throws {
    let dynamic = try decoder.container(keyedBy: DynamicCodingKey.self)
    let allowed = Set(CodingKeys.allCases.map(\.rawValue))
    guard dynamic.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else {
      throw GoldenConformanceError.manifest
    }
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    schema = try container.decode(String.self, forKey: .schema)
    file = try container.decode(String.self, forKey: .file)
    expect = try container.decode(FixtureExpectation.self, forKey: .expect)
    expectedOutcome = try container.decodeIfPresent(FixtureOutcome.self, forKey: .expectedOutcome)
    guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !schema.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !file.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      throw GoldenConformanceError.manifest
    }
  }
}

private struct CatalogSnapshot {
  let manifestData: Data
  let files: [String: Data]
  let identities: [String: FileIdentity]
}

private struct ValidatedRoot {
  let url: URL
  let identity: FileIdentity
}

private struct FileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
  let size: Int64
  let mode: UInt16
  let links: UInt16
  let modifiedSeconds: Int
  let modifiedNanoseconds: Int
  let changedSeconds: Int
  let changedNanoseconds: Int
}

private struct DecodedFixture {
  var outcome: FixtureOutcome?
  var presence: FixturePresence?
  var cursors: [String] = []
  var rawEvent: JSONValue?
}

public enum GoldenFixtureRunner {
  static func run(
    root: URL,
    afterSnapshot: (() throws -> Void)? = nil
  ) throws -> [GoldenFixtureResult] {
    let validatedRoot = try validateRoot(root)
    let initial = try snapshot(
      root: validatedRoot.url,
      expectedRootIdentity: validatedRoot.identity
    )
    let entries: [ManifestEntry]
    do {
      entries = try JSONDecoder().decode([ManifestEntry].self, from: initial.manifestData)
    } catch {
      throw GoldenConformanceError.manifest
    }
    try validate(entries: entries, files: initial.files)
    try afterSnapshot?()

    var results: [GoldenFixtureResult] = []
    results.reserveCapacity(entries.count)
    for entry in entries {
      guard let data = initial.files[entry.file] else {
        throw GoldenConformanceError.fixture(entry.id)
      }
      results.append(run(entry: entry, data: data))
    }

    let final = try snapshot(
      root: validatedRoot.url,
      expectedRootIdentity: validatedRoot.identity
    )
    guard initial.manifestData == final.manifestData,
      initial.files == final.files,
      initial.identities == final.identities
    else {
      throw GoldenConformanceError.catalog
    }
    return results.sorted {
      Array($0.id.utf8).lexicographicallyPrecedes(Array($1.id.utf8))
    }
  }

  public static func jsonLines(root: URL) throws -> [String] {
    struct ComparisonRecord: Encodable {
      let id: String
      let outcome: String
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let results = try run(root: root)
    guard results.allSatisfy(\.matchesExpectation) else {
      throw GoldenConformanceError.expectationMismatch
    }
    return try results.map { result in
      let record = ComparisonRecord(
        id: result.id,
        outcome: result.outcome?.rawValue ?? (result.accepted ? "accept" : "reject")
      )
      guard let line = String(data: try encoder.encode(record), encoding: .utf8) else {
        throw GoldenConformanceError.catalog
      }
      return line
    }
  }

  private static func validateRoot(_ root: URL) throws -> ValidatedRoot {
    do {
      let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw GoldenConformanceError.catalog
      }
      let canonical = root.resolvingSymlinksInPath().standardizedFileURL
      let descriptor = Darwin.open(
        canonical.path,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      )
      guard descriptor >= 0 else { throw GoldenConformanceError.catalog }
      defer { Darwin.close(descriptor) }
      return ValidatedRoot(
        url: canonical,
        identity: try identity(fd: descriptor, kind: .directory)
      )
    } catch {
      throw GoldenConformanceError.catalog
    }
  }

  private static func snapshot(
    root: URL,
    expectedRootIdentity: FileIdentity? = nil
  ) throws -> CatalogSnapshot {
    let rootFD = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard rootFD >= 0 else { throw GoldenConformanceError.catalog }
    defer { Darwin.close(rootFD) }
    do {
      let rootBefore = try identity(fd: rootFD, kind: .directory)
      if let expectedRootIdentity, rootBefore != expectedRootIdentity {
        throw GoldenConformanceError.catalog
      }
      let rootNames = try directoryNames(fd: rootFD)
      guard Set(rootNames) == Set(["manifest.json", "valid", "invalid"]) else {
        throw GoldenConformanceError.catalog
      }
      let manifest = try readFile(at: rootFD, name: "manifest.json")
      var totalBytes = manifest.data.count
      guard totalBytes <= maximumCatalogBytes else {
        throw GoldenConformanceError.catalog
      }
      var files: [String: Data] = [:]
      var identities: [String: FileIdentity] = [
        ".": rootBefore,
        "manifest.json": manifest.identity,
      ]
      for category in ["valid", "invalid"] {
        let directoryFD = Darwin.openat(
          rootFD,
          category,
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard directoryFD >= 0 else { throw GoldenConformanceError.catalog }
        defer { Darwin.close(directoryFD) }
        let directoryIdentity = try identity(fd: directoryFD, kind: .directory)
        identities[category] = directoryIdentity
        for name in try directoryNames(fd: directoryFD) {
          guard name != ".", name != "..", !name.contains("/") else {
            throw GoldenConformanceError.catalog
          }
          let relative = "\(category)/\(name)"
          guard files[relative] == nil else { throw GoldenConformanceError.catalog }
          let read = try readFile(at: directoryFD, name: name)
          guard read.data.count <= maximumCatalogBytes - totalBytes else {
            throw GoldenConformanceError.catalog
          }
          totalBytes += read.data.count
          files[relative] = read.data
          identities[relative] = read.identity
        }
        guard try identity(fd: directoryFD, kind: .directory) == directoryIdentity else {
          throw GoldenConformanceError.catalog
        }
      }
      guard try identity(fd: rootFD, kind: .directory) == rootBefore else {
        throw GoldenConformanceError.catalog
      }
      return CatalogSnapshot(
        manifestData: manifest.data,
        files: files,
        identities: identities
      )
    } catch let error as GoldenConformanceError {
      throw error
    } catch {
      throw GoldenConformanceError.catalog
    }
  }

  private enum FileKind { case regular, directory }

  private static func identity(fd: Int32, kind: FileKind) throws -> FileIdentity {
    var metadata = stat()
    guard Darwin.fstat(fd, &metadata) == 0 else { throw GoldenConformanceError.catalog }
    let format = metadata.st_mode & S_IFMT
    guard (kind == .regular && format == S_IFREG) ||
      (kind == .directory && format == S_IFDIR)
    else {
      throw GoldenConformanceError.catalog
    }
    if kind == .regular && metadata.st_nlink != 1 {
      throw GoldenConformanceError.catalog
    }
    return FileIdentity(
      device: UInt64(metadata.st_dev),
      inode: UInt64(metadata.st_ino),
      size: Int64(metadata.st_size),
      mode: UInt16(metadata.st_mode),
      links: UInt16(metadata.st_nlink),
      modifiedSeconds: metadata.st_mtimespec.tv_sec,
      modifiedNanoseconds: metadata.st_mtimespec.tv_nsec,
      changedSeconds: metadata.st_ctimespec.tv_sec,
      changedNanoseconds: metadata.st_ctimespec.tv_nsec
    )
  }

  private static func readFile(at directoryFD: Int32, name: String) throws -> (data: Data, identity: FileIdentity) {
    let fd = Darwin.openat(directoryFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw GoldenConformanceError.catalog }
    defer { Darwin.close(fd) }
    let before = try identity(fd: fd, kind: .regular)
    guard before.size >= 0,
      before.size <= Int64(maximumCatalogFileBytes)
    else {
      throw GoldenConformanceError.catalog
    }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    let data = try handle.read(upToCount: maximumCatalogFileBytes + 1) ?? Data()
    let after = try identity(fd: fd, kind: .regular)
    guard data.count <= maximumCatalogFileBytes,
      before == after,
      Int64(data.count) == before.size
    else {
      throw GoldenConformanceError.catalog
    }
    return (data, before)
  }

  private static func directoryNames(fd: Int32) throws -> [String] {
    let duplicate = Darwin.dup(fd)
    guard duplicate >= 0, let directory = Darwin.fdopendir(duplicate) else {
      if duplicate >= 0 { Darwin.close(duplicate) }
      throw GoldenConformanceError.catalog
    }
    defer { Darwin.closedir(directory) }
    var names: [String] = []
    while true {
      errno = 0
      guard let entry = Darwin.readdir(directory) else {
        guard errno == 0 else { throw GoldenConformanceError.catalog }
        break
      }
      let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(cString: $0)
        }
      }
      if name != "." && name != ".." {
        guard names.count < maximumCatalogDirectoryEntries else {
          throw GoldenConformanceError.catalog
        }
        names.append(name)
      }
    }
    return names
  }

  private static func validate(entries: [ManifestEntry], files: [String: Data]) throws {
    guard Set(entries.map(\.id)).count == entries.count,
      Set(entries.map(\.file)).count == entries.count
    else {
      throw GoldenConformanceError.manifest
    }
    for entry in entries {
      let components = entry.file.split(separator: "/", omittingEmptySubsequences: false)
      guard components.count == 2,
        components[0] == "valid" || components[0] == "invalid",
        !entry.file.contains("\\"),
        !components.contains("."),
        !components.contains(".."),
        files[entry.file] != nil,
        supports(schema: entry.schema)
      else {
        throw GoldenConformanceError.manifest
      }
    }
    guard Set(entries.map(\.file)) == Set(files.keys) else {
      throw GoldenConformanceError.catalog
    }
  }

  private static func run(entry: ManifestEntry, data: Data) -> GoldenFixtureResult {
    do {
      let decoded = try decode(schema: entry.schema, data: data, id: entry.id)
      return GoldenFixtureResult(
        id: entry.id,
        expect: entry.expect,
        accepted: true,
        expectedOutcome: entry.expectedOutcome,
        outcome: decoded.outcome,
        presence: decoded.presence,
        preservedCursors: decoded.cursors,
        preservedRawEvent: decoded.rawEvent != nil
      )
    } catch GoldenConformanceError.criticalUnknownEvent {
      return GoldenFixtureResult(
        id: entry.id,
        expect: entry.expect,
        accepted: true,
        expectedOutcome: entry.expectedOutcome,
        outcome: .resetRequired,
        presence: nil,
        preservedCursors: [],
        preservedRawEvent: false
      )
    } catch GoldenConformanceError.protocolError {
      return GoldenFixtureResult(
        id: entry.id,
        expect: entry.expect,
        accepted: false,
        expectedOutcome: entry.expectedOutcome,
        outcome: .protocolError,
        presence: nil,
        preservedCursors: [],
        preservedRawEvent: false
      )
    } catch {
      return GoldenFixtureResult(
        id: entry.id,
        expect: entry.expect,
        accepted: false,
        expectedOutcome: entry.expectedOutcome,
        outcome: nil,
        presence: nil,
        preservedCursors: [],
        preservedRawEvent: false
      )
    }
  }

  private static func decodeEvent(_ data: Data) throws -> DecodedFixture {
    let frame: ThreadStreamFrame
    do {
      frame = try JSONDecoder().decode(ThreadStreamFrame.self, from: data)
    } catch {
      throw GoldenConformanceError.protocolError
    }
    let raw = try JSONDecoder().decode(JSONValue.self, from: data)
    switch frame {
    case .unknownEvent(let value):
      if value.critical { throw GoldenConformanceError.criticalUnknownEvent }
      return DecodedFixture(
        outcome: .unknownNonCritical,
        cursors: [value.durableSequence],
        rawEvent: raw
      )
    case .unknownEvent21(let value):
      if value.critical { throw GoldenConformanceError.criticalUnknownEvent }
      return DecodedFixture(
        outcome: .unknownNonCritical,
        cursors: [value.streamSequence, value.durableBasis],
        rawEvent: raw
      )
    default:
      return DecodedFixture(outcome: .known)
    }
  }

  private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws {
    _ = try JSONDecoder().decode(type, from: data)
  }

  private static func decode(schema: String, data: Data, id: String) throws -> DecodedFixture {
    if schema == "schema:ThreadStreamFrame" { return try decodeEvent(data) }
    if schema == "schema:KnownDurableEventEnvelope" || schema == "schema:KnownTransientEventEnvelope" {
      try decodeMapped(schema: schema, data: data)
      return DecodedFixture(outcome: .known)
    }
    if schema == "schema:UnknownEventEnvelope" {
      let value = try JSONDecoder().decode(UnknownEventEnvelope.self, from: data)
      let critical: Bool
      switch value {
      case .durable(let event): critical = event.critical
      case .transient(let event): critical = event.critical
      }
      if critical { throw GoldenConformanceError.criticalUnknownEvent }
      return DecodedFixture(
        outcome: .unknownNonCritical,
        cursors: preservedCursors(data),
        rawEvent: try JSONDecoder().decode(JSONValue.self, from: data)
      )
    }
    if schema == "schema:SnapshotReset" {
      try decodeMapped(schema: schema, data: data)
      return DecodedFixture(outcome: .known)
    }
    if schema == "schema:ConfigPatch" {
      let value = try JSONDecoder().decode(ConfigPatch.self, from: data)
      let presence: FixturePresence?
      if id == "optional-nullable.absent" || id == "optional-nullable.null" || id == "optional-nullable.value" {
        switch value.providerCredentialRef {
        case .absent: presence = .absent
        case .null: presence = .null
        case .value: presence = .value
        }
      } else {
        presence = nil
      }
      return DecodedFixture(presence: presence)
    }
    try decodeMapped(schema: schema, data: data)
    return DecodedFixture()
  }

  private static func preservedCursors(_ data: Data) -> [String] {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
    return ["durableSequence", "streamSequence", "durableBasis"].compactMap { object[$0] as? String }
  }

  private static func supports(schema: String) -> Bool {
    supportedSchemas.contains(schema)
  }

  private static let supportedSchemas: Set<String> = [
    "schema:ApiError", "schema:ApprovalDecision", "schema:ApprovalKind",
    "schema:ApprovalStatus", "schema:AssistantStreamBuffer",
    "schema:AssistantTranscriptPayload", "schema:AuthenticatedPrincipalKind",
    "schema:CommandAck", "schema:ConfigPatch", "schema:CredentialRef", "schema:DurableCursor",
    "schema:EffectiveQueueDispatchState", "schema:ErrorCode", "schema:ForkBoundary",
    "schema:HealthResponse", "schema:InputContent", "schema:InputRole",
    "schema:InputSource", "schema:JsonValue", "schema:KnownDurableEventEnvelope",
    "schema:KnownDurableEventPayload", "schema:KnownTransientEventEnvelope",
    "schema:KnownTransientEventPayload", "schema:NetworkPolicy",
    "schema:OperationCompletionEventKind", "schema:OperationKind",
    "schema:OperationStatus", "schema:OperationTerminalEventPayload",
    "schema:PaginationQuery", "schema:ParseThreadStreamFrameResult",
    "schema:QueueControlState", "schema:QueueItemStatus", "schema:ReasoningEffort",
    "schema:RunKind", "schema:RunStatus", "schema:SandboxPolicy",
    "schema:SnapshotReset", "schema:SnapshotResetReason", "schema:SteerStalePolicy",
    "schema:StreamInterruptionReason", "schema:StreamStateStatus",
    "schema:SubmissionDisposition", "schema:SubmissionResult",
    "schema:ThreadLifecycle", "schema:ThreadRuntimeStatus",
    "schema:ThreadStreamFrame", "schema:ThreadView", "schema:ToolExecutionState",
    "schema:ToolStreamBuffer", "schema:TranscriptItemKind",
    "schema:TranscriptItemView", "schema:TranscriptStatus",
    "schema:UnknownEventEnvelope", "schema:WorkspaceTrust",
  ]

  private static func decodeMapped(schema: String, data: Data) throws {
    switch schema {
    case "schema:ApiError": try decode(ApiError.self, data)
    case "schema:ApprovalDecision": try decode(ApprovalDecision.self, data)
    case "schema:ApprovalKind": try decode(ApprovalKind.self, data)
    case "schema:ApprovalStatus": try decode(ApprovalStatus.self, data)
    case "schema:AssistantStreamBuffer": try decode(AssistantStreamBuffer.self, data)
    case "schema:AssistantTranscriptPayload": try decode(AssistantTranscriptPayload.self, data)
    case "schema:AuthenticatedPrincipalKind": try decode(AuthenticatedPrincipalKind.self, data)
    case "schema:CommandAck": try decode(CommandAck.self, data)
    case "schema:ConfigPatch": try decode(ConfigPatch.self, data)
    case "schema:CredentialRef": try decode(CredentialRef.self, data)
    case "schema:DurableCursor": try decode(DurableCursor.self, data)
    case "schema:EffectiveQueueDispatchState": try decode(EffectiveQueueDispatchState.self, data)
    case "schema:ErrorCode": try decode(ErrorCode.self, data)
    case "schema:ForkBoundary": try decode(ForkBoundary.self, data)
    case "schema:HealthResponse": try decode(HealthResponse.self, data)
    case "schema:InputContent": try decode(InputContent.self, data)
    case "schema:InputRole": try decode(InputRole.self, data)
    case "schema:InputSource": try decode(InputSource.self, data)
    case "schema:JsonValue": try decode(JSONValue.self, data)
    case "schema:KnownDurableEventEnvelope": try decode(KnownDurableEventEnvelope.self, data)
    case "schema:KnownDurableEventPayload": try decode(KnownDurableEventPayload.self, data)
    case "schema:KnownTransientEventEnvelope": try decode(KnownTransientEventEnvelope.self, data)
    case "schema:KnownTransientEventPayload": try decode(KnownTransientEventPayload.self, data)
    case "schema:NetworkPolicy": try decode(NetworkPolicy.self, data)
    case "schema:OperationCompletionEventKind": try decode(OperationCompletionEventKind.self, data)
    case "schema:OperationKind": try decode(OperationKind.self, data)
    case "schema:OperationStatus": try decode(OperationStatus.self, data)
    case "schema:OperationTerminalEventPayload": try decode(OperationTerminalEventPayload.self, data)
    case "schema:PaginationQuery": try decode(PaginationQuery.self, data)
    case "schema:ParseThreadStreamFrameResult": try decode(ParseThreadStreamFrameResult.self, data)
    case "schema:QueueControlState": try decode(QueueControlState.self, data)
    case "schema:QueueItemStatus": try decode(QueueItemStatus.self, data)
    case "schema:ReasoningEffort": try decode(ReasoningEffort.self, data)
    case "schema:RunKind": try decode(RunKind.self, data)
    case "schema:RunStatus": try decode(RunStatus.self, data)
    case "schema:SandboxPolicy": try decode(SandboxPolicy.self, data)
    case "schema:SnapshotReset": try decode(SnapshotReset.self, data)
    case "schema:SnapshotResetReason": try decode(SnapshotResetReason.self, data)
    case "schema:SteerStalePolicy": try decode(SteerStalePolicy.self, data)
    case "schema:StreamInterruptionReason": try decode(StreamInterruptionReason.self, data)
    case "schema:StreamStateStatus": try decode(StreamStateStatus.self, data)
    case "schema:SubmissionDisposition": try decode(SubmissionDisposition.self, data)
    case "schema:SubmissionResult": try decode(SubmissionResult.self, data)
    case "schema:ThreadLifecycle": try decode(ThreadLifecycle.self, data)
    case "schema:ThreadRuntimeStatus": try decode(ThreadRuntimeStatus.self, data)
    case "schema:ThreadStreamFrame": try decode(ThreadStreamFrame.self, data)
    case "schema:ThreadView": try decode(ThreadView.self, data)
    case "schema:ToolExecutionState": try decode(ToolExecutionState.self, data)
    case "schema:ToolStreamBuffer": try decode(ToolStreamBuffer.self, data)
    case "schema:TranscriptItemKind": try decode(TranscriptItemKind.self, data)
    case "schema:TranscriptItemView": try decode(TranscriptItemView.self, data)
    case "schema:TranscriptStatus": try decode(TranscriptStatus.self, data)
    case "schema:UnknownEventEnvelope": try decode(UnknownEventEnvelope.self, data)
    case "schema:WorkspaceTrust": try decode(WorkspaceTrust.self, data)
    default: throw GoldenConformanceError.unknownSchemaTarget
    }
  }
}
