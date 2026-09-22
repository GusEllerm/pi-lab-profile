// A tiny MCP server for the bridge tests: one tool that echoes, one that errors, one resource that
// is a skill without frontmatter. Real stdio, so the test exercises the same path as a real server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.1" });
server.tool("echo", "Echo the text back, optionally shouting", { text: z.string(), shout: z.boolean().optional() }, async ({ text, shout }) => ({
	content: [{ type: "text", text: shout ? text.toUpperCase() : text }],
}));
server.tool("fail", "Always fails", {}, async () => ({ content: [{ type: "text", text: "as requested" }], isError: true }));
server.resource("guidance", "fixture://guidance", { mimeType: "text/markdown" }, async (uri) => ({
	contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# How to use the fixture\n\nCall echo." }],
}));
await server.connect(new StdioServerTransport());
