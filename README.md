# nebula

**See what your Claudes are doing, right now.**

Nebula is a live point-cloud view of the Claude Code sessions running on your
machine. Each conversation is its own cloud — never blended with anyone else's —
and the clouds are arranged so that conversations about similar things sit near
each other. Running sessions glow, carry a labelled marker, and grow in real
time as their turns are written.

By default you see **only conversations whose process is still alive**. Active
means the process is running, not that Claude is currently inferring — a session
waiting on you is still yours to keep an eye on. Finished history is indexed and
searchable but not drawn, because including it buried the live work in an order
of magnitude more points. Untick **active only** to see everything.

The cursor drives the view. A lens unfolds whatever dense region you point at,
the camera eases in as you dwell, and everything semantically close to what you
are looking at brightens and drifts toward you while the rest falls away.

## Run it

```sh
npm install
npm run index   # first run downloads a ~25MB embedding model, then ~5 min for 100 transcripts
npm run dev     # http://localhost:5173
```

`npm run index` is optional — the UI offers to build the index on first load.
Re-running it is cheap (~10s): vectors are content-addressed, so only new
conversation is embedded.

## What you are looking at

Every point is one coherent slice of a conversation — a message, a chunk of a
long one, a tool call, or a tool result.

| colour | meaning |
| --- | --- |
| amber | what you typed |
| cyan | what Claude said |
| violet | thinking |
| green | a tool call |
| slate | a tool result |

A turn that has just arrived flares white and settles over about twelve
seconds, so motion in the view means work happening this minute. A ringed label
marks each running session — pinging while turns are landing, quiet when the
session is idle — and the **working now** panel spells out what each one is
doing in words.

### Controls

- **move the cursor** — the lens follows it; dwell and the camera zooms in while
  related points converge
- **click a point** — pin it, see the session's stats and its nearest neighbours
  in meaning
- **search** — free-text query, embedded and projected into the same space; the
  cloud re-lights around it and the camera flies to the match cluster
- **layout** — *semantic* (a constellation of conversations, placed by what they
  are about), *time* (a helix of sessions in order), or *project* (a skyline
  grouped by repo)
- **colour** — by kind, by session, or by recency
- **lens / focus** — magnification strength and radius
- **follow live** — open on, and fly to, the conversations that are running
- **active only** — on by default; show only conversations whose process is
  still running, scaled up to fill the space they reclaim
- **adaptive zoom** — toggle the cursor-driven camera; scrolling always wins for
  a moment afterwards

## What a point means

Each point is embedded **in the context of the request it belongs to** — the
human turn is prepended to the block before embedding, while the text you see is
still the block itself. On its own, a reply like *"ok, that works"* carries
almost no meaning and lands wherever short acknowledgements happen to cluster;
paired with the question it answers, it lands with the work it is about. Two
byte-identical replies in different conversations sit at cosine 0.05 rather
than 1.0.

## How it works

```
~/.claude/projects/**/*.jsonl
  ├─ transcripts.js   parse into sessions + points
  │   └─ embed.js     all-MiniLM-L6-v2 via transformers.js, content-addressed cache
  │      └─ layout.js randomized PCA -> LSH kNN -> UMAP-style SGD, per conversation
  │         └─ web/   three.js point cloud; lens + semantic gravity in the vertex shader
  └─ live.js          tails running sessions, projects each new turn into the
                      same space, streams it over SSE
```

The reduction is deliberately not a straight projection to 3D. A 384-d MiniLM
vector is reduced by randomized PCA to 64-d — that is the space search and the
similarity lens work in — and only then laid out in 3D by a UMAP-style
neighbour-preserving SGD. Projecting linearly to 3D would keep just the three
highest-variance directions and collapse everything else, so points that merely
happen to agree on those axes would pile up together. The SGD instead optimises
the thing you actually want on screen: near in 3D means near in meaning, which
is what makes zooming into a region coherent.

The semantic layout is deliberately two-level. Laying out every point at once
would interleave unrelated sessions, so a dense region could mix half a dozen
conversations and read as one thing. Instead each conversation is laid out on
its own and becomes a discrete island; the islands are positioned by the
similarity of their centroids and pushed apart until none overlap.

`scan.js` separately walks `ps`, resolves each process's cwd via `lsof`, and
matches it to the transcript it is writing.

Everything runs locally. No conversation text leaves the machine — the model
runs on-device and the API binds to `127.0.0.1`. The index lives in `.cache/`,
which is gitignored.

## Layout

| path | |
| --- | --- |
| `server/transcripts.js` | JSONL parsing, point extraction |
| `server/scan.js` | live process discovery |
| `server/live.js` | tails running sessions, projects new turns |
| `server/embed.js` | on-device embeddings + vector cache |
| `server/layout.js` | PCA, approximate kNN, per-conversation island layout |
| `server/build.js` | index builder |
| `server/index.js` | HTTP API + SSE stream |
| `web/src/cloud.js` | three.js scene and shaders |
| `web/src/live.js` | growable point store, live feed |
| `web/src/main.js` | picking, focus, adaptive camera, labels |
| `web/src/layouts.js` | time and project arrangements |
| `web/src/ui.js` | panels |

`window.__nebula` exposes `{ state, cloud, frame }` in the browser console for
poking at the view.
