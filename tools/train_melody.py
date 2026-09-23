"""Train the melody-track scorer used in js/melody.js.

  node tools/extract_melody_features.mjs ... labeled.json
  python3 tools/train_melody.py labeled.json weights.json

Per song, a small tanh MLP scores every track and a softmax over the tracks
is trained to pick the lyric-labeled melody track. 80/20 train/test split.
"""
import json, sys, numpy as np
rng = np.random.default_rng(0)
data = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'labeled.json'))
songs = [(np.array([f['x'] for f in s['feats']]), [f['i'] for f in s['feats']].index(s['label'])) for s in data]
idx = rng.permutation(len(songs)); cut = int(0.8 * len(songs))
train = [songs[i] for i in idx[:cut]]; test = [songs[i] for i in idx[cut:]]
D = songs[0][0].shape[1]; H = 24
params = {'W1': rng.normal(0, 0.3, (D, H)), 'b1': np.zeros(H), 'w2': rng.normal(0, 0.3, H)}
def fwd(P, X):
    h = np.tanh(X @ P['W1'] + P['b1']); return h, h @ P['w2']
def step_all(P, batch, lam=1e-3):
    g = {k: np.zeros_like(v) for k, v in P.items()}; L = 0
    for X, y in batch:
        h, z = fwd(P, X); z = z - z.max(); p = np.exp(z); p /= p.sum(); L -= np.log(p[y] + 1e-12)
        dz = p.copy(); dz[y] -= 1
        g['w2'] += h.T @ dz
        dh = np.outer(dz, P['w2']) * (1 - h * h)
        g['W1'] += X.T @ dh; g['b1'] += dh.sum(0)
    n = len(batch)
    for k in g: g[k] = g[k] / n + 2 * lam * P[k]
    return L / n, g
M = {k: np.zeros_like(v) for k, v in params.items()}; V = {k: np.zeros_like(v) for k, v in params.items()}
for it in range(1, 801):
    batch = [train[i] for i in rng.choice(len(train), 512, replace=False)]
    L, g = step_all(params, batch)
    for k in params:
        M[k] = 0.9 * M[k] + 0.1 * g[k]; V[k] = 0.999 * V[k] + 0.001 * g[k] ** 2
        params[k] -= 0.01 * (M[k] / (1 - 0.9 ** it)) / (np.sqrt(V[k] / (1 - 0.999 ** it)) + 1e-8)
def evaluate(batch):
    acc, conf = [], []
    for X, y in batch:
        _, z = fwd(params, X); p = np.exp(z - z.max()); p /= p.sum(); acc.append(int(p.argmax() == y)); conf.append(p.max())
    return np.array(acc), np.array(conf)
a_tr, _ = evaluate(train); a, c = evaluate(test)
print(f'MLP train acc {a_tr.mean():.3f}  test acc {a.mean():.3f}')
for th in [0.5, 0.6, 0.7, 0.8, 0.9]:
    sel = c >= th; print(f'  p>={th}: keeps {sel.mean()*100:.0f}%, accuracy {a[sel].mean()*100:.1f}%')
json.dump({k: np.round(v, 4).tolist() for k, v in params.items()}, open(sys.argv[2] if len(sys.argv) > 2 else 'melody_mlp.json', 'w'))
