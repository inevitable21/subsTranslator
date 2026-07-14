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

// Stremio streaming server 4.x returns a FLAT streams[] array discriminated by
// codec_type, reached via GET /probe?url=<encoded>. Verified against server 4.21.0.
test('probeEnglishSub uses /probe?url= and finds english text track in flat streams[]', async () => {
  let calledUrl = null;
  const probe = { streams: [
    { codec_type: 'video', codec_name: 'hevc', stream: 0 },
    { codec_type: 'audio', codec_name: 'ac3', stream: 1, lang: 'eng' },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', stream: 2, lang: 'eng' }, // sub-rel 0, image -> skip
    { codec_type: 'subtitle', codec_name: 'subrip', stream: 3, lang: 'eng' },            // sub-rel 1, match
  ] };
  const fetchFn = async (url) => { calledUrl = url; return { ok: true, json: async () => probe }; };
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { trackIndex: 1, codec: 'subrip' });
  assert.match(calledUrl, /\/probe\?url=/); // query-param endpoint, not /probe/<path>
});

test('probeEnglishSub returns null when all subtitle tracks are PGS image (real BDRIP case)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', stream: 4, lang: 'eng' },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', stream: 5, lang: 'fre' },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', stream: 6, lang: 'spa' },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('probeEnglishSub returns null when no english subtitle (flat shape)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'subrip', stream: 2, lang: 'spa' },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('probeEnglishSub matches english by title when lang absent (flat shape)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'ass', stream: 2, tags: { title: 'English (Full)' } },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r.trackIndex, 0);
});

test('probeEnglishSub still supports nested streams.subtitles (older server fallback)', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }, // rel 0, image -> skip
    { codec: 'subrip', tags: { language: 'eng' } },            // rel 1, match
  ] } };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { trackIndex: 1, codec: 'subrip' });
});

test('probeEnglish returns both text and image english tracks (flat streams[])', () => {
  return (async () => {
    const probe = { streams: [
      { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'eng' }, // s:0 image
      { codec_type: 'subtitle', codec_name: 'subrip', lang: 'eng' },            // s:1 text
    ] };
    const fetchFn = mockFetchJson({ '/probe': probe });
    const r = await embedded.probeEnglish('http://s/H/0', { fetchFn, base: 'http://s' });
    assert.deepStrictEqual(r.text, { trackIndex: 1, codec: 'subrip' });
    assert.deepStrictEqual(r.image, { trackIndex: 0, codec: 'hdmv_pgs_subtitle' });
  })();
});

test('probeEnglish returns image only for a PGS-only file (Wakfu case)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'eng' },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'fre' },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglish('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r.text, null);
  assert.deepStrictEqual(r.image, { trackIndex: 0, codec: 'hdmv_pgs_subtitle' });
});

test('probeEnglishSub still returns just the text track (delegates to probeEnglish)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'subrip', lang: 'eng' },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { trackIndex: 0, codec: 'subrip' });
});

test('findStream reports via deps.log when no file matches videoSize', async () => {
  const stats = { H1: { files: [{ name: 'a.mkv', length: 999 }] } };
  const logs = [];
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 123, filename: 'a.mkv' },
    { fetchFn, base: 'http://s', log: (m) => logs.push(m) });
  assert.strictEqual(r, null);
  assert.ok(logs.some(m => /no active file matches/i.test(m)), 'should log the reason');
});

test('probeEnglishSub reports via deps.log why no english text track (PGS case)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'eng' },
  ] };
  const logs = [];
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0',
    { fetchFn, base: 'http://s', log: (m) => logs.push(m) });
  assert.strictEqual(r, null);
  assert.ok(logs.some(m => /IMAGE track/i.test(m)), 'should log that only image track was found');
  assert.ok(logs.some(m => /hdmv_pgs_subtitle/i.test(m)), 'should list the tracks it saw');
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

test('extractCueOnsets parses ffprobe pts_time CSV into sorted seconds', async () => {
  let capturedArgs = null;
  const execFileFn = (bin, args, opts, cb) => {
    capturedArgs = args;
    cb(null, '85.962000\n1390.348000\n120.500000\n', '');
  };
  const r = await embedded.extractCueOnsets({ mediaUrl: 'http://s/H/6', trackIndex: 0 },
    { execFileFn, ffprobePath: 'ffprobe' });
  assert.deepStrictEqual(r, [85.962, 120.5, 1390.348]);
  assert.ok(capturedArgs.includes('s:0'), 'selects subtitle-relative stream');
});

test('extractCueOnsets returns [] on empty/garbage output', async () => {
  const execFileFn = (bin, args, opts, cb) => cb(null, 'N/A\n\nnotanumber\n', '');
  const r = await embedded.extractCueOnsets({ mediaUrl: 'http://s/H/6', trackIndex: 0 },
    { execFileFn, ffprobePath: 'ffprobe' });
  assert.deepStrictEqual(r, []);
});

test('extractCueOnsets returns [] when ffprobe errors', async () => {
  const execFileFn = (bin, args, opts, cb) => cb(new Error('spawn failed'), '', 'boom');
  const r = await embedded.extractCueOnsets({ mediaUrl: 'http://s/H/6', trackIndex: 0 },
    { execFileFn, ffprobePath: 'ffprobe' });
  assert.deepStrictEqual(r, []);
});
