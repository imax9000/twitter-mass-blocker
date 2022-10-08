import * as _global from 'global';

export namespace Key {
  export const proxyHost = 'proxy_host';
}

export namespace Options {
  async function set(key: string, value: any): Promise<void> {
    return browser.storage.sync.set({ [key]: value });
  }

  async function get<T>(key: string, defaultValue: T): Promise<T> {
    const v = (await browser.storage.sync.get(key))[key];
    if (v === undefined) {
      return defaultValue;
    }
    return v;
  }

  export async function proxyHost(): Promise<string> {
    const r = await browser.storage.sync.get(Key.proxyHost);
    return get(Key.proxyHost, "");
  }

  export async function setProxyHost(value: string): Promise<void> {
    return set(Key.proxyHost, value);
  }
}
