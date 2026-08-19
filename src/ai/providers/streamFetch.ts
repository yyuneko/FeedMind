export const streamFetch = (url: string, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init);
