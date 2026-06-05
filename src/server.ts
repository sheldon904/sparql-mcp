/**
 * SPARQL MCP server.
 *
 * Exposes a SPARQL 1.1 endpoint as an MCP server so an agent can run
 * read-only SPARQL queries against a knowledge graph alongside its other
 * tools.
 *
 * Transport: SSE over HTTP on port 4002.
 *
 * Tools exposed:
 *   • sparql_query          — run a SELECT / ASK query, return JSON bindings
 *   • sparql_ask            — convenience: run ASK and return just the boolean
 *   • list_graphs           — enumerate named graphs in the store
 *   • describe_entity       — fetch all triples about a given IRI
 *
 * Safety:
 *   • Localhost-only bind (127.0.0.1) by default.
 *   • Endpoint URL host-guarded against common cloud hosts to prevent
 *     accidentally pointing at a production store.
 *   • Read-only: no SPARQL UPDATE / DROP paths exposed through MCP.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Request, Response } from 'express';
import express from 'express';
import { z } from 'zod';

const SPARQL_URL = (process.env.SPARQL_ENDPOINT ?? 'http://127.0.0.1:7878').replace(/\/+$/, '');
const PORT = Number(process.env.MCP_PORT ?? 4002);
const HOST = process.env.MCP_HOST ?? '127.0.0.1';

const FORBIDDEN_HOSTS = ['.amazonaws.com', '.azurewebsites.net', '.googleusercontent.com'];
function assertLocal(url: string): void {
  const lower = url.toLowerCase();
  for (const h of FORBIDDEN_HOSTS) {
    if (lower.includes(h)) {
      throw new Error(`[sparql-mcp] refusing cloud endpoint (${h})`);
    }
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+\.localhost)/i.test(url)) {
    throw new Error(`[sparql-mcp] SPARQL endpoint URL must be localhost-ish: ${url}`);
  }
}
assertLocal(SPARQL_URL);

interface SparqlBinding {
  [variable: string]: { type: string; value: string; datatype?: string };
}
interface SparqlSelectResult {
  head: { vars: string[] };
  results: { bindings: SparqlBinding[] };
}

async function sparqlSelect(query: string): Promise<SparqlSelectResult> {
  const res = await fetch(`${SPARQL_URL}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: query,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SPARQL SELECT ${res.status}: ${body.slice(0, 400)}`);
  }
  return (await res.json()) as SparqlSelectResult;
}

async function sparqlAsk(query: string): Promise<boolean> {
  const res = await fetch(`${SPARQL_URL}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: query,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SPARQL ASK ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as { boolean?: boolean };
  return !!json.boolean;
}

/**
 * Reject queries that contain UPDATE keywords. MCP callers get SELECT/ASK/
 * DESCRIBE/CONSTRUCT only.
 */
function assertReadOnly(query: string): void {
  const upper = query.toUpperCase();
  const forbidden = [
    /\bINSERT\b/,
    /\bDELETE\b/,
    /\bDROP\b/,
    /\bCLEAR\b/,
    /\bCREATE\s+(GRAPH|SILENT)/,
    /\bLOAD\s+(SILENT\s+)?</,
  ];
  for (const rx of forbidden) {
    if (rx.test(upper)) {
      throw new Error(
        `[sparql-mcp] write query rejected — this MCP endpoint is read-only.`,
      );
    }
  }
}

/**
 * Reject IRIs containing characters that are illegal in an IRI (RFC 3987) and
 * could otherwise break out of the `<...>` term interpolated into the
 * describe_entity query. Well-formed IRIs never contain these, so this rejects
 * only malformed input.
 */
function assertValidIri(iri: string): void {
  if (/[\s<>"{}|\\^`]/.test(iri)) {
    throw new Error(`[sparql-mcp] invalid IRI (illegal characters): ${iri}`);
  }
}

// --------- MCP tools ---------

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'sparql-mcp',
    version: '0.1.0',
  });

  server.tool(
    'sparql_query',
    'Run a SPARQL 1.1 SELECT or ASK query against the configured triple store. ' +
      'Read-only — INSERT/DELETE are rejected.',
    {
      query: z.string().min(1).max(10_000).describe('SPARQL query string (SELECT or ASK).'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional hard cap on returned bindings (default 200).'),
    },
    async ({ query, limit }) => {
      assertReadOnly(query);
      const upper = query.toUpperCase();
      if (upper.includes(' ASK ') || upper.startsWith('ASK')) {
        const ok = await sparqlAsk(query);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ type: 'ASK', boolean: ok }, null, 2) }],
        };
      }
      const result = await sparqlSelect(query);
      const cap = limit ?? 200;
      const bindings = result.results.bindings.slice(0, cap);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                type: 'SELECT',
                vars: result.head.vars,
                rowCount: bindings.length,
                truncated: result.results.bindings.length > cap,
                bindings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'sparql_ask',
    'Convenience wrapper for SPARQL ASK — returns a plain {boolean: true|false}. ' +
      'Use when the agent just needs a yes/no check without parsing bindings.',
    {
      query: z.string().min(1).max(10_000),
    },
    async ({ query }) => {
      assertReadOnly(query);
      const ok = await sparqlAsk(query);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ boolean: ok }) }],
      };
    },
  );

  server.tool(
    'list_graphs',
    'Enumerate the named graphs currently present in the store with their ' +
      'approximate triple counts. Useful for exploring what data is available.',
    {},
    async () => {
      const result = await sparqlSelect(
        'SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY DESC(?n) LIMIT 50',
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                graphs: result.results.bindings.map((b) => ({
                  graph: b.g?.value,
                  tripleCount: Number(b.n?.value ?? 0),
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'describe_entity',
    'Return every triple about an IRI — outgoing edges only. Use to ' +
      'inspect what the store knows about a specific subject.',
    {
      iri: z.string().min(1).describe('Fully-qualified IRI to describe (e.g. https://example.org/instance/Item/1).'),
    },
    async ({ iri }) => {
      assertValidIri(iri);
      const result = await sparqlSelect(
        `SELECT ?p ?o ?g WHERE {
          { <${iri}> ?p ?o BIND(<> AS ?g) }
          UNION { GRAPH ?g { <${iri}> ?p ?o } }
        } LIMIT 500`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                iri,
                triples: result.results.bindings.map((b) => ({
                  predicate: b.p?.value,
                  object: b.o?.value,
                  objectType: b.o?.type,
                  graph: b.g?.value || null,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

// --------- Transport: SSE on a minimal Express app ---------

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Per-session transports, keyed by MCP session id.
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req: Request, res: Response) => {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => {
      transports.delete(transport.sessionId);
    });
    const server = buildServer();
    await server.connect(transport);
  });

  app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).send('sessionId required');
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send('session not found');
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      endpoint: SPARQL_URL,
      tools: ['sparql_query', 'sparql_ask', 'list_graphs', 'describe_entity'],
      activeSessions: transports.size,
    });
  });

  app.listen(PORT, HOST, () => {
    console.log(`[sparql-mcp] listening on http://${HOST}:${PORT}`);
    console.log(`[sparql-mcp] SPARQL backend: ${SPARQL_URL}`);
    console.log(`[sparql-mcp] SSE endpoint:   /sse`);
  });
}

main().catch((err) => {
  console.error('[sparql-mcp] fatal:', err);
  process.exit(1);
});
