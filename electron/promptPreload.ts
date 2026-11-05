/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The password window's only code. Everything is drawn from here, in the
// preload's isolated world, and the page itself runs no script at all (its CSP
// forbids one). No `window.krypt`, nothing exposed to the page, and the typed
// text goes straight to main. Nothing else in the app can read this window or
// ask main to take a password.

import { ipcRenderer } from 'electron';
import type { PromptSpec } from '@shared/vault';

type Reply = { error?: string; next?: PromptSpec; done?: boolean };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fit(): void {
  // The body, not the document: the document is never shorter than the window,
  // and a screen with less on it should not sit in a window sized for the last.
  ipcRenderer.send('prompt:size', Math.ceil(document.body.getBoundingClientRect().height));
}

function draw(spec: PromptSpec): void {
  document.body.replaceChildren();
  const form = el('form', 'box');
  form.autocomplete = 'off';
  form.append(el('h1', spec.danger ? 'danger' : '', spec.title));
  for (const line of spec.lines) form.append(el('p', '', line));
  if (spec.warn) form.append(el('p', 'warn', spec.warn));
  if (spec.code) form.append(el('div', 'code', spec.code));

  const inputs = new Map<string, HTMLInputElement>();
  for (const f of spec.fields) {
    const label = el('label', '', f.label);
    const input = el('input', '');
    input.type = f.secret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.field = f.id;
    label.append(input);
    form.append(label);
    inputs.set(f.id, input);
  }

  const error = el('p', 'error');
  error.dataset.role = 'error';
  form.append(error);

  const buttons = el('div', 'buttons');
  const cancel = el('button', 'ghost', spec.cancel ?? '');
  cancel.type = 'button';
  cancel.dataset.role = 'cancel';
  if (spec.cancel) buttons.append(cancel);
  const submit = el('button', spec.danger ? 'primary danger-button' : 'primary', spec.submit);
  submit.type = 'submit';
  submit.dataset.role = 'submit';
  buttons.append(submit);
  form.append(buttons);

  const links = el('div', 'links');
  const setBusy = (busy: boolean): void => {
    submit.disabled = busy;
    cancel.disabled = busy;
    submit.textContent = busy ? 'Working…' : spec.submit;
  };
  const answer = (reply: Reply): void => {
    for (const input of inputs.values()) if (reply.next) input.value = '';
    if (reply.next) return draw(reply.next);
    setBusy(false);
    error.textContent = reply.error ?? '';
    fit();
    // Selected, so retyping replaces what was refused. Added to dots nobody can
    // read, it would be refused again and count against the retry limit.
    const first = inputs.values().next().value;
    first?.focus();
    first?.select();
  };
  for (const l of spec.links ?? []) {
    const a = el('button', 'link', l.label);
    a.type = 'button';
    a.dataset.link = l.id;
    a.addEventListener('click', () => void ipcRenderer.invoke('prompt:link', l.id).then(answer));
    links.append(a);
  }
  if (spec.links?.length) form.append(links);

  cancel.addEventListener('click', () => ipcRenderer.send('prompt:cancel'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const values: Record<string, string> = {};
    for (const [id, input] of inputs) values[id] = input.value;
    error.textContent = '';
    setBusy(true);
    void ipcRenderer.invoke('prompt:submit', values).then(answer);
  });
  document.body.append(form);
  (inputs.values().next().value ?? submit).focus();
  fit();
}

// Main ignores this on a screen with no Cancel.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('prompt:cancel');
});

window.addEventListener('DOMContentLoaded', () => {
  void ipcRenderer.invoke('prompt:init').then((spec: PromptSpec | null) => {
    if (spec) draw(spec);
  });
});
