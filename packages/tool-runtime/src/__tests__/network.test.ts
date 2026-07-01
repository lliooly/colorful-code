import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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

async function withHttpServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fn("http://127.0.0.1:" + String(address.port));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("WebFetch uses the default HTTP provider when no provider is configured", async () => {
  await withHttpServer(
    (_req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hello from http");
    },
    async (origin) => {
      const result = await networkRunner().run({
        id: "fetch-default",
        name: "WebFetch",
        input: { url: origin + "/page" },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.content, "hello from http");
    },
  );
});

test("WebFetch reports HTTP failures from the default provider", async () => {
  await withHttpServer(
    (_req, res) => {
      res.statusCode = 503;
      res.end("unavailable");
    },
    async (origin) => {
      const result = await networkRunner().run({
        id: "fetch-failure",
        name: "WebFetch",
        input: { url: origin + "/down" },
      });

      assert.equal(result.isError, true);
      assert.match(result.content, /WebFetch failed with HTTP 503/);
    },
  );
});

test("WebSearch uses a configured HTTP JSON search endpoint", async () => {
  await withHttpServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          path: req.url,
          results: [
            { title: "First", url: "https://example.test/first", snippet: "One" },
            { title: "Second", link: "https://example.test/second" },
          ],
        }),
      );
    },
    async (origin) => {
      const context = createRuntimeContext({
        webSearchEndpoint: origin + "/search?q={query}",
      });
      const result = await networkRunner(context).run({
        id: "search-default",
        name: "WebSearch",
        input: { query: "runtime tools" },
      });

      assert.equal(result.isError, undefined);
      assert.match(result.content, /First/);
      assert.match(result.content, /https:\/\/example\.test\/first/);
      assert.match(result.content, /Second/);
    },
  );
});

test("WebSearch uses the default HTTP HTML search provider", async () => {
  await withHttpServer(
    (_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`
        <html>
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.test%2Freal&amp;rut=1">
            <b>Runtime</b> Tools
          </a>
        </html>
      `);
    },
    async (origin) => {
      const context = createRuntimeContext({
        webSearchEndpoint: origin + "/html?q={query}",
      });
      const result = await networkRunner(context).run({
        id: "search-html",
        name: "WebSearch",
        input: { query: "runtime tools" },
      });

      assert.equal(result.isError, undefined);
      assert.match(result.content, /Runtime Tools/);
      assert.match(result.content, /https:\/\/example\.test\/real/);
    },
  );
});

test("WebFetch can still report an error when the default provider is disabled", async () => {
  const result = await networkRunner(
    createRuntimeContext({ disableDefaultWebProviders: true }),
  ).run({
    id: "fetch-missing",
    name: "WebFetch",
    input: { url: "https://example.com" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /WebFetch provider not configured/);
});

test("WebSearch can still report an error when the default provider is disabled", async () => {
  const result = await networkRunner(
    createRuntimeContext({ disableDefaultWebProviders: true }),
  ).run({
    id: "search-missing",
    name: "WebSearch",
    input: { query: "runtime tools" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /WebSearch provider not configured/);
});

test("WebBrowser reports an error when no provider is configured", async () => {
  const result = await networkRunner(
    createRuntimeContext({ disableDefaultWebProviders: true }),
  ).run({
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
