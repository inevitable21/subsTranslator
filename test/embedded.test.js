'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const embedded = require('../embedded');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (stdout) child.stdout.write(Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.write(Buffer.from(stderr, 'utf8'));
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    });
    return child;
  };
}

test('parseExtra extracts filename, videoSize, videoHash', () => {
  const r = embedded.parseExtra('filename=Wakfu S01E06.mkv&videoSize=434828263&videoHash=3324c29ac710a548');
  assert.strictEqual(r.filename, 'Wakfu S01E06.mkv');
  assert.strictEqual(r.videoSize, 434828263);
  assert.strictEqual(r.videoHash, '3324c29ac710a548');
});

test('parseExtra returns nulls when fields absent', () => {
  const r = embedded.parseExtra('');
  assert.strictEqual(r.filename, null);
  assert.strictEqual(r.videoSize, null);
  assert.strictEqual(r.videoHash, null);
});

test('parseExtra handles videoSize/videoHash without filename', () => {
  const r = embedded.parseExtra('videoSize=100&videoHash=abcdef01');
  assert.strictEqual(r.filename, null);
  assert.strictEqual(r.videoSize, 100);
  assert.strictEqual(r.videoHash, 'abcdef01');
});

function mockFetchJson(map) {
  // map: { urlSubstring: jsonValue | { status } }
  return async (url) => {
    for (const key of Object.keys(map)) {
      if (String(url).includes(key)) {
        const v = map[key];
        if (v && typeof v === 'object' && 'status' in v && v.status >= 400) {
          return { ok: false, status: v.status, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => v };
      }
    }
    throw new Error('unexpected url ' + url);
  };
}

test('findStream matches file by exact videoSize', async () => {
  const stats = {
    HASHA: { files: [{ name: 'a.mkv', length: 111 }, { name: 'b.mkv', length: 222 }] },
  };
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 222, filename: 'b.mkv' },
    { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { infoHash: 'HASHA', fileIdx: 1, mediaUrl: 'http://s/HASHA/1' });
});

test('findStream uses filename basename as tiebreaker on equal sizes', async () => {
  const stats = {
    H1: { files: [{ name: 'wrong.mkv', length: 500 }] },
    H2: { files: [{ name: 'dir/right.mkv', length: 500 }] },
  };
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 500, filename: 'x/right.mkv' },
    { fetchFn, base: 'http://s' });
  assert.strictEqual(r.infoHash, 'H2');
});

test('findStream returns null when no size matches (debrid case)', async () => {
  const stats = { H1: { files: [{ name: 'a.mkv', length: 999 }] } };
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 123, filename: 'a.mkv' },
    { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('findStream returns null on stats fetch error', async () => {
  const fetchFn = mockFetchJson({ '/stats.json': { status: 500 } });
  const r = await embedded.findStream({ videoSize: 1, filename: 'a' },
    { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('findStream returns null when videoSize missing', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await embedded.findStream({ videoSize: null, filename: 'a' }, { fetchFn });
  assert.strictEqual(r, null);
  assert.strictEqual(called, false); // early-out, no network
});

test('probeEnglishSub returns subtitle-relative index of english subrip', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }, // rel 0, image -> skip
    { codec: 'subrip', tags: { language: 'eng' } },            // rel 1, match
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { trackIndex: 1, codec: 'subrip' });
});

test('probeEnglishSub matches english by title when language tag missing', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'ass', tags: { title: 'English (Full)' } },
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r.trackIndex, 0);
});

test('probeEnglishSub returns null when only image tracks', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('probeEnglishSub returns null when no english track', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'subrip', tags: { language: 'spa' } },
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('extractSrt resolves with stdout buffer on exit 0', async () => {
  const srtText = '1\n00:00:01,000 --> 00:00:02,000\nHello';
  const out = await embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 1 },
    { spawnFn: fakeSpawn({ stdout: srtText, code: 0 }), ffmpegPath: 'ffmpeg' });
  assert.strictEqual(out.toString('utf8'), srtText);
});

test('extractSrt rejects on non-zero exit', async () => {
  await assert.rejects(
    embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 0 },
      { spawnFn: fakeSpawn({ stdout: '', code: 1 }), ffmpegPath: 'ffmpeg' })
  );
});

test('extractSrt rejects on empty output', async () => {
  await assert.rejects(
    embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 0 },
      { spawnFn: fakeSpawn({ stdout: '', code: 0 }), ffmpegPath: 'ffmpeg' })
  );
});

test('extractSrt builds a subtitle-relative -map selector', async () => {
  let capturedArgs = null;
  const spawnFn = (bin, args) => {
    capturedArgs = args;
    return fakeSpawn({ stdout: 'x', code: 0 })();
  };
  await embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 2 },
    { spawnFn, ffmpegPath: 'ffmpeg' });
  assert.ok(capturedArgs.includes('0:s:2'), 'uses subtitle-relative map index');
});

test('extractSrt still resolves when ffmpeg writes large stderr', async () => {
  const bigErr = 'x'.repeat(200000); // exceeds a real OS pipe buffer
  const out = await embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 0 },
    { spawnFn: fakeSpawn({ stdout: 'SRT', stderr: bigErr, code: 0 }), ffmpegPath: 'ffmpeg' });
  assert.strictEqual(out.toString('utf8'), 'SRT');
});

test('extractSrt rejects on non-zero exit even with non-empty stdout', async () => {
  await assert.rejects(
    embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 0 },
      { spawnFn: fakeSpawn({ stdout: 'partial', code: 3 }), ffmpegPath: 'ffmpeg' }),
    /exit=3/
  );
});

test('detectEmbeddedEnglish returns mediaUrl + trackIndex when found', async () => {
  const r = await embedded.detectEmbeddedEnglish({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => ({ trackIndex: 1, codec: 'subrip' }),
  });
  assert.deepStrictEqual(r, { mediaUrl: 'http://s/H/0', trackIndex: 1, codec: 'subrip' });
});

test('detectEmbeddedEnglish returns null when stream not found', async () => {
  const r = await embedded.detectEmbeddedEnglish({ videoSize: 10, filename: 'a' }, {
    findStream: async () => null,
    probeEnglishSub: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(r, null);
});

test('detectEmbeddedEnglish returns null when no english track', async () => {
  const r = await embedded.detectEmbeddedEnglish({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => null,
  });
  assert.strictEqual(r, null);
});

test('getEmbeddedSubtitle returns bytes on success', async () => {
  const r = await embedded.getEmbeddedSubtitle({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => ({ trackIndex: 0, codec: 'subrip' }),
    extractSrt: async () => Buffer.from('SRT', 'utf8'),
  });
  assert.strictEqual(r.lang, 'eng');
  assert.strictEqual(r.bytes.toString('utf8'), 'SRT');
});

test('getEmbeddedSubtitle returns null when extraction throws', async () => {
  const r = await embedded.getEmbeddedSubtitle({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => ({ trackIndex: 0, codec: 'subrip' }),
    extractSrt: async () => { throw new Error('ffmpeg failed'); },
  });
  assert.strictEqual(r, null);
});

test('getEmbeddedSubtitle returns null when detection fails', async () => {
  const r = await embedded.getEmbeddedSubtitle({ videoSize: 10, filename: 'a' }, {
    findStream: async () => null,
  });
  assert.strictEqual(r, null);
});
