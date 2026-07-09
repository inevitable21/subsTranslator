'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { translateCues, translateText, parseGoogleResponse } = require('../translate');

test('parseGoogleResponse concatenates segments', () => {
  const json = [[['שלום ', 'Hello ', null], ['עולם', 'world', null]], null, 'en'];
  assert.strictEqual(parseGoogleResponse(json), 'שלום עולם');
});

test('translateText sends the text in the POST body, not the URL', async () => {
  let captured;
  const fetchFn = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => [[['שלום', 'hello', null]]] };
  };
  const out = await translateText('hello', 'he', 'auto', fetchFn);
  assert.strictEqual(out, 'שלום');
  assert.strictEqual(captured.opts.method, 'POST');
  assert.ok(captured.opts.body.includes('q=hello'), 'body should carry the text');
  assert.ok(!captured.url.includes('q=hello'), 'URL must not carry the text');
  assert.match(captured.opts.headers['Content-Type'], /x-www-form-urlencoded/);
});

test('translateCues reports failed chunks via stats', async () => {
  const cues = [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }];
  const fn = async () => { throw new Error('x'); };
  const stats = {};
  await translateCues(cues, { translateFn: fn, batchSize: 1, stats });
  assert.strictEqual(stats.totalChunks, 2);
  assert.strictEqual(stats.failedChunks, 2);
});

test('translateCues reports zero failed chunks on success', async () => {
  const cues = [{ start: 0, end: 1, text: 'a' }];
  const stats = {};
  await translateCues(cues, { translateFn: async (t) => 'T:' + t, batchSize: 1, stats });
  assert.strictEqual(stats.failedChunks, 0);
});

test('translateCues maps translations back to cues', async () => {
  const cues = [
    { start: 0, end: 1000, text: 'Hello' },
    { start: 1000, end: 2000, text: 'World' },
  ];
  const fn = async (t) => t.split('\n').map(l => 'X:' + l).join('\n');
  const out = await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(out[0].text, 'X:Hello');
  assert.strictEqual(out[1].text, 'X:World');
});

test('translateCues falls back to per-cue on line-count mismatch', async () => {
  const cues = [
    { start: 0, end: 1000, text: 'Hello' },
    { start: 1000, end: 2000, text: 'World' },
  ];
  const fn = async (t) => (t.includes('\n') ? 'collapsed' : 'T:' + t);
  const out = await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(out[0].text, 'T:Hello');
  assert.strictEqual(out[1].text, 'T:World');
});

test('translateCues keeps original text when translation fails', async () => {
  const cues = [{ start: 0, end: 1000, text: 'Hello' }];
  const fn = async () => { throw new Error('boom'); };
  const out = await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(out[0].text, 'Hello');
});

test('translateCues flattens internal newlines before sending', async () => {
  const cues = [{ start: 0, end: 1000, text: 'Line A\nLine B' }];
  let received;
  const fn = async (t) => { received = t; return t; };
  await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(received, 'Line A Line B');
});
