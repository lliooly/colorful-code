import test from "node:test";
import assert from "node:assert/strict";
import {
  createBuiltinTools,
  createToolFromMcpMetadata,
  describeTool,
  describeTools,
  type McpManager,
  type McpToolMetadata,
} from "../index.js";

const stubManager: McpManager = {
  async connectAll() {
    return [];
  },
  async callTool(server, tool, args) {
    return server + "/" + tool + ":" + String(args.query);
  },
  async listResources() {
    return [];
  },
  async readResource(server, uri) {
    return { contents: [{ server, uri, text: "" }] };
  },
};

test("every built-in tool produces a descriptor with an object input schema", () => {
  const descriptors = describeTools(createBuiltinTools());
  assert.ok(descriptors.length > 0);
  for (const descriptor of descriptors) {
    assert.equal(
      descriptor.inputSchema.type,
      "object",
      "tool " + descriptor.name + " must describe an object input schema",
    );
    assert.equal(descriptor.source, "builtin");
    assert.equal(descriptor.enabled, true);
  }
});

test("a tool with mixed required and optional fields computes required correctly", () => {
  const edit = createBuiltinTools().find((tool) => tool.name === "Edit");
  assert.ok(edit, "Edit tool should exist");
  const descriptor = describeTool(edit);

  assert.deepEqual(descriptor.inputSchema.required, [
    "path",
    "oldText",
    "newText",
  ]);
  assert.equal(descriptor.inputSchema.additionalProperties, false);
  assert.ok(descriptor.inputSchema.properties);
  assert.equal(descriptor.inputSchema.properties?.replaceAll?.type, "boolean");
  assert.equal(descriptor.destructive, true);
});

test("an MCP tool surfaces its real input schema instead of a passthrough", () => {
  const metadata: McpToolMetadata = {
    server: "docs server",
    name: "search docs",
    description: "Search project docs",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { title: "Search Docs", readOnlyHint: true },
  };

  const tool = createToolFromMcpMetadata(metadata, stubManager);
  const descriptor = describeTool(tool);

  assert.equal(descriptor.source, "mcp");
  assert.equal(descriptor.description, "Search project docs");
  assert.equal(descriptor.searchHint, "Search Docs");
  assert.equal(descriptor.readOnly, true);
  assert.equal(descriptor.inputSchema.type, "object");
  assert.deepEqual(descriptor.inputSchema.required, ["query"]);
  assert.equal(descriptor.inputSchema.properties?.query?.type, "string");
  // Not the passthrough fallback ({ additionalProperties: true } with no properties).
  assert.notEqual(descriptor.inputSchema.additionalProperties, true);
});

test("an MCP tool without a usable input schema falls back to the passthrough descriptor", () => {
  const metadata: McpToolMetadata = {
    server: "docs server",
    name: "noschema",
  };

  const descriptor = describeTool(createToolFromMcpMetadata(metadata, stubManager));

  assert.equal(descriptor.source, "mcp");
  assert.equal(descriptor.inputSchema.type, "object");
  assert.equal(descriptor.inputSchema.additionalProperties, true);
});
