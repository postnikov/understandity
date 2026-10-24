import { MODALITIES, type EnginesResponse, type Modality, type ProviderSummary, type Settings } from '@understandity/contracts';
import { api, type KeyStatus } from '../api.js';
import { app, errorText, esc, rerender, t } from '../app.js';
import type { View } from '../main.js';

/**
 * Engine settings: provider + model (+ voice for TTS) per modality, and the profile.
 * In Offline, cloud providers stay visible but disabled, with the reason next to them.
 */
const s = {
  engines: null as EnginesResponse | null,
  draft: null as Settings | null,
  issues: [] as string[],
  msg: null as string | null,
  error: null as string | null,
  saving: false,
  keys: [] as KeyStatus[],
  keyMsg: null as string | null,
};

/** Which saved key arms a cloud provider (provider id → key id). */
const keyIdOf = (p: ProviderSummary) => (p.provider === 'gemini-api' ? 'gemini' : p.provider);
const keySetFor = (p: ProviderSummary) => s.keys.some((k) => k.id === keyIdOf(p) && k.set);
const anyKey = () => s.keys.some((k) => k.set);

type Block = 'cloud_offline' | 'disabled' | 'not_wired' | 'no_key' | null;
function blockOf(p: ProviderSummary, profile: Settings['profile']): Block {
  // The Offline reason goes first: it is the one a parent needs to read, whatever the config says.
  if (profile === 'offline' && !p.offlineSafe) return 'cloud_offline';
  // A cloud engine is armed by its key in the Online profile, even before the profile is applied.
  if (p.locality === 'cloud') return keySetFor(p) ? (p.health === null ? 'not_wired' : null) : 'no_key';
  if (!p.enabled) return 'disabled';
  if (p.health === null) return 'not_wired';
  return null;
}

function blockText(b: Block, modality: Modality): string {
  const d = t().engines;
  // What leaves the machine depends on the engine: speech recognition sends the child's audio, the rest send text.
  const cloud = modality === 'stt' ? d.cloudBlockedAudio : d.cloudBlocked;
  return b === 'cloud_offline' ? cloud : b === 'no_key' ? d.noKey : b === 'disabled' ? d.disabled : b === 'not_wired' ? d.notWired : '';
}

/**
 * Honest Online text: names what actually leaves the machine with the engines picked right now
 * (speech recognition sends the child's audio, text and voice engines send text).
 */
function onlineText(draft: Settings, eng: EnginesResponse): string {
  const d = t().engines;
  const parts: string[] = [];
  for (const m of MODALITIES) {
    const p = eng.providers.find((x) => x.modality === m && x.provider === draft.engines[m].provider);
    if (p?.locality !== 'cloud') continue;
    const what = m === 'stt' ? d.leavesAudio : m === 'tts' ? d.leavesTutorText : m === 'text' ? d.leavesDialogue : d.leavesImagePrompt;
    parts.push(`${what} → ${p.label}`);
  }
  return parts.length ? `${d.onlineCloud} ${parts.join('; ')}.` : d.onlineLocal;
}

/** Switching to Offline: any cloud selection falls back to the configured default for that modality, visibly. */
function enforceProfile(draft: Settings, eng: EnginesResponse): string[] {
  const moved: string[] = [];
  for (const m of MODALITIES) {
    const sel = draft.engines[m];
    const cur = eng.providers.find((p) => p.modality === m && p.provider === sel.provider);
    if (cur && blockOf(cur, draft.profile) === null) continue;
    const alt = eng.providers.find((p) => p.modality === m && blockOf(p, draft.profile) === null);
    if (alt) {
      draft.engines[m] = { provider: alt.provider, model: alt.models[0]?.id ?? sel.model, voice: alt.models[0]?.voices?.[0] ?? null };
      moved.push(`${t().engines.modality[m]} → ${alt.label}`);
    }
  }
  return moved;
}

function modalityCard(m: Modality): string {
  const d = t().engines;
  const eng = s.engines!;
  const draft = s.draft!;
  const providers = eng.providers.filter((p) => p.modality === m);
  const sel = draft.engines[m];
  const cur = providers.find((p) => p.provider === sel.provider);
  const health = cur?.health?.state ?? null;
  const voices = cur?.models.find((mo) => mo.id === sel.model)?.voices ?? [];
  return `<section class="eng">
    <div class="eng__head">
      <h3>${esc(d.modality[m] ?? m)}</h3><span class="sp"></span>
      ${cur ? `<span class="chip ${cur.locality === 'cloud' ? 'chip--amber' : ''}">${cur.locality === 'cloud' ? d.cloud : d.local}</span>` : ''}
      <span class="hdot ${health ?? ''}" title="${esc(cur?.health?.detail ?? '')}"></span>
    </div>
    <label class="field"><span class="label">${d.provider}</span><span class="select"><select data-prov="${m}">${providers
      .map((p) => {
        const b = blockOf(p, draft.profile);
        return `<option value="${esc(p.provider)}" ${p.provider === sel.provider ? 'selected' : ''} ${b ? 'disabled' : ''}>${esc(p.label)} · ${p.locality === 'cloud' ? d.cloud : d.local}${b ? ` — ${esc(blockText(b, p.modality))}` : ''}</option>`;
      })
      .join('')}</select></span></label>
    <label class="field"><span class="label">${d.model}</span><span class="select"><select data-model="${m}">${(cur?.models ?? [])
      .map((mo) => `<option value="${esc(mo.id)}" ${mo.id === sel.model ? 'selected' : ''}>${esc(mo.label ? `${mo.id} · ${mo.label}` : mo.id)}${mo.installed ? '' : ` — ${d.notInstalled}`}</option>`)
      .join('')}</select></span></label>
    ${
      m === 'tts' && voices.length
        ? `<label class="field"><span class="label">${d.voice}</span><span class="select"><select data-voice="${m}">${voices
            .map((v) => `<option ${v === sel.voice ? 'selected' : ''}>${esc(v)}</option>`)
            .join('')}</select></span></label>`
        : ''
    }
    ${cur?.locality === 'cloud' ? `<p class="why"><b>!</b> ${esc(d.cloudNote)}</p>` : ''}
    ${cur?.health?.detail ? `<p class="faint" style="font-size:12px">${esc(cur.health.detail)}</p>` : ''}
    <ul class="provlist">${providers
      .map((p) => {
        const b = blockOf(p, draft.profile);
        return `<li class="${b ? 'off' : ''}"><span class="hdot ${b ? '' : (p.health?.state ?? '')}"></span><span class="nm">${esc(p.label)}</span>${b ? ` <span class="why-off ${b === 'cloud_offline' ? 'cloud' : ''}">· ${esc(blockText(b, p.modality))}</span>` : ''}</li>`;
      })
      .join('')}</ul>
  </section>`;
}

function html(): string {
  const d = t().engines;
  if (s.error) return `<main class="page"><p class="alert alert--err"><b>××</b><span>${esc(s.error)}</span></p></main>`;
  if (!s.engines || !s.draft) return `<main class="page"><p class="dim">${t().loading}</p></main>`;
  const draft = s.draft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.engines.settings);
  const disp = s.engines.dispatcher;
  return `<main class="page">
    <div class="label">${d.kicker}</div>
    <h1 style="margin:var(--s-2) 0 var(--s-3);font-size:34px">${d.title}</h1>
    <p class="dim" style="max-width:46em">${esc(d.lead)}</p>
    <div class="sec-head"><h2>${d.profile}</h2><span class="sp"></span>
      <span class="chrome">${d.dispatcher}: ${disp.active ? esc(disp.active.owner) : d.idle}${disp.queued.length ? ` +${disp.queued.length}` : ''}</span></div>
    <div class="profiles">
      ${(['offline', 'online'] as const)
        .map(
          (p) => `<button class="profile ${draft.profile === p ? 'on' : ''}" data-profile="${p}" aria-pressed="${draft.profile === p}" ${p === 'online' && !anyKey() ? `disabled title="${esc(d.onlineNeedsKey)}"` : ''}>
          <b>${p === 'offline' ? '🔒 ' + d.offlineTitle : d.onlineTitle}</b><span>${p === 'offline' ? d.offlineText : esc(onlineText(draft, s.engines!))}</span></button>`,
        )
        .join('')}
    </div>
    ${!anyKey() ? `<p class="dim">${esc(d.onlineNeedsKey)}</p>` : ''}
    <div class="sec-head"><h2>${t().nav.engines}</h2></div>
    <div class="engines">${MODALITIES.map(modalityCard).join('')}</div>
    <div class="savebar">
      <button id="apply" class="btn" ${s.saving || !dirty ? 'disabled' : ''}>${d.apply}</button>
      <button id="reset" class="btn btn--ghost" ${!dirty ? 'disabled' : ''}>${d.reset}</button>
      ${s.msg ? `<span class="chip chip--ok">${esc(s.msg)}</span>` : ''}
      ${s.issues.length ? `<ul class="issues">${s.issues.map((i) => `<li>×× ${esc(i)}</li>`).join('')}</ul>` : ''}
    </div>
    ${keysSection()}
  </main>`;
}

function keysSection(): string {
  const d = t().engines;
  const rows = s.keys
    .map((k) => {
      const state = k.source === 'env' ? d.keyEnv : k.set ? d.keySet : d.keyUnset;
      return `<div class="key-row">
        <b>${esc(k.label)}</b>
        <span class="chip ${k.set ? 'chip--ok' : ''}">${esc(state)}</span>
        ${
          k.source === 'env'
            ? `<span class="dim">${esc(k.env)}</span>`
            : `<input type="password" autocomplete="off" spellcheck="false" data-key-input="${esc(k.id)}" placeholder="${esc(k.env)}" aria-label="${esc(k.label)}">
               <button class="btn btn--ghost" data-key-save="${esc(k.id)}">${d.keySave}</button>
               ${k.set ? `<button class="btn btn--ghost" data-key-clear="${esc(k.id)}">${d.keyClear}</button>` : ''}`
        }
      </div>`;
    })
    .join('');
  return `<div class="sec-head"><h2>${d.keysTitle}</h2></div>
    <p class="dim" style="max-width:46em">${esc(d.keysLead)}</p>
    <div class="keys">${rows}</div>
    ${s.keyMsg ? `<p class="dim">${esc(s.keyMsg)}</p>` : ''}`;
}

async function load() {
  s.keys = await api.keys().catch(() => []);
  s.engines = await api.engines();
  app.engines = s.engines;
  s.draft = structuredClone(s.engines.settings);
}

export const enginesView: View = {
  async enter() {
    s.error = null;
    s.msg = null;
    s.issues = [];
    try {
      await load();
    } catch (err) {
      s.error = errorText(err);
    }
  },
  html,
  bind(root) {
    const eng = s.engines;
    const draft = s.draft;
    if (!eng || !draft) return;
    root.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach((b) =>
      b.addEventListener('click', () => {
        draft.profile = b.dataset.profile as Settings['profile'];
        const moved = enforceProfile(draft, eng);
        s.issues = [];
        s.msg = moved.length ? moved.join(' · ') : null;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLSelectElement>('[data-prov]').forEach((sel) =>
      sel.addEventListener('change', () => {
        const m = sel.dataset.prov as Modality;
        const p = eng.providers.find((x) => x.modality === m && x.provider === sel.value);
        if (p) draft.engines[m] = { provider: p.provider, model: p.models[0]?.id ?? '', voice: p.models[0]?.voices?.[0] ?? null };
        s.msg = null;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLSelectElement>('[data-model]').forEach((sel) =>
      sel.addEventListener('change', () => {
        draft.engines[sel.dataset.model as Modality].model = sel.value;
        s.msg = null;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLSelectElement>('[data-voice]').forEach((sel) =>
      sel.addEventListener('change', () => {
        draft.engines[sel.dataset.voice as Modality].voice = sel.value;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-key-save]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.dataset.keySave!;
        const input = root.querySelector<HTMLInputElement>(`[data-key-input="${id}"]`);
        const value = input?.value.trim() ?? '';
        if (input) input.value = ''; // the value leaves the page once and is not kept in the DOM
        if (!value) return;
        try {
          s.keys = await api.setKey(id, value);
          await load();
          // A saved key does not switch the profile: in Offline the cloud row stays struck through, so say what to do next.
          s.keyMsg = s.engines?.settings.profile === 'offline' ? t().engines.keySavedOffline : t().engines.keySaved;
        } catch (err) {
          s.keyMsg = errorText(err);
        }
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-key-clear]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          s.keys = await api.clearKey(b.dataset.keyClear!);
          s.keyMsg = t().engines.keyCleared;
          await load();
        } catch (err) {
          s.keyMsg = errorText(err);
        }
        rerender();
      }),
    );
    root.querySelector('#reset')?.addEventListener('click', () => {
      s.draft = structuredClone(eng.settings);
      s.issues = [];
      rerender();
    });
    root.querySelector('#apply')?.addEventListener('click', async () => {
      s.saving = true;
      rerender();
      try {
        const res = await api.saveSettings(draft);
        s.issues = res.ok ? [] : res.issues.map((i) => i.message);
        s.msg = res.ok ? t().engines.applied : null;
        await load();
      } catch (err) {
        s.issues = [errorText(err)];
      }
      s.saving = false;
      rerender();
    });
  },
};
