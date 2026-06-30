import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolRegistry,
  ToolRunner,
  createRuntimeContext,
  WebBrowserTool,
  WebFetchTool,
  WebSearchTool,
  type ApprovalRequest,
  type ApprovalResponse,
} from "../index.js";

function networkRunner(context = createRuntimeContext()) {
  return new ToolRunner(
    new ToolRegistry([WebFetchTool, WebSearchTool, WebBrowserTool]),
    context,
  );
}

test("WebFetch reports an error when no provider is configured", async () => {
  const result = await networkRunner().run({
    id: "fetch-missing",
    name: "WebFetch",
    input: { url: "https://example.com" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /WebFetch provider not configured/);
});

test("WebSearch reports an error when no provider is configured", async () => {
  const result = await networkRunner().run({
    id: "search-missing",
    name: "WebSearch",
    input: { query: "runtime tools" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /WebSearch provider not configured/);
});

test("WebBrowser reports an error when no provider is configured", async () => {
  const result = await networkRunner().run({
    id: "browser-missing",
    name: "WebBrowser",
    input: { url: "https://example.com" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /WebBrowser provider not configured/);
});

test("network tools return provider output when providers are configured", async () => {
  const context = createRuntimeContext({
    webFetchProvider: async (url) => "fetched:" + url,
    webSearchProvider: async (query) => ["result:" + query],
    webBrowserProvider: async (url) => "browser:" + url,
  });
  const runner = networkRunner(context);

  const fetched = await runner.run({
    id: "fetch-ok",
    name: "WebFetch",
    input: { url: "https://example.com/page" },
  });
  const searched = await runner.run({
    id: "search-ok",
    name: "WebSearch",
    input: { query: "runtime" },
  });
  const browsed = await runner.run({
    id: "browser-ok",
    name: "WebBrowser",
    input: { url: "https://example.com/browser" },
  });

  assert.equal(fetched.isError, undefined);
  assert.equal(fetched.content, "fetched:https://example.com/page");
  assert.equal(searched.isError, undefined);
  assert.equal(searched.content, "result:runtime");
  assert.equal(browsed.isError, undefined);
  assert.equal(browsed.content, "browser:https://example.com/browser");
});

test("WebFetch asks before using network when allowNetwork is not explicit in default mode", async () => {
  let called = false;
  const context = createRuntimeContext({
    permissionContext: { mode: "default", workspaceRoots: [], rules: [] },
    webFetchProvider: async () => {
      called = true;
      return "unreachable";
    },
  });

  const result = await networkRunner(context).run({
    id: "fetch-permission",
    name: "WebFetch",
    input: { url: "https://example.com" },
  });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /requires network access/);
  assert.match(result.content, /no approval handler/i);
});

test("WebFetch proceeds after approval when allowNetwork is not explicit in default mode", async () => {
  const requests: ApprovalRequest[] = [];
  const requestApproval = async (
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> => {
    requests.push(request);
    return { behavior: "allow" };
  };
  const context = createRuntimeContext({
    permissionContext: { mode: "default", workspaceRoots: [], rules: [] },
    requestApproval,
    webFetchProvider: async (url) => "allowed:" + url,
  });

  const result = await networkRunner(context).run({
    id: "fetch-approval",
    name: "WebFetch",
    input: { url: "https://example.com" },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content, "allowed:https://example.com");
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.message ?? "", /requires network access/);
});

test("WebFetch proceeds without approval when allowNetwork is true", async () => {
  let called = false;
  const context = createRuntimeContext({
    permissionContext: {
      mode: "default",
      workspaceRoots: [],
      rules: [],
      allowNetwork: true,
    },
    webFetchProvider: async (url) => {
      called = true;
      return "allowed:" + url;
    },
  });

  const result = await networkRunner(context).run({
    id: "fetch-allow-network",
    name: "WebFetch",
    input: { url: "https://example.com" },
  });

  assert.equal(called, true);
  assert.equal(result.isError, undefined);
  assert.equal(result.content, "allowed:https://example.com");
});
