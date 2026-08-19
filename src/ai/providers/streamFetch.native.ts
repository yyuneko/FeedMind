import { fetch } from 'expo/fetch';

export const streamFetch = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
