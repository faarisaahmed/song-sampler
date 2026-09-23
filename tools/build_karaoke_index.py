#!/usr/bin/env python3
"""Step 1 of 2: build the raw song list for songs/karaoke-index.json.

Songs come from the Lyrics MIDI Dataset on Hugging Face (CC BY-NC-SA 4.0):
https://huggingface.co/datasets/asigalov61/Lyrics-MIDI-Dataset
It's stored as zip files. Only each zip's central directory gets downloaded
(via HTTP range requests), which lists every file with its byte offset, so the
site can later fetch a single MIDI with one range request.

Sources: the deduplicated folder of the full archive, and the Genius-matched subset.
Output rows: [title, artist, offset, compressed_size, method, source_index]
Step 2 (tools/rate_karaoke_index.mjs) finds each song's melody track and keeps the good ones.
"""
import json, struct, sys, urllib.request

BASE = 'https://huggingface.co/datasets/asigalov61/Lyrics-MIDI-Dataset/resolve/main/'
SOURCES = [
    (BASE + 'Lyrics-MIDI-Dataset-CC-BY-NC-SA.zip', 'MIDIs and Lyrics/Deduped/', 3),
    (BASE + 'Lyrics-MIDI-Genius-Cleaned-Subset-CC-BY-NC-SA.zip', 'MIDIs/', 2),
]
OUT = sys.argv[1] if len(sys.argv) > 1 else 'songs/karaoke-raw.json'


def central_directory(url):
    def rng(a, b):
        return urllib.request.urlopen(urllib.request.Request(url, headers={'Range': f'bytes={a}-{b}'})).read()
    size = int(urllib.request.urlopen(urllib.request.Request(url, method='HEAD')).headers['Content-Length'])
    tail = rng(size - 70000, size - 1)
    i = tail.rfind(b'PK\x05\x06')
    entries = struct.unpack('<H', tail[i + 10:i + 12])[0]
    cd_size, cd_off = struct.unpack('<II', tail[i + 12:i + 20])
    if entries == 0xFFFF or 0xFFFFFFFF in (cd_size, cd_off):
        j = tail.rfind(b'PK\x06\x06')
        entries, cd_size, cd_off = struct.unpack('<QQQ', tail[j + 32:j + 56])
    cd = b''
    for a in range(cd_off, cd_off + cd_size, 8_000_000):
        cd += rng(a, min(cd_off + cd_size, a + 8_000_000) - 1)
    p = 0
    while p + 46 <= len(cd) and cd[p:p + 4] == b'PK\x01\x02':
        method = struct.unpack('<H', cd[p + 10:p + 12])[0]
        csize = struct.unpack('<I', cd[p + 20:p + 24])[0]
        usize = struct.unpack('<I', cd[p + 24:p + 28])[0]
        n, e, c = struct.unpack('<HHH', cd[p + 28:p + 34])
        off = struct.unpack('<I', cd[p + 42:p + 46])[0]
        name = cd[p + 46:p + 46 + n].decode('utf8', 'replace')
        extra = cd[p + 46 + n:p + 46 + n + e]
        q = 0
        while q + 4 <= len(extra):  # zip64 sizes / offset
            hid, hs = struct.unpack('<HH', extra[q:q + 4])
            d, k = extra[q + 4:q + 4 + hs], 0
            if hid == 1:
                if usize == 0xFFFFFFFF: k += 8
                if csize == 0xFFFFFFFF: csize = struct.unpack('<Q', d[k:k + 8])[0]; k += 8
                if off == 0xFFFFFFFF: off = struct.unpack('<Q', d[k:k + 8])[0]; k += 8
            q += 4 + hs
        p += 46 + n + e + c
        yield name, method, csize, off


rows, seen = [], set()
for src, (url, prefix, nparts) in enumerate(SOURCES):
    for name, method, csize, off in central_directory(url):
        if not name.startswith(prefix) or not name.lower().endswith(('.mid', '.midi', '.kar')):
            continue
        parts = name[len(prefix):].rsplit('.', 1)[0].split(' --- ')
        title = parts[0].strip()
        artist = parts[1].strip() if len(parts) >= nparts else ''
        if not title or artist in ('', 'Unknown'):
            continue  # keep songs we can actually name
        key = (title.lower(), artist.lower(), src)
        if key in seen:
            continue
        seen.add(key)
        rows.append([title, artist, off, csize, method, src])

with open(OUT, 'w') as f:
    json.dump({'sources': [s[0] for s in SOURCES], 'songs': rows}, f, ensure_ascii=False, separators=(',', ':'))
print(f'{len(rows)} candidate MIDIs -> {OUT}')
