import Darwin
import Foundation
import GoldenFixtureSupport

private enum CommandFailure: Error {
  case invalid
}

private struct Options {
  let fixtureRoot: String
  let outputName: String
  let outputRoot: String

  init(arguments: [String]) throws {
    guard arguments.count == 6 else { throw CommandFailure.invalid }
    var values: [String: String] = [:]
    var index = 0
    while index < arguments.count {
      let flag = arguments[index]
      let value = arguments[index + 1]
      guard ["--fixture-root", "--output-name", "--output-root"].contains(flag),
        values[flag] == nil,
        !value.isEmpty
      else {
        throw CommandFailure.invalid
      }
      values[flag] = value
      index += 2
    }
    guard let fixtureRoot = values["--fixture-root"],
      let outputName = values["--output-name"],
      let outputRoot = values["--output-root"]
    else {
      throw CommandFailure.invalid
    }
    self.fixtureRoot = fixtureRoot
    self.outputName = outputName
    self.outputRoot = outputRoot
  }
}

private struct FileIdentity {
  let device: dev_t
  let inode: ino_t
}

private struct OutputRoot {
  let descriptor: Int32
  let identity: FileIdentity
  let mode: mode_t
  let owner: uid_t
  let path: String
}

private func fileIdentity(_ metadata: stat) -> FileIdentity {
  FileIdentity(device: metadata.st_dev, inode: metadata.st_ino)
}

private func sameFile(_ left: FileIdentity, _ right: FileIdentity) -> Bool {
  left.device == right.device && left.inode == right.inode
}

private func openOutputRoot(path: String) throws -> OutputRoot {
  var pathMetadata = stat()
  guard Darwin.lstat(path, &pathMetadata) == 0,
    pathMetadata.st_mode & S_IFMT == S_IFDIR
  else {
    throw CommandFailure.invalid
  }
  let canonicalPath = URL(fileURLWithPath: path, isDirectory: true)
    .resolvingSymlinksInPath().standardizedFileURL.path
  let descriptor = Darwin.open(
    canonicalPath,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  )
  guard descriptor >= 0 else { throw CommandFailure.invalid }
  do {
    var metadata = stat()
    var canonicalMetadata = stat()
    guard Darwin.fstat(descriptor, &metadata) == 0,
      Darwin.lstat(canonicalPath, &canonicalMetadata) == 0,
      metadata.st_mode & S_IFMT == S_IFDIR,
      canonicalMetadata.st_mode & S_IFMT == S_IFDIR,
      metadata.st_uid == Darwin.geteuid(),
      metadata.st_mode & 0o077 == 0,
      sameFile(fileIdentity(pathMetadata), fileIdentity(metadata)),
      sameFile(fileIdentity(metadata), fileIdentity(canonicalMetadata))
    else {
      throw CommandFailure.invalid
    }
    return OutputRoot(
      descriptor: descriptor,
      identity: fileIdentity(metadata),
      mode: metadata.st_mode,
      owner: metadata.st_uid,
      path: canonicalPath
    )
  } catch {
    Darwin.close(descriptor)
    throw error
  }
}

private func assertOutputRootCurrent(_ root: OutputRoot) throws {
  var descriptorMetadata = stat()
  var pathMetadata = stat()
  guard Darwin.fstat(root.descriptor, &descriptorMetadata) == 0,
    Darwin.lstat(root.path, &pathMetadata) == 0,
    descriptorMetadata.st_mode & S_IFMT == S_IFDIR,
    pathMetadata.st_mode & S_IFMT == S_IFDIR,
    sameFile(root.identity, fileIdentity(descriptorMetadata)),
    sameFile(root.identity, fileIdentity(pathMetadata)),
    descriptorMetadata.st_mode == root.mode,
    pathMetadata.st_mode == root.mode,
    descriptorMetadata.st_uid == root.owner,
    pathMetadata.st_uid == root.owner,
    URL(fileURLWithPath: root.path, isDirectory: true)
      .resolvingSymlinksInPath().standardizedFileURL.path == root.path
  else {
    throw CommandFailure.invalid
  }
}

private func validOutputName(_ name: String) -> Bool {
  !name.isEmpty && name != "." && name != ".." &&
    !name.contains("/") && !name.contains("\\") && !name.utf8.contains(0)
}

private func writeAll(_ data: Data, to descriptor: Int32) throws {
  try data.withUnsafeBytes { bytes in
    guard let base = bytes.baseAddress else { throw CommandFailure.invalid }
    var offset = 0
    while offset < bytes.count {
      let count = Darwin.write(
        descriptor,
        base.advanced(by: offset),
        bytes.count - offset
      )
      if count < 0 && errno == EINTR { continue }
      guard count > 0 else { throw CommandFailure.invalid }
      offset += count
    }
  }
}

private func writeOutput(
  lines: [String],
  outputRoot: String,
  outputName: String
) throws {
  guard validOutputName(outputName), !lines.isEmpty else {
    throw CommandFailure.invalid
  }
  let root = try openOutputRoot(path: outputRoot)
  defer { Darwin.close(root.descriptor) }
  try assertOutputRootCurrent(root)
  var rootBefore = stat()
  guard Darwin.fstat(root.descriptor, &rootBefore) == 0 else {
    throw CommandFailure.invalid
  }

  let descriptor = Darwin.openat(
    root.descriptor,
    outputName,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    mode_t(0o600)
  )
  guard descriptor >= 0 else { throw CommandFailure.invalid }
  var succeeded = false
  defer {
    if !succeeded {
      _ = Darwin.ftruncate(descriptor, 0)
      _ = Darwin.fsync(descriptor)
    }
    Darwin.close(descriptor)
  }

  var before = stat()
  guard Darwin.fstat(descriptor, &before) == 0,
    before.st_mode & S_IFMT == S_IFREG,
    before.st_nlink == 1,
    before.st_uid == Darwin.geteuid(),
    Darwin.fchmod(descriptor, mode_t(0o600)) == 0
  else {
    throw CommandFailure.invalid
  }
  var secured = stat()
  guard Darwin.fstat(descriptor, &secured) == 0,
    sameFile(fileIdentity(before), fileIdentity(secured)),
    secured.st_mode & 0o777 == 0o600,
    secured.st_uid == Darwin.geteuid()
  else {
    throw CommandFailure.invalid
  }
  try assertOutputRootCurrent(root)
  let data = Data("\(lines.joined(separator: "\n"))\n".utf8)
  try writeAll(data, to: descriptor)
  guard Darwin.fsync(descriptor) == 0 else { throw CommandFailure.invalid }

  var after = stat()
  var rootAfter = stat()
  var pathAfter = stat()
  let pathInspected = outputName.withCString { pointer in
    Darwin.fstatat(root.descriptor, pointer, &pathAfter, AT_SYMLINK_NOFOLLOW)
  }
  guard Darwin.fstat(descriptor, &after) == 0,
    Darwin.fstat(root.descriptor, &rootAfter) == 0,
    pathInspected == 0,
    after.st_mode & S_IFMT == S_IFREG,
    pathAfter.st_mode & S_IFMT == S_IFREG,
    after.st_mode & 0o777 == 0o600,
    pathAfter.st_mode & 0o777 == 0o600,
    after.st_uid == Darwin.geteuid(),
    pathAfter.st_uid == Darwin.geteuid(),
    after.st_nlink == 1,
    pathAfter.st_nlink == 1,
    sameFile(fileIdentity(before), fileIdentity(after)),
    sameFile(fileIdentity(after), fileIdentity(pathAfter)),
    after.st_size == data.count,
    pathAfter.st_size == data.count,
    sameFile(fileIdentity(rootBefore), fileIdentity(rootAfter))
  else {
    throw CommandFailure.invalid
  }
  try assertOutputRootCurrent(root)
  succeeded = true
}

do {
  let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
  let fixtureRoot = URL(fileURLWithPath: options.fixtureRoot, isDirectory: true)
  let lines = try GoldenFixtureRunner.jsonLines(root: fixtureRoot)
  try writeOutput(
    lines: lines,
    outputRoot: options.outputRoot,
    outputName: options.outputName
  )
} catch {
  FileHandle.standardError.write(Data("swift conformance failed\n".utf8))
  exit(EXIT_FAILURE)
}
