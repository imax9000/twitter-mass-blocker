import axios, { AxiosError, AxiosResponse, AxiosRequestConfig } from 'axios';
import * as tt from 'twitter-types';

import { Options } from "options";

import { ConfigStore } from "./config_store";

export class TwitterProxyClient {
  private config_store: ConfigStore;
  private client = axios.create();
  private clientID: string;

  constructor(config_store: ConfigStore, clientID: string) {
    this.config_store = config_store;
    this.clientID = clientID;
  }

  private proxy_url(endpoint: string, proxy_host: string): string {
    if (endpoint.startsWith('/')) {
      return 'https://' + proxy_host + endpoint;
    }
    const url = new URL(endpoint);
    url.host = proxy_host;
    return url.toString();
  }

  async refreshToken(): Promise<string> {
    let url = this.proxy_url('/2/oauth2/token', await Options.proxyHost());
    const resp = await this.client.post(url, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientID,
      refresh_token: await this.config_store.refreshToken(),
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    await this.config_store.updateToken({
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token
    });

    return resp.data.access_token;
  }

  async request<T = any>(req_: Request): Promise<AxiosResponse<T>> {
    const req: Request = JSON.parse(JSON.stringify(req_));
    if (req.endpoint.indexOf('/:id/') >= 0) {
      const self = await this.config_store.self();
      req.endpoint = req.endpoint.replace('/:id/', `/${self.id}/`);
    }
    const proxy_addr = await Options.proxyHost();
    const access_token = await this.config_store.accessToken();
    let url = this.proxy_url(req.endpoint, proxy_addr);
    if (req.params) {
      url += '?' + (new URLSearchParams(req.params)).toString();
    }
    const cfg: AxiosRequestConfig = {
      method: req.method,
      url: url,
      data: req.data,
      headers: {
        Authorization: 'Bearer ' + access_token,
      },
    };
    if (req.data) {
      cfg.headers!['content-type'] = 'application/json';
    }
    try {
      if (req.cache) {
        const cache = await caches.open('twitter-proxy-client');
        let cacheReq = new Request(url, { method: req.method, headers: new Headers(cfg.headers! as Record<string, string>) });
        let cached = await cache.match(cacheReq);
        if (cached) {
          return { config: cfg, data: await cached.json(), headers: {}, status: cached.status, statusText: cached.statusText };
        }
        const resp = await this.client.request(cfg);
        cache.put(cacheReq, new Response(JSON.stringify(resp.data), {
          status: resp.status,
          statusText: resp.statusText,
        }));
        return resp;
      } else {
        return await this.client.request(cfg);
      }
    } catch (e) {
      const error = e as AxiosError<tt.APIProblem>;
      if (error.response) {
        if (error.response.status == 401) {
          const current_token = await this.config_store.accessToken();
          if (current_token != access_token) {
            // Another thread already refreshed it.
            return this.request(req_);
          }
          cfg.headers!.Authorization = 'Bearer ' + await this.refreshToken();
          return this.client.request(cfg);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  async get<T = any>(endpoint: string, params?: any): Promise<AxiosResponse<T>> {
    return this.request({ method: 'GET', endpoint, params });
  }

  async post<T = any>(endpoint: string, params?: any, data?: any): Promise<AxiosResponse<T>> {
    return this.request({ method: 'POST', endpoint, params, data });
  }

  /**
  * Sends an API call for each item in items.
  *
  * List of items is modified in-place. If a request results in an error, the item
  * will be either put back into the list or passed to failedItem callback.
  *
  * @param items - list of items to consume, modified in-place
  * @param mkRequest - callback that generates request info for an item
  * @param failedItem - callback for non-retryable errors
  * @param successfulItem - optional callback for successfully consumed items
  * @returns LoopResult
  */
  async consume<T>(items: T[], mkRequest: (i: T) => Request, failedItem: (i: T, error: AxiosError) => Promise<any>, successfulItem?: (i: T, resp: AxiosResponse) => void): Promise<LoopResult> {
    while (items.length > 0) {
      const item = items.shift()!;
      try {
        const req = mkRequest(item);
        const resp = await this.request(req);
        if (successfulItem) { successfulItem(item, resp); }
        if (resp.headers['x-rate-limit-remaining'] == '0' && resp.headers['x-rate-limit-reset']) {
          // Request was successful, but we've exhausted the rate limit.
          return { resume_after: new Date(Number(resp.headers['x-rate-limit-reset']) * 1000 + 1000).valueOf() };
        }
      } catch (e) {
        const error = e as AxiosError<tt.APIProblem>;
        let retry = true;
        let result: LoopResult = { error: error };
        if (error.response) {
          if (error.response.status == 429) {
            result = { resume_after: new Date(Number(error.response.headers['x-rate-limit-reset']) * 1000 + 1000).valueOf() };
          } else if (error.response.status == 400 && (error.response.data as any).error_description == 'Value passed for the token was invalid.') {
            // Our token is invalid, wait for storage.sync to get a new one from another browser instance.
            result = { error: error };
          } else {
            // API error other than rate limit.
            retry = false;
          }
        } else {
          // Network error or something.
          result = { error: error };
        }
        if (retry) {
          items.unshift(item);
          return result;
        } else {
          try {
            await failedItem(item, error);
          } catch (e) {
            items.unshift(item);
            console.error(e);
            console.error(error);
          }
          continue;
        }
      }
    }
    return { done: true };
  }

  /**
  * Collects responses from paginated API requests into a list.
  */
  async collect<T>(request: Request, state: CollectLoopState, mapResponse: (response: AxiosResponse) => T[]): Promise<CollectResult<T>> {
    let ret: T[] = [];
    while (true) {
      try {
        const req: Request = JSON.parse(JSON.stringify(request));
        if (state.pagination_token) {
          if (req.params === undefined) {
            req.params = {};
          }
          req.params.pagination_token = state.pagination_token;
        }
        const resp = await this.request(req) as AxiosResponse<{
          meta: {
            result_count: number;
            previous_token?: string;
            next_token?: string;
          };
        }>;
        if (resp.data.meta.result_count > 0) {
          ret = ret.concat(mapResponse(resp));
        }
        if (resp.data.meta.next_token) {
          state.pagination_token = resp.data.meta.next_token;
        } else {
          state.pagination_token = undefined;
          break;
        }
        if (resp.headers['x-rate-limit-remaining'] == '0' && resp.headers['x-rate-limit-reset']) {
          // Request was successful, but we've exhausted the rate limit.
          return {
            collected_items: ret,
            state: state,
            result: { resume_after: new Date(Number(resp.headers['x-rate-limit-reset']) * 1000 + 1000).valueOf() }
          };
        }
      } catch (e) {
        const error = e as AxiosError<tt.APIProblem>;
        if (error.response && error.response.status == 429) {
          return {
            collected_items: ret,
            state: state,
            result: { resume_after: new Date(Number(error.response.headers['x-rate-limit-reset']) * 1000 + 1000).valueOf() }
          };
        } else {
          // Not rate limit-related API error or a network error or something.
          return { collected_items: ret, state: state, result: { error: error } };
        }
      }
    }
    return { collected_items: ret, result: { done: true }, state: {} };
  };
}

export interface Done {
  done: true;
};

export interface ResumeAfter {
  resume_after: number;
}

export interface TransientError {
  error: AxiosError;
}

export type LoopResult = Done | ResumeAfter | TransientError;

export interface Request {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  endpoint: string;
  params?: Record<string, any>;
  data?: any;
  cache?: boolean;
}

export interface CollectLoopState {
  pagination_token?: string;
}

export interface CollectResult<T> {
  collected_items: T[];
  state: CollectLoopState;
  result: LoopResult;
}
