import { ExtensionConfigStore } from 'twitter-proxy-client';

import { Options } from 'options';
import type * as _ from 'global';

const authButtonID = "auth-button";
const statusID = "status";

const setStatus = (s: string) => {
    document.getElementById(statusID)!.innerText = s;
};

document.getElementById(authButtonID)!.addEventListener('click', async () => {
    let bgPage = await browser.runtime.getBackgroundPage();
    await browser.runtime.sendMessage({ request: 'auth' });
});

(async () => {
    const config_store = new ExtensionConfigStore();
    const proxy_host = await Options.proxyHost();
    if (!proxy_host) {
        setStatus("Please set proxy host in the extension options");
        return;
    }
    const self = await config_store.self();
    if (self) {
        setStatus(`Logged in as @${self.username}`);
    } else {
        setStatus("Not logged in");
    }
})();
