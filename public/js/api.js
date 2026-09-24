/**
 * API client.
 *
 * One place that knows how to talk to the server, so error handling and the
 * 401-means-sign-in rule are written once.
 */

export class ApiError extends Error {
    constructor(status, message, payload) {
        super(message);
        this.status = status;
        this.payload = payload ?? {};
    }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, path, body, options = {}) {
    const init = {
        method,
        credentials: 'same-origin',
        headers: {},
    };
    if (body !== undefined && body !== null) {
        if (body instanceof Blob || body instanceof ArrayBuffer) {
            init.body = body;
        } else {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
    }

    let response;
    try {
        response = await fetch(path, init);
    } catch {
        // A dead server and a bad request are different problems and deserve
        // different messages.
        throw new ApiError(0, 'Could not reach the server. Is it still running?');
    }

    if (response.status === 401 && !options.allowUnauthorized) {
        onUnauthorized?.();
        throw new ApiError(401, 'Your session has ended. Sign in again.');
    }

    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
        if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText}`);
        return response;
    }

    const payload = await response.json();
    if (!response.ok) throw new ApiError(response.status, payload.error ?? 'Something went wrong.', payload);
    return payload;
}

export const api = {
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body, options) => request('POST', path, body ?? {}, options),
    patch: (path, body) => request('PATCH', path, body ?? {}),
    put: (path, body) => request('PUT', path, body ?? {}),
    delete: (path, body) => request('DELETE', path, body),

    /**
     * Sends a string as-is rather than as JSON.
     *
     * An uploaded CSV is not a JSON value: wrapping it in quotes and escaping
     * every newline inflates it and forces the server to unwrap a string it
     * only wants to parse. Used by the importer's profile step.
     */
    postText: (path, text) => request('POST', path, new Blob([text], { type: 'text/csv; charset=utf-8' })),

    /**
     * Raw bytes to any endpoint, with the metadata in the query string.
     *
     * `upload` below does the same thing for the generic document endpoint;
     * this is the general form, used by the proposal/agreement version upload
     * where the path carries the account and the query carries the type and the
     * mode. Neither needs a multipart parser to exist on the server.
     */
    async postBinary(path, file) {
        const response = await fetch(path, {
            method: 'POST', credentials: 'same-origin', body: file,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new ApiError(response.status, payload.error ?? 'Upload failed.', payload);
        return payload;
    },

    /** Raw bytes with metadata in the query string — see api/documents.mjs. */
    async upload(file, { parentType, parentId }) {
        const query = new URLSearchParams({
            name: file.name, parent_type: parentType, parent_id: parentId, mime: file.type || '',
        });
        const response = await fetch(`/api/documents/upload?${query}`, {
            method: 'POST', credentials: 'same-origin', body: file,
        });
        const payload = await response.json();
        if (!response.ok) throw new ApiError(response.status, payload.error ?? 'Upload failed.', payload);
        return payload;
    },
};

/** Builds `/api/<route>?...` with the filter and sort serialised as JSON. */
export function listUrl(route, options = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value === null || value === undefined || value === '') continue;
        query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const qs = query.toString();
    return `/api/${route}${qs ? `?${qs}` : ''}`;
}
