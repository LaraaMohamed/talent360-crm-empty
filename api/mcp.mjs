/**
 * Read-only MCP (Model Context Protocol) server.
 *
 * Lets an AI assistant — Claude, ChatGPT, Gemini, anything that speaks MCP
 * over Streamable HTTP — query this CRM directly. Mounted at `POST/GET /mcp`
 * by server.mjs, outside the `/api/` router: it authenticates itself (see
 * `ctxForMcpRequest`) rather than going through the cookie-session path, the
 * same way a Make/Zapier integration already authenticates with an
 * `X-Api-Key` header (lib/auth.mjs, `contextForApiKey`). Here the same key is
 * read from a standard `Authorization: Bearer <key>` header instead, because
 * that is what every MCP client already sends — one URL, one token, pasted
 * once into Claude/Gemini/ChatGPT's "add a connector" dialog.
 *
 * SECURITY MODEL
 * ---------------
 * A key acts as whoever created it (lib/auth.mjs `issueApiKey`) — the SAME
 * capability matrix a browser session uses, unchanged. On top of that,
 * deliberately narrower than what a key's role might otherwise reach through
 * the REST API:
 *
 *   - every tool call requires `record.read.all` (checked once, in
 *     `ctxForMcpRequest`, before any tool runs) — a key minted by an SDR
 *     (who never holds it) or another confined role reaches nothing here;
 *   - `list_records`/`get_record` are hard-limited to a fixed allowlist of
 *     object keys (OBJECT_ALLOWLIST) — the prospecting plane (uploaded
 *     companies, not customers) is excluded unconditionally, mirroring the
 *     dedicated `prospecting.read` gate api/search.mjs also enforces;
 *   - there is no write tool. Not "registered but refused" — never
 *     registered, so there is nothing for a model mistake, or an
 *     instruction hidden inside a record's own text and fed back to the
 *     model as a tool result, to call.
 *
 * Every tool calls the exact same lib/repo.mjs functions the REST API does
 * (listRecords, getRecord, hydrate) and the exact same api/search.mjs global
 * search — so a record an assistant can see here is exactly a record its
 * key's user could already see in the product. No new data surface, just a
 * new door onto the same one. Recommended: mint the key from a dedicated
 * user on the `readonly` role (Settings > Team, then Settings > API Keys),
 * not from an admin account, so a leaked key's blast radius is the CRM's
 * read-only surface, not the whole product.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { listRecords, getRecord } from '../lib/repo.mjs';
import { objectDef } from '../lib/objects.mjs';
import { contextForApiKey, can } from '../lib/auth.mjs';
import { unauthorized, forbidden, notFound, HttpError } from '../lib/http.mjs';
import { search as globalSearch } from './search.mjs';
import { readOwnScopeObject } from './records.mjs';

/**
 * Every object a key can list/read through MCP — the same set
 * api/records.mjs's ROUTES exposes, minus `prospecting_company` and
 * `prospecting_contact`. Those two stay REST-only, gated by
 * `prospecting.read`, which a `readonly` role does not hold; excluding them
 * here too means a key minted from a role that DOES hold it (manager, admin)
 * still cannot reach the sourcing book through this door. Add an object here
 * deliberately, not by widening a pattern — see the comment on `CONFINED` in
 * lib/auth.mjs for why an allowlist, not a denylist, is the default this
 * whole app already chose.
 */
const OBJECT_ALLOWLIST = [
    'account', 'contact', 'deal', 'task', 'activity', 'note',
    'document', 'proposal', 'agreement', 'campaign',
];

function requireAllowedObject(objectKey) {
    if (!OBJECT_ALLOWLIST.includes(objectKey)) {
        throw notFound(`No such object: ${objectKey}. Available: ${OBJECT_ALLOWLIST.join(', ')}.`);
    }
    return objectDef(objectKey);
}

/** Every tool's result, wrapped the way the MCP spec expects a text result. */
function textResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
    const message = err instanceof HttpError ? err.message : 'Something went wrong.';
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Resolves the `Authorization: Bearer <key>` header into the same request
 * context `contextForApiKey` already builds for `X-Api-Key` — then applies
 * this endpoint's own, stricter gate on top (see the file header).
 */
export function ctxForMcpRequest(req) {
    const auth = req.headers.authorization ?? '';
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
        throw unauthorized('Send an API key as "Authorization: Bearer <key>". Mint one under Settings > API Keys.');
    }
    const ctx = contextForApiKey(token);
    if (!ctx) throw unauthorized('That API key is invalid, revoked, or belongs to a suspended user.');
    if (!can(ctx, 'record.read.all')) {
        throw forbidden('This key\'s role cannot read records, so it cannot use the MCP server.');
    }
    return ctx;
}

/** Builds a fresh McpServer bound to one already-authenticated request's ctx. */
function buildServer(ctx) {
    const server = new McpServer({ name: 'talent360-crm', version: '1.0.0' });

    server.registerTool(
        'whoami',
        {
            title: 'Who am I',
            description: 'The workspace and user this API key belongs to. Call this first to orient yourself.',
            inputSchema: {},
        },
        async () => textResult({
            workspace: ctx.workspace.name,
            user: ctx.user.name,
            role: ctx.role,
        }),
    );

    server.registerTool(
        'search',
        {
            title: 'Search the CRM',
            description: 'Full-text search across accounts, contacts, deals, notes, documents and more. Returns the best-matching records, grouped by object type.',
            inputSchema: {
                query: z.string().min(2).describe('The text to search for — a name, company, email, or phone number.'),
                object: z.string().optional().describe('Restrict results to one object key, e.g. "account" or "contact". Omit to search everything.'),
                limit: z.number().int().min(1).max(50).optional().describe('Max results per object type (default 8).'),
            },
        },
        async ({ query, object, limit }) => {
            try {
                const url = new URL('http://mcp/search');
                url.searchParams.set('q', query);
                if (object) url.searchParams.set('object', object);
                if (limit) url.searchParams.set('limit', String(limit));
                const result = await globalSearch({ url, ctx });
                return textResult(result);
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.registerTool(
        'list_records',
        {
            title: 'List records',
            description: `List records of one object type, with optional paging. Object keys: ${OBJECT_ALLOWLIST.join(', ')}.`,
            inputSchema: {
                object: z.enum(OBJECT_ALLOWLIST).describe('Which object to list.'),
                q: z.string().optional().describe('Free-text filter, matched against the object\'s name/title fields.'),
                page: z.number().int().min(1).optional().describe('1-indexed page number (default 1).'),
                limit: z.number().int().min(1).max(100).optional().describe('Rows per page (default 20, max 100).'),
            },
        },
        async ({ object, q, page, limit }) => {
            try {
                requireAllowedObject(object);
                const options = { q: q || null, page: page || 1, limit: limit || 20 };
                const scopeColumn = readOwnScopeObject(ctx, object);
                if (scopeColumn) {
                    options.filter = { op: 'and', children: [{ field: scopeColumn, operator: 'is_any_of', value: [ctx.userId] }] };
                }
                const result = listRecords(object, ctx, options);
                return textResult({
                    object,
                    total: result.total,
                    page: result.page,
                    pages: result.pages,
                    records: result.records,
                });
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.registerTool(
        'get_record',
        {
            title: 'Get one record',
            description: `Read a single record by id. Object keys: ${OBJECT_ALLOWLIST.join(', ')}.`,
            inputSchema: {
                object: z.enum(OBJECT_ALLOWLIST).describe('Which object the id belongs to.'),
                id: z.string().describe('The record\'s id, e.g. "acc_cpHR3THnAk17".'),
            },
        },
        async ({ object, id: recordId }) => {
            try {
                requireAllowedObject(object);
                const record = getRecord(object, ctx, recordId);
                // Same own-only scope as list_records — reachable by id must
                // not be a wider door than reachable by search (see read()
                // in api/records.mjs, which this mirrors exactly).
                const scopeColumn = readOwnScopeObject(ctx, object);
                if (scopeColumn && record[scopeColumn] !== ctx.userId) {
                    throw notFound(`That ${object} does not exist.`);
                }
                return textResult(record);
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    return server;
}

/**
 * Handles one `/mcp` request. Stateless by design (`sessionIdGenerator:
 * undefined`): a fresh McpServer + transport per HTTP request, bound to that
 * request's own authenticated ctx, torn down once the response ends. Nothing
 * about one request's auth can leak into another's — there is no shared
 * session to leak through.
 */
export async function handleMcpRequest(req, res) {
    let ctx;
    try {
        ctx = ctxForMcpRequest(req);
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof HttpError ? err.message : 'Something went wrong.' }));
        return;
    }

    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        transport.close();
        server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}
