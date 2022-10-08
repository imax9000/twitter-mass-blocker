import axios from 'axios';
import CryptoJS from 'crypto-js';
import Base64url from 'crypto-js/enc-base64url';
import { ExtensionConfigStore, TwitterProxyClient, Token } from 'twitter-proxy-client';

import type { Menus } from 'webextension-polyfill';
import type * as tt from 'twitter-types';

import { Options } from 'options';
import * as credentials from 'credentials';
import type * as _ from 'global';

import { blockLikers } from './block_likers';


interface MenuEntry {
    id: string;
    createProps: Menus.CreateCreatePropertiesType;
    updateOnShown?: (info: Menus.OnShownInfoType) => Menus.UpdateUpdatePropertiesType | null;
    onClicked?: (info: Menus.OnClickData) => void;
};

const menuEntries: MenuEntry[] = [
    {
        // Dummy entry to force browser to create a submenu. Delete once there's more than one non-dummy entry.
        id: 'dummy',
        createProps: {
            title: 'Twitter Mass Blocker',
            enabled: false,
            documentUrlPatterns: ["https://twitter.com/*", "https://tweetdeck.twitter.com/*"],
        },
    },
    {
        id: 'block_likers',
        createProps: {
            title: 'Block/mute likers',
            contexts: ['link'],
            documentUrlPatterns: ["https://twitter.com/*", "https://tweetdeck.twitter.com/*"],
        },
        updateOnShown: (info: Menus.OnShownInfoType): Menus.UpdateUpdatePropertiesType => {
            let enabled = false;
            if (typeof info.linkUrl === 'string') {
                const url = new URL(info.linkUrl);
                enabled = url.host == 'twitter.com' && /\/[^\/]+\/status\/[0-9]+/.test(url.pathname);
            }
            return { enabled };
        },
        onClicked: (info) => {
            const tweet_id = (new URL(info.linkUrl!)).pathname.match(/\/[^\/]+\/status\/([0-9]+)/)![1];
            browser.tabs.create({ url: browser.runtime.getURL('block_likers.html') + '?tweet_id=' + tweet_id });
        },
    },
];

for (const entry of menuEntries) {
    browser.menus.create({ id: entry.id, ...entry.createProps });
}

browser.menus.onShown.addListener((info, tab) => {
    let needRefresh = false;
    for (const entry of menuEntries) {
        if (entry.updateOnShown !== undefined) {
            const upd = entry.updateOnShown(info);
            if (upd) {
                browser.menus.update(entry.id, upd);
                needRefresh = true;
            }
        }
    }
    if (needRefresh) { browser.menus.refresh(); }
});

browser.menus.onClicked.addListener((info, tab) => {
    for (const entry of menuEntries) {
        if (entry.id == info.menuItemId) {
            if (entry.onClicked) {
                entry.onClicked(info);
            }
            return;
        }
    }
})

browser.runtime.onMessage.addListener((data: any) => {
    console.log("Incoming message: %o", data);
    switch (data.request) {
        case 'auth':
            auth_oauth2();
            break;
        case 'block_likers':
            return blockLikers(data);
    }
});

async function auth_oauth2() {
    const state = CryptoJS.lib.WordArray.random(32).toString(Base64url);
    const challenge = CryptoJS.lib.WordArray.random(32).toString(Base64url);
    const proxy_host = await Options.proxyHost();
    const proxy = (url: string): string => {
        const u = new URL(url);
        u.host = proxy_host;
        return u.toString();
    };
    const auth_url = 'https://twitter.com/i/oauth2/authorize?' + (new URLSearchParams({
        response_type: 'code',
        client_id: credentials.clientID,
        redirect_uri: browser.identity.getRedirectURL(),
        state: state,
        code_challenge: challenge,
        code_challenge_method: 'plain',
        scope: [
            'offline.access',

            'like.read',
            'block.read',
            'mute.read',
            'tweet.read',
            'users.read',
            'follows.read',

            'mute.write',
            'block.write',
        ].join(' '),
    })).toString();

    const redirect = new URL(await browser.identity.launchWebAuthFlow({ url: auth_url, interactive: true }));

    if (redirect.searchParams.get("state") != state) {
        throw "Mismatching state in the OAuth2.0 redirect";
    }

    const client = axios.create();
    let resp = await client.post(
        proxy('https://api.twitter.com/2/oauth2/token'),
        new URLSearchParams({
            code: redirect.searchParams.get('code')!,
            grant_type: 'authorization_code',
            client_id: credentials.clientID,
            redirect_uri: browser.identity.getRedirectURL(),
            code_verifier: challenge,
        }),
        {
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });

    const token = resp.data as Token;
    const config_store = new ExtensionConfigStore();
    await config_store.setToken(token);

    resp = await client.get<tt.GETUsersMeResponse>(proxy('https://api.twitter.com/2/users/me'), {
        headers: {
            Authorization: 'Bearer ' + token.access_token,
        },
    });
    token.self = resp.data;
    await config_store.setToken(token);
}

declare global {
    interface Window {
        twitterClient: () => TwitterProxyClient;
    }
};

window.twitterClient = () => new TwitterProxyClient(new ExtensionConfigStore, credentials.clientID);

(async () => {
    let persistent = await navigator.storage.persisted();
    if (!persistent) {
        persistent = await navigator.storage.persist();
    }
    if (!persistent) {
        console.warn('Failed to enable storage persistence');
    }
})();
