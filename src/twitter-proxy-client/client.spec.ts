import * as assert from 'assert';
import { AxiosResponse, AxiosError, AxiosRequestConfig } from 'axios';
import sinon from 'sinon';
import * as tt from 'twitter-types';

import * as lib from './client';
import { ConfigStore, Token } from './config_store';
import 'mocha';


class FakeConfigStore implements ConfigStore {
  token_: Token;
  constructor(token: Token) { this.token_ = token; }

  async token(): Promise<Token> { return this.token_; }
  async setToken(t: Token): Promise<void> { this.token_ = t; }
  async updateToken(t: Partial<Token>): Promise<void> { this.token_ = { ...this.token_, ...t }; }

  async self(): Promise<tt.APIUser> { return this.token_.self!.data; }
  async accessToken(): Promise<string> { return this.token_.access_token; }
  async refreshToken(): Promise<string> { return this.token_.refresh_token!; }
}

const dummyToken: Token = {
  access_token: '1',
  refresh_token: '2',
  scope: '',
  self: {
    data: {
      id: '123',
      name: 'foo',
      username: 'foo'
    }
  }
};

function mkResponse<T>(status: number, fields: Partial<AxiosResponse<T>> = {}): AxiosResponse<T> {
  return {
    config: {},
    data: {} as unknown as T,
    headers: {},
    statusText: 'default status text',
    ...fields,
    status,
  };
}

function throwError<T = any>(
  message?: string,
  code?: string,
  config?: AxiosRequestConfig,
  request?: any,
  response?: AxiosResponse<T>) {
  throw new AxiosError(message, code, config, request, response);
}

describe('TwitterProxyClient.consume', () => {
  let items: string[], successful: string[], failed: string[];
  let client: lib.TwitterProxyClient;
  let allItems: Set<string>;
  beforeEach(() => {
    items = ['a', 'b', 'c', 'd', 'e'];
    allItems = new Set(items);
    successful = [];
    failed = [];
    client = new lib.TwitterProxyClient(new FakeConfigStore(dummyToken), 'client_id');
  });

  it('processes all items when calls are successful', async function () {
    sinon.replace(client, 'request',
      sinon.fake(async (req): Promise<AxiosResponse> => {
        successful.push(req.data);
        return mkResponse(200);
      }));

    const result = await client.consume(items, (i) => { return { method: 'GET', endpoint: '', data: i }; }, (i) => failed.push(i));
    assert.deepStrictEqual(result, { done: true });
    assert.strictEqual(items.length, 0, `items ${JSON.stringify(items)} were not removed from the queue`)
  });

  it('calls failedItem callback on API error', async function () {
    sinon.replace(client, 'request',
      sinon.fake(async (req): Promise<AxiosResponse> => {
        if (req.data == 'b') {
          throwError('', '', {}, {}, mkResponse(400));
        }
        successful.push(req.data);
        return mkResponse(200);
      }));

    const result = await client.consume(items, (i) => { return { method: 'GET', endpoint: '', data: i }; }, (i) => failed.push(i));
    assert.deepStrictEqual(result, { done: true });
    assert.deepStrictEqual(failed, ['b']);
  });

  it('retries on transient errors', async function () {
    let fail = true;
    sinon.replace(client, 'request',
      sinon.fake(async (req): Promise<AxiosResponse> => {
        if (fail) {
          throwError();
        }
        successful.push(req.data);
        return mkResponse(200);
      }));

    const result = await client.consume(items, (i) => { return { method: 'GET', endpoint: '', data: i }; }, (i) => failed.push(i));
    assert.ok('error' in result, 'did not return an error on transient error from request');
    assert.deepStrictEqual(failed, [], 'called failedItem on transient error');
    assert.deepStrictEqual(new Set(items), allItems, 'removed item from the queue on transient error');

    fail = false;
    const result2 = await client.consume(items, (i) => { return { method: 'GET', endpoint: '', data: i }; }, (i) => failed.push(i));
    assert.deepStrictEqual(result2, { done: true });
  });

  it('retries when throttled', async function () {
    let throttle = true;
    sinon.replace(client, 'request',
      sinon.fake(async (req): Promise<AxiosResponse> => {
        if (throttle) {
          throwError('', '', {}, {}, mkResponse(429, { headers: { 'x-rate-limit-reset': '123' } }));
        }
        successful.push(req.data);
        return mkResponse(200);
      }));

    const result = await client.consume(items, (i) => { return { method: 'GET', endpoint: '', data: i }; }, (i) => failed.push(i));
    assert.ok('resume_after' in result, 'did not return resume_after on being throttled');
    assert.deepStrictEqual(failed, [], 'called failedItem when throttled');
    assert.deepStrictEqual(new Set(items), allItems, 'removed item from the queue when throttled');

    throttle = false;
    const result2 = await client.consume(items, (i) => { return { method: 'GET', endpoint: '', data: i }; }, (i) => failed.push(i));
    assert.deepStrictEqual(result2, { done: true });
  });

  afterEach(() => {
    assert.deepStrictEqual(new Set(successful.concat(failed)), allItems,
      'not all items were processed');
    sinon.restore();
  });
});

describe('TwitterProxyClient.collect', () => {
  let client: lib.TwitterProxyClient;
  const items = ['a', 'b', 'c', 'd', 'e'];
  Object.freeze(items);

  beforeEach(() => {
    client = new lib.TwitterProxyClient(new FakeConfigStore(dummyToken), 'client_id');
  });
  afterEach(() => {
    sinon.restore();
  });

  it('collects all items when calls are successful', async function () {
    let state: lib.CollectLoopState = {};
    sinon.replace(client, 'request', sinon.fake(async (req) => {
      let idx = 0;
      if ('pagination_token' in req.params) {
        idx = Number(req.params.pagination_token);
        if (idx < 0 || idx >= items.length) {
          throwError('out of bounds');
        }
      }
      return mkResponse(200, {
        data: {
          values: [items[idx]],
          meta: {
            result_count: 1,
            next_token: idx + 1 < items.length ? String(idx + 1) : undefined,
          },
        }
      });
    }));
    const result = await client.collect({ method: 'GET', endpoint: '', params: {} }, state, (resp) => resp.data.values);
    assert.deepStrictEqual(result.result, { done: true });
    assert.deepStrictEqual(new Set(result.collected_items), new Set(items));
  });

  it('handles errors', async function () {
    let fail = true;

    let state: lib.CollectLoopState = {};
    sinon.replace(client, 'request', sinon.fake(async (req) => {
      if (fail) {
        throwError();
      }

      let idx = 0;
      if ('pagination_token' in req.params) {
        idx = Number(req.params.pagination_token);
        if (idx < 0 || idx >= items.length) {
          throwError('out of bounds');
        }
      }
      return mkResponse(200, {
        data: {
          values: [items[idx]],
          meta: {
            result_count: 1,
            next_token: idx + 1 < items.length ? String(idx + 1) : undefined,
          },
        }
      });
    }));

    let collected: string[] = [];
    let result = await client.collect({ method: 'GET', endpoint: '', params: {} }, state, (resp): string[] => resp.data.values);
    collected = collected.concat(result.collected_items);
    state = result.state;
    assert.ok('error' in result.result);

    fail = false;
    result = await client.collect({ method: 'GET', endpoint: '', params: {} }, state, (resp): string[] => resp.data.values);
    collected = collected.concat(result.collected_items);
    state = result.state;
    assert.deepStrictEqual(result.result, { done: true });
    assert.deepStrictEqual(new Set(collected), new Set(items));
  });

  it('handles being throttled', async function () {
    let throttle = true;

    let state: lib.CollectLoopState = {};
    sinon.replace(client, 'request', sinon.fake(async (req) => {
      if (throttle) {
        throwError('', '', {}, {}, mkResponse(429, { headers: { 'x-rate-limit-reset': '123' } }));
      }

      let idx = 0;
      if ('pagination_token' in req.params) {
        idx = Number(req.params.pagination_token);
        if (idx < 0 || idx >= items.length) {
          throwError('out of bounds');
        }
      }
      return mkResponse(200, {
        data: {
          values: [items[idx]],
          meta: {
            result_count: 1,
            next_token: idx + 1 < items.length ? String(idx + 1) : undefined,
          },
        }
      });
    }));

    let collected: string[] = [];
    let result = await client.collect({ method: 'GET', endpoint: '', params: {} }, state, (resp): string[] => resp.data.values);
    collected = collected.concat(result.collected_items);
    state = result.state;
    assert.ok('resume_after' in result.result);

    throttle = false;
    result = await client.collect({ method: 'GET', endpoint: '', params: {} }, state, (resp): string[] => resp.data.values);
    collected = collected.concat(result.collected_items);
    state = result.state;
    assert.deepStrictEqual(result.result, { done: true });
    assert.deepStrictEqual(new Set(collected), new Set(items));
  });
});
