import * as tt from 'twitter-types';

import type * as _ from 'global';

export interface ConfigStore {
  token(): Promise<Token>;
  setToken(t: Token): Promise<void>;
  updateToken(t: Partial<Token>): Promise<void>;

  self(): Promise<tt.APIUser>;
  accessToken(): Promise<string>;
  refreshToken(): Promise<string>;
}

export interface Token {
  access_token: string,
  refresh_token?: string,
  scope: string,
  self?: tt.GETUsersMeResponse,
};

export const credentialsKey = 'credentials';

export class ExtensionConfigStore implements ConfigStore {
  async token(): Promise<Token> {
    const r = await browser.storage.sync.get(credentialsKey);
    return r[credentialsKey];
  }

  async setToken(t: Token): Promise<void> {
    return browser.storage.sync.set({ [credentialsKey]: t });
  }

  async updateToken(t: Partial<Token>): Promise<void> {
    const old = await this.token();
    return this.setToken({ ...old, ...t });
  }

  async self(): Promise<tt.APIUser> {
    const r = await this.token();
    return r?.self?.data!;
  }

  async accessToken(): Promise<string> {
    const r = await this.token();
    return r?.access_token;
  }
  async refreshToken(): Promise<string> {
    const r = await this.token();
    return r?.refresh_token!;
  }
}
