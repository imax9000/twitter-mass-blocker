import { Options } from 'options';
import type * as _ from 'global';

const proxyHostInput = () => document.getElementById('proxy_host') as HTMLInputElement;

(async () => {
  document.getElementById('confirmation')!.innerText = 'Retrieving options...';

  proxyHostInput().value = await Options.proxyHost();

  document.querySelectorAll<HTMLFieldSetElement>('fieldset').forEach(el => el.disabled = false);
  document.getElementById('confirmation')!.innerText = '';
})();


document.getElementById('save')?.addEventListener('click', async () => {
  document.getElementById('confirmation')!.innerText = 'Saving...';
  try {
    await Promise.all([
      Options.setProxyHost(proxyHostInput().value),
    ]);
    document.getElementById('confirmation')!.innerText = `Options saved.`;
  } catch (e) {
    document.getElementById('confirmation')!.innerText = String(e);
  }
});
