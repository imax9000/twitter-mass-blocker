import type * as tt from 'twitter-types';

import { TwitterProxyClient, ExtensionConfigStore } from 'twitter-proxy-client';
import * as credentials from 'credentials';
import * as _ from 'global';

const client = new TwitterProxyClient(new ExtensionConfigStore(), credentials.clientID);

const tweet_id = new URLSearchParams(window.location.search).get('tweet_id');

if (tweet_id) {
  (async () => {
    const tweet = await client.get<tt.GETTweetsIdResponse>('/2/tweets/' + tweet_id, {
      'tweet.fields': ['text', 'public_metrics'],
      'user.fields': ['username'],
      'expansions': ['author_id'],
    });

    document.getElementById('text')!.innerText = tweet.data.data.text;
    document.getElementById('username')!.innerText = '@' + tweet.data.includes!.users![0].username;
    document.getElementById('like_count')!.innerText = String(tweet.data.data.public_metrics!.like_count);
  })();
} else {
  document.getElementById('confirmation')!.innerText = 'Missing tweet_id URL parameter';
}

document.getElementById('start')?.addEventListener('click', async () => {
  document.getElementById('confirmation')!.innerText = 'Sending the request to the background page...';
  try {
    let bgPage = await browser.runtime.getBackgroundPage();
    const options = new FormData(document.getElementById('options')! as HTMLFormElement);
    const msg = {
      request: 'block_likers',
      tweet_id: tweet_id,
      action: options.get('action')!.toString(),
      exclude_followers: options.get('followers') == 'on',
      exclude_follows: options.get('follows') == 'on',
      include_likers: options.get('likers') == 'on',
      include_retweeters: options.get('retweeters') == 'on',
    };
    if (!(msg.include_likers || msg.include_retweeters)) {
      document.getElementById('confirmation')!.innerText = 'Please selecto whom to add to the block/mute queue';
      return;
    }
    const resp = await browser.runtime.sendMessage(msg);
    document.getElementById('confirmation')!.innerText = `Request sent, you can safely close this page now.\n${JSON.stringify(resp)}`;
  } catch (e) {
    document.getElementById('confirmation')!.innerText = String(e);
  }
});
