# Video Translator Remote — Chrome Extension

A Chrome side-panel extension that translates and dubs a video with models running on **your own GPU server** (an Intel B70): it transcribes the speech, translates it, re-voices it in the original speaker's voice, and builds a new video with subtitles. Nothing goes to a cloud service.

It is the pipeline of the original `video-translator` script turned into a step-by-step panel, and it reuses the look of [voice-clone-remote](https://github.com/paulchi-intel/voice-clone-remote), [speech-to-text-remote](https://github.com/paulchi-intel/speech-to-text-remote) and [chatter-remote](https://github.com/paulchi-intel/chatter-remote).

## Workflow

| Step | What happens | Service |
|---|---|---|
| 1. Pick video & languages | Choose a video (or audio) file, the source language (or auto-detect) and the target language | — |
| 2. Transcribe | The video is uploaded to the server, the speech is cut into sentences at pauses, each sentence is recognized | `video-translator-server` + Qwen3-ASR |
| 3. Correct & translate | Optionally fix recognition errors and remove fillers, then translate every sentence; both texts are editable | Qwen3.6 (vLLM) |
| 4. Dub | Each translated sentence is read in a cloned voice — taken from a sentence of the video itself, or an uploaded `.wav` | Qwen3-TTS |
| 5. Render | Dubbed clips are placed on the original timeline (sped up a little when they run long), subtitles are burned in or exported, and an MP4 is built | `video-translator-server` (ffmpeg) |

Every step can be stopped and resumed, redone, and every result stays in **History** (kept on the server for 3 days).

## Architecture

```
Chrome extension (your PC)
  sidepanel.js ──HTTP──▶ :17497  video-translator-server   upload, cut sentences, mix, ffmpeg      (CPU)
               ──HTTP──▶ :17495  speech-to-text-asr          Qwen3-ASR 1.7B  (see speech-to-text-remote)
               ──HTTP──▶ :17496  chatter-gateway → vLLM      Qwen3.6-35B-A3B  (see chatter-remote/server)
               ──HTTP──▶ :17494  voice-clone-tts             Qwen3-TTS 1.7B  (see voice-clone-remote)
```

The extension only drives the pipeline. The three model services are the existing ones from the sister projects; this repository adds the fourth service, `video-translator-server`, which does the media work (the browser cannot run ffmpeg).

### `video-translator-server` API (port 17497)

| Endpoint | Description |
|---|---|
| `GET /health` | `{"status":"ok","ffmpeg":"…"}` |
| `POST /jobs` | raw video/audio body, header `X-Filename` → `{"job_id","duration","has_video",…}` (audio is extracted to 16 kHz mono) |
| `POST /jobs/<id>/segment` | cut speech into sentences by silence → `{"segments":[{"i","start","end"}]}` |
| `GET /jobs/<id>/segments/<i>.wav` | one sentence as WAV |
| `PUT /jobs/<id>/clips/<i>` | raw WAV of the dubbed sentence |
| `POST /jobs/<id>/render` | `{"segments":[{"i","start","end","text"}],"burn_subtitles","original_volume","max_speedup"}` — runs in the background |
| `GET /jobs/<id>` | status `{"state","progress","message","outputs"}` |
| `GET /jobs/<id>/download/<name>` | `output.mp4` / `output.m4a`, `subtitles.srt`, `subtitles.vtt`, `dubbed.wav` (Range supported) |
| `DELETE /jobs/<id>` | remove the job |

---

## Server setup

Needs the other three services running (see their READMEs). Then, for this one (CPU only, no GPU):

```bash
mkdir -p ~/video-translator-remote && cd ~/video-translator-remote/server   # copy server/ here first
docker compose up -d --build
curl --noproxy '*' http://<SERVER_IP>:17497/health
```

Settings (environment variables in `docker-compose.yml`): `VT_KEEP_DAYS` (default 3 — jobs older than this are deleted), `VT_MAX_UPLOAD_MB` (default 4096), `VT_SUBTITLE_FONT` (default `Noto Sans CJK TC`).

Notes:
- The service has **no authentication** — anyone who can reach port 17497 can upload files to it. Keep it on a trusted network.
- Uploaded videos and results live in the Docker volume `video-translator-data`.

---

## Extension setup (your PC)

```bash
git clone https://github.com/paulchi-intel/video-translator-remote.git
```

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Click the **Video Translator Remote** icon to open the side panel
5. On first run the ⚙ panel opens — enter the **server address** only (e.g. `10.225.64.11`). The four ports default to ASR 17495, LLM 17496, TTS 17494, video 17497 and can be changed there. Chrome asks permission for those addresses; they are stored only in your browser (`chrome.storage`), never in this repository
6. Wait for the four dots to turn green, then follow the numbered steps

---

## Tips

- **Reference voice:** by default the panel picks a clear sentence of 4–15 s from the video and clones that speaker. Edit its text if recognition got a word wrong — the reference text must match what is actually said. You can also upload a `.wav`.
- **Glossary:** list product names and terms in step 3 (`Lunar Lake`, or `source=translation`); the LLM follows it, both when correcting and translating.
- **Edit before dubbing:** step 3 shows every sentence with its translation. Editing a translation after dubbing marks only that sentence for re-synthesis.
- **Long videos:** dubbing runs one sentence at a time on the GPU, so a 30-minute talk takes a while. You can stop and resume at any point.
- **Speed limit:** a dubbed sentence longer than the original slot is sped up to fit, up to the chosen limit; beyond that it is cut off at the next sentence.

## Update

The panel checks the latest GitHub Release when it opens. When a newer version exists a banner offers to download the ZIP. Chrome cannot update unpacked extensions itself: unzip over your existing folder, then click **Reload** on the extension in `chrome://extensions`. Settings and History stay in `chrome.storage.local`.

## Release

1. Update `version` in `manifest.json` and commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. GitHub Actions ([`release.yml`](.github/workflows/release.yml)) checks the tag against `manifest.json`, checks the JavaScript and the server compile, and publishes `video-translator-remote-vX.Y.Z.zip` with a SHA-256 checksum.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Set the B70 address in ⚙ first" | Open ⚙ and enter the server address |
| One dot stays grey | Hover it to see which service; check its container with `docker ps` and `curl --noproxy '*' http://<SERVER_IP>:<port>/health` (the LLM one: `/v1/models`) |
| "The server no longer has this video" | Jobs are deleted after 3 days (or after a server volume reset). Choose the file again |
| Works with curl but not from Chrome | Your PC's proxy may intercept the server address; add it to the proxy bypass list |
| Burned subtitles show boxes instead of characters | The container needs a font for that script; `fonts-noto-cjk` is installed, or set `VT_SUBTITLE_FONT` |
| Translation count mismatch error | The LLM returned the wrong number of lines twice; the panel halves the batch automatically, press the button again to retry |

---

## License

MIT — see [LICENSE](LICENSE)
