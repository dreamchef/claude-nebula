# nebula

A point-cloud visualizer for every Claude Code conversation on your machine.

Nebula reads the transcripts under `~/.claude/projects`, embeds every message,
tool call and tool result locally, and lays them out in 3D by **meaning** rather
than by file. Move the cursor and the cloud responds: a lens unfolds the dense
region you are pointing at, the camera eases in, and everything semantically
close to what you are looking at brightens and drifts toward you while the rest
falls away.

It also watches the live `claude` processes on the machine and links each one to
the transcript it is currently writing.

## Run it

```sh
npm install
npm run index   # first run downloads a ~25MB embedding model, then ~3 min for 100 transcripts
npm run dev     # http://localhost:5173
```

`npm run index` is optional — the UI offers to build the index on first load.
Re-running it is cheap: vectors are content-addressed, so only new conversation
is embedded.

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

Faint filaments join consecutive points of the same session, so a single
conversation reads as a thread wandering through the semantic space.

### Controls

- **move the cursor** — the lens follows it; dwell and the camera zooms in while
  related points converge
- **click a point** — pin it, see the session's stats and its nearest neighbours
  in meaning
- **search** — free-text query, embedded and projected into the same space; the
  cloud re-lights around it and the camera flies to the match cluster
- **layout** — *semantic* (meaning), *time* (a helix of sessions in order), or
  *project* (a skyline grouped by repo)
- **colour** — by kind, by session, or by recency
- **lens / focus** — magnification strength and radius
- **adaptive zoom** — toggle the cursor-driven camera; scrolling always wins for
  a moment afterwards

## How it works

```
~/.claude/projects/**/*.jsonl
  └─ transcripts.js   parse into sessions + points
     └─ embed.js      all-MiniLM-L6-v2 via transformers.js, content-addressed cache
        └─ layout.js  randomized PCA -> LSH kNN -> UMAP-style SGD in 3D
           └─ web/    three.js point cloud; lens + semantic gravity in the vertex shader
```

`scan.js` separately walks `ps`, resolves each process's cwd via `lsof`, and
matches it to a transcript.

Everything runs locally. No conversation text leaves the machine — the model
runs on-device and the API binds to `127.0.0.1`. The index lives in `.cache/`,
which is gitignored.

## Layout

| path | |
| --- | --- |
| `server/transcripts.js` | JSONL parsing, point extraction |
| `server/scan.js` | live process discovery |
| `server/embed.js` | on-device embeddings + vector cache |
| `server/layout.js` | PCA, approximate kNN, 3D layout |
| `server/build.js` | index builder |
| `server/index.js` | HTTP API |
| `web/src/cloud.js` | three.js scene and shaders |
| `web/src/main.js` | picking, focus, adaptive camera |
| `web/src/layouts.js` | time and project arrangements |
| `web/src/ui.js` | panels |
