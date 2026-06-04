# SPARQL MCP

A read-only [MCP](https://modelcontextprotocol.io) server that exposes a SPARQL 1.1 endpoint as agent tools.

Built with Express and `@modelcontextprotocol/sdk`. It binds to `127.0.0.1:4002` by default and is strictly read-only: it exposes no SPARQL UPDATE surface, so an agent cannot mutate the graph. Queries containing `INSERT`, `DELETE`, `DROP`, `CLEAR`, `CREATE GRAPH`, or `LOAD` are rejected before they reach the store.

## Why

Knowledge graphs are a natural fit for giving agents structured, queryable context. This server gives agents safe, read-only knowledge-graph access over MCP — they can explore named graphs, run SELECT/ASK queries, and describe entities, but they can never write to or corrupt the underlying store.

## Tools

| Tool | Underlying SPARQL |
|---|---|
| `sparql_query` | `POST /query` — runs a SELECT or ASK and returns JSON bindings |
| `sparql_ask` | runs an `ASK` query and returns a plain `{ boolean }` |
| `list_graphs` | `SELECT DISTINCT ?g` over `GRAPH ?g { ?s ?p ?o }`, with approximate triple counts |
| `describe_entity` | `DESCRIBE ?subject` — returns all outgoing triples for an IRI |

## Config

The server reads two environment variables:

| Var | Default | Purpose |
|---|---|---|
| `SPARQL_ENDPOINT` | `http://127.0.0.1:7878` | Upstream SPARQL 1.1 endpoint (e.g. an Oxigraph or other SPARQL store). Host-guarded to localhost. |
| `MCP_PORT` | `4002` | Port the MCP server listens on |

An optional `MCP_HOST` (default `127.0.0.1`) controls the bind address.

Copy `.env.example` to `.env` and adjust as needed.

## Run

```bash
# install dependencies
npm install

# development (watch mode)
npm run dev

# production build + start
npm run build
npm start
```

Once running, the SSE endpoint is available at `/sse`, message posts go to `/messages`, and a `/health` probe reports status and the configured backend.

## License

MIT — see [LICENSE](./LICENSE).
