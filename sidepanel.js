// sidepanel.js — Video Translator Remote Chrome Extension
// Transcribe (Qwen3-ASR) → translate (Qwen3.6 via vLLM) → dub (Qwen3-TTS) → render (ffmpeg),
// all on a B70 server. This panel only drives the pipeline.

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const HEALTH_POLL_MS = 5000;
const DEFAULT_PORTS  = { asr: '17495', llm: '17496', tts: '17494', vt: '17497' };
const LLM_BATCH_LINES = 12;
const LLM_BATCH_CHARS = 2400;
const SAVE_DEBOUNCE_MS = 300;

// Passed by background.js when opening in popup mode (?srcWindowId=N)
const POPUP_SRC_WINDOW_ID = (() => {
  const id = parseInt(new URLSearchParams(window.location.search).get('srcWindowId'), 10);
  return Number.isFinite(id) ? id : null;
})();

// ── SVG icons ────────────────────────────────────────────────────────────────
const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  remove: `<svg class="hb-icon" ${SVG_ATTRS} stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  popup:  `<svg class="hb-icon" ${SVG_ATTRS}><rect x="3" y="8" width="13" height="12" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3"/></svg>`,
  sidepanel: `<svg class="hb-icon" ${SVG_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M14 5v14"/></svg>`,
};

// ── Languages ────────────────────────────────────────────────────────────────
// code → [native label, English name for prompts]
const LANGS = {
  'zh-TW': ['繁體中文', 'Traditional Chinese (Taiwan usage)'],
  'zh-CN': ['简体中文', 'Simplified Chinese'],
  zh: ['中文', 'Chinese'],
  en: ['English', 'English'],
  ja: ['日本語', 'Japanese'],
  ko: ['한국어', 'Korean'],
  de: ['Deutsch', 'German'],
  fr: ['Français', 'French'],
  es: ['Español', 'Spanish'],
  ru: ['Русский', 'Russian'],
  pt: ['Português', 'Portuguese'],
  it: ['Italiano', 'Italian'],
};
const SRC_LANGS = ['auto', 'zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt', 'it'];
const TGT_LANGS = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt', 'it'];
const ttsLang = (code) => (code === 'zh-TW' || code === 'zh-CN' ? 'zh' : code);

// ── i18n translations ────────────────────────────────────────────────────────
const TRANSLATIONS = {
  en: {
    'btn-auto': 'Translate automatically', 'btn-auto-resume': 'Continue automatically',
    'opt-pause': 'Pause after translating so I can check the translation',
    'auto-hint': 'Runs every remaining step with the settings shown here and the defaults.',
    'auto-running': 'Auto {n}/4: {name}', 'auto-paused': 'Paused — check the translation, then press “Continue automatically” (or Dub).',
    's-ref': ' · voice #{n}',
    'status-checking': 'Checking B70…',
    'status-ready': 'B70 ready — ASR · LLM · TTS · video',
    'status-loading': 'B70 is still loading a model…',
    'status-partial': 'Not ready: {list}',
    'status-no-server': 'Set the B70 address in ⚙ first',
    'status-working': 'Working…',
    'retry-backend': 'Retry',
    'label-server': 'B70',
    'svc-asr': 'ASR', 'svc-llm': 'LLM', 'svc-tts': 'TTS', 'svc-vt': 'Video',
    'server-settings': 'Server settings',
    'tab-setup': 'Workflow', 'tab-queue': 'History',
    'step1-title': 'Pick video & languages',
    'step2-title': 'Transcribe',
    'step3-title': 'Correct & translate',
    'step4-title': 'Dub',
    'step5-title': 'Render video',
    'step1-hint': 'The video is uploaded to your B70 in the next step and goes nowhere else.',
    'step2-hint': 'Speech is cut into sentences at pauses and recognized one by one, so every subtitle has a time.',
    'step4-hint': 'Pick a voice sample; Qwen3-TTS reads the translation in that voice.',
    'drop-label': 'Drop a video here',
    'drop-hint': 'or click to browse (mp4 / mkv / mov / webm / audio)',
    'label-src': 'From', 'label-tgt': 'To',
    'lang-auto': 'Auto-detect',
    'btn-asr': 'Start transcribing', 'btn-asr-again': 'Transcribe again',
    'btn-translate': 'Start translating', 'btn-translate-again': 'Translate again',
    'btn-dub': 'Synthesize dub', 'btn-dub-again': 'Dub again',
    'btn-render': 'Build video', 'btn-render-again': 'Build again',
    'btn-stop': 'Stop',
    'opt-clean': 'First fix recognition errors and remove fillers (um, uh, …)',
    'glossary-hint': 'Glossary (optional): one per line, or “source=translation”. The LLM will follow it.',
    'glossary-placeholder': 'Lunar Lake\nXe2=Xe2',
    'seg-edit-hint': 'You can edit both texts; the translation is used for subtitles and dubbing.',
    'opt-burn': 'Burn subtitles into the picture (re-encodes, slower)',
    'label-origvol': 'Original audio', 'vol-mute': 'Mute',
    'label-speed': 'Max speed-up', 'speed-off': 'Off',
    'speed-hint': 'When a dubbed line is longer than the original, it is sped up to fit (up to this limit).',
    'ref-from-video': 'Use a voice from the video (keeps the original speaker)',
    'ref-from-upload': 'Upload a reference voice (.wav)',
    'ref-drop-label': 'Drop or click to choose a .wav',
    'ref-text-hint': 'What the reference voice says:',
    'ref-text-placeholder': 'The exact words spoken in the reference audio',
    'missing-prefix': 'Still needed: ',
    'list-sep': ', ',
    'ready-asr': 'Ready — press “Start transcribing”.',
    'ready-translate': 'Ready — press “Start translating”.',
    'ready-dub': 'Ready — press “Synthesize dub”.',
    'ready-render': 'Ready — press “Build video”.',
    'm-video': 'a video', 'm-asr': 'transcription', 'm-translate': 'translation', 'm-dub': 'dubbing',
    'm-ref': 'a reference voice', 'm-reftext': 'reference text',
    'm-svc-vt': 'video service', 'm-svc-asr': 'ASR service', 'm-svc-llm': 'LLM service', 'm-svc-tts': 'TTS service',
    'p-upload': 'Uploading {pct}%', 'p-prepare': 'Extracting audio and cutting sentences…',
    'p-asr': 'Transcribing {n}/{total}', 'p-clean': 'Correcting {n}/{total}', 'p-translate': 'Translating {n}/{total}',
    'p-dub': 'Dubbing {n}/{total}', 'p-render': 'Building video… {pct}%',
    's-segments': '{n} sentences', 's-dubbed': '{n} clips', 's-video': 'video ready',
    'err-job-gone': 'The server no longer has this video. Choose the file again.',
    'err-no-segments': 'No speech was found in this file.',
    'err-llm': 'The translation service returned something unexpected: ',
    'err-stopped': 'Stopped. Press the button again to continue where it left off.',
    'confirm-redo': 'This replaces the results of this step and the steps after it. Continue?',
    'confirm-new': 'Start a new project? The current one stays in History.',
    'dl-video': 'Download video', 'dl-audio': 'Download audio', 'dl-srt': 'SRT', 'dl-vtt': 'VTT', 'dl-wav': 'Dub WAV',
    'queue-empty': 'No translated videos yet. Pick a video in the Workflow tab.',
    'queue-go-setup': 'Go to Workflow',
    'h-open': 'Open', 'h-delete': 'Delete', 'h-steps': '{n}/5 steps', 'h-done': 'Done', 'h-running': 'Working',
    'update-available': 'New version available: Video Translator Remote v{version}',
    'update-download': 'Download', 'update-downloading': 'Downloading…',
    'update-downloaded': 'Downloaded. Unzip over the old files, then Reload in chrome://extensions.',
    'update-show': 'Show in folder',
    'update-failed': 'Download failed — opened the release page instead.',
    'update-dismiss': 'Dismiss this version',
    'panel-mode-to-popup': 'Switch to popup', 'panel-mode-to-sidepanel': 'Switch to side panel',
    'play': 'Play',
  },
  'zh-TW': {
    'btn-auto': '全自動翻譯', 'btn-auto-resume': '繼續全自動',
    'opt-pause': '翻譯後暫停，讓我先檢查譯文',
    'auto-hint': '用目前的設定與預設值，把剩下的步驟一路跑完。',
    'auto-running': '全自動 {n}/4：{name}', 'auto-paused': '已暫停：請檢查譯文，再按「繼續全自動」（或「合成配音」）。',
    's-ref': ' · 聲音 #{n}',
    'status-checking': '檢查 B70 中…',
    'status-ready': 'B70 就緒 — 辨識 · 翻譯 · 配音 · 影片',
    'status-loading': 'B70 還在載入模型…',
    'status-partial': '尚未就緒：{list}',
    'status-no-server': '請先在 ⚙ 設定 B70 位址',
    'status-working': '處理中…',
    'retry-backend': '重試',
    'label-server': 'B70',
    'svc-asr': '辨識', 'svc-llm': '翻譯', 'svc-tts': '配音', 'svc-vt': '影片',
    'server-settings': '伺服器設定',
    'tab-setup': '流程', 'tab-queue': '歷史',
    'step1-title': '選擇影片與語言',
    'step2-title': '語音辨識',
    'step3-title': '校正與翻譯',
    'step4-title': '配音',
    'step5-title': '輸出影片',
    'step1-hint': '影片會在下一步上傳到你的 B70，不會送到別的地方。',
    'step2-hint': '依停頓把語音切成句子，再逐句辨識，這樣每句字幕都有時間點。',
    'step4-hint': '選一段聲音當參考，Qwen3-TTS 會用這個聲音唸出譯文。',
    'drop-label': '拖曳影片到這裡',
    'drop-hint': '或點擊選擇檔案（mp4 / mkv / mov / webm / 音訊）',
    'label-src': '原語言', 'label-tgt': '翻譯成',
    'lang-auto': '自動偵測',
    'btn-asr': '開始辨識', 'btn-asr-again': '重新辨識',
    'btn-translate': '開始翻譯', 'btn-translate-again': '重新翻譯',
    'btn-dub': '合成配音', 'btn-dub-again': '重新配音',
    'btn-render': '合成影片', 'btn-render-again': '重新合成',
    'btn-stop': '停止',
    'opt-clean': '先校正辨識錯誤並去除贅字（嗯、啊、那個…）',
    'glossary-hint': '專有名詞表（選填）：一行一個，可寫成「原文=譯文」，LLM 會照著用。',
    'glossary-placeholder': 'Lunar Lake\nXe2=Xe2',
    'seg-edit-hint': '可直接修改原文與譯文，翻譯後的內容會用在字幕與配音。',
    'opt-burn': '把字幕燒進畫面（重新編碼，較慢）',
    'label-origvol': '原音', 'vol-mute': '靜音',
    'label-speed': '語速上限', 'speed-off': '不加速',
    'speed-hint': '配音比原句長時，會自動加快語速來對齊（最多到上限）。',
    'ref-from-video': '用影片裡的聲音當參考（保留原講者的聲音）',
    'ref-from-upload': '上傳參考聲音（.wav）',
    'ref-drop-label': '拖曳或點擊選擇 .wav',
    'ref-text-hint': '參考聲音實際說的內容：',
    'ref-text-placeholder': '參考音檔中實際說的話',
    'missing-prefix': '還需要：',
    'list-sep': '、',
    'ready-asr': '都準備好了，按「開始辨識」。',
    'ready-translate': '都準備好了，按「開始翻譯」。',
    'ready-dub': '都準備好了，按「合成配音」。',
    'ready-render': '都準備好了，按「合成影片」。',
    'm-video': '影片', 'm-asr': '完成語音辨識', 'm-translate': '完成翻譯', 'm-dub': '完成配音',
    'm-ref': '參考聲音', 'm-reftext': '參考文字',
    'm-svc-vt': '影片服務', 'm-svc-asr': '辨識服務', 'm-svc-llm': '翻譯服務', 'm-svc-tts': '配音服務',
    'p-upload': '上傳中 {pct}%', 'p-prepare': '抽出音訊並切句中…',
    'p-asr': '辨識 {n}/{total}', 'p-clean': '校正 {n}/{total}', 'p-translate': '翻譯 {n}/{total}',
    'p-dub': '配音 {n}/{total}', 'p-render': '合成影片中… {pct}%',
    's-segments': '{n} 句', 's-dubbed': '{n} 段配音', 's-video': '影片完成',
    'err-job-gone': '伺服器上已沒有這支影片，請重新選擇檔案。',
    'err-no-segments': '這個檔案裡找不到語音。',
    'err-llm': '翻譯服務回傳了無法解析的內容：',
    'err-stopped': '已停止。再按一次按鈕就會從中斷處繼續。',
    'confirm-redo': '這會覆蓋這一步與之後各步驟的結果，要繼續嗎？',
    'confirm-new': '要開始新專案嗎？目前的專案會留在「歷史」。',
    'dl-video': '下載影片', 'dl-audio': '下載音訊', 'dl-srt': 'SRT 字幕', 'dl-vtt': 'VTT 字幕', 'dl-wav': '配音 WAV',
    'queue-empty': '還沒有翻譯過的影片。到「流程」頁選一支影片開始吧。',
    'queue-go-setup': '前往流程',
    'h-open': '開啟', 'h-delete': '刪除', 'h-steps': '{n}/5 步', 'h-done': '已完成', 'h-running': '處理中',
    'update-available': '有新版本：Video Translator Remote v{version}',
    'update-download': '下載更新', 'update-downloading': '下載中…',
    'update-downloaded': '已下載。請解壓覆蓋舊檔，再到 chrome://extensions 重新載入。',
    'update-show': '顯示資料夾',
    'update-failed': '下載失敗，已改開發行頁面。',
    'update-dismiss': '忽略此版本',
    'panel-mode-to-popup': '切換至彈窗', 'panel-mode-to-sidepanel': '切換至側邊欄',
    'play': '播放',
  },
  'zh-CN': {
    'btn-auto': '全自动翻译', 'btn-auto-resume': '继续全自动',
    'opt-pause': '翻译后暂停，让我先检查译文',
    'auto-hint': '用当前设置和默认值，把剩下的步骤一路跑完。',
    'auto-running': '全自动 {n}/4：{name}', 'auto-paused': '已暂停：请检查译文，再点“继续全自动”（或“合成配音”）。',
    's-ref': ' · 声音 #{n}',
    'status-checking': '检查 B70 中…',
    'status-ready': 'B70 就绪 — 识别 · 翻译 · 配音 · 视频',
    'status-loading': 'B70 还在加载模型…',
    'status-partial': '尚未就绪：{list}',
    'status-no-server': '请先在 ⚙ 设置 B70 地址',
    'status-working': '处理中…',
    'retry-backend': '重试',
    'label-server': 'B70',
    'svc-asr': '识别', 'svc-llm': '翻译', 'svc-tts': '配音', 'svc-vt': '视频',
    'server-settings': '服务器设置',
    'tab-setup': '流程', 'tab-queue': '历史',
    'step1-title': '选择视频与语言',
    'step2-title': '语音识别',
    'step3-title': '校正与翻译',
    'step4-title': '配音',
    'step5-title': '输出视频',
    'step1-hint': '视频会在下一步上传到你的 B70，不会发送到别处。',
    'step2-hint': '按停顿把语音切成句子，再逐句识别，这样每句字幕都有时间点。',
    'step4-hint': '选一段声音作参考，Qwen3-TTS 会用这个声音读出译文。',
    'drop-label': '拖拽视频到这里',
    'drop-hint': '或点击选择文件（mp4 / mkv / mov / webm / 音频）',
    'label-src': '原语言', 'label-tgt': '翻译成',
    'lang-auto': '自动检测',
    'btn-asr': '开始识别', 'btn-asr-again': '重新识别',
    'btn-translate': '开始翻译', 'btn-translate-again': '重新翻译',
    'btn-dub': '合成配音', 'btn-dub-again': '重新配音',
    'btn-render': '合成视频', 'btn-render-again': '重新合成',
    'btn-stop': '停止',
    'opt-clean': '先校正识别错误并去除赘字（嗯、啊、那个…）',
    'glossary-hint': '专有名词表（选填）：一行一个，可写成“原文=译文”，LLM 会照着用。',
    'glossary-placeholder': 'Lunar Lake\nXe2=Xe2',
    'seg-edit-hint': '可直接修改原文与译文，翻译后的内容会用于字幕与配音。',
    'opt-burn': '把字幕烧进画面（重新编码，较慢）',
    'label-origvol': '原声', 'vol-mute': '静音',
    'label-speed': '语速上限', 'speed-off': '不加速',
    'speed-hint': '配音比原句长时，会自动加快语速来对齐（最多到上限）。',
    'ref-from-video': '用视频里的声音作参考（保留原讲者的声音）',
    'ref-from-upload': '上传参考声音（.wav）',
    'ref-drop-label': '拖拽或点击选择 .wav',
    'ref-text-hint': '参考声音实际说的内容：',
    'ref-text-placeholder': '参考音频中实际说的话',
    'missing-prefix': '还需要：',
    'list-sep': '、',
    'ready-asr': '都准备好了，点“开始识别”。',
    'ready-translate': '都准备好了，点“开始翻译”。',
    'ready-dub': '都准备好了，点“合成配音”。',
    'ready-render': '都准备好了，点“合成视频”。',
    'm-video': '视频', 'm-asr': '完成语音识别', 'm-translate': '完成翻译', 'm-dub': '完成配音',
    'm-ref': '参考声音', 'm-reftext': '参考文字',
    'm-svc-vt': '视频服务', 'm-svc-asr': '识别服务', 'm-svc-llm': '翻译服务', 'm-svc-tts': '配音服务',
    'p-upload': '上传中 {pct}%', 'p-prepare': '提取音频并切句中…',
    'p-asr': '识别 {n}/{total}', 'p-clean': '校正 {n}/{total}', 'p-translate': '翻译 {n}/{total}',
    'p-dub': '配音 {n}/{total}', 'p-render': '合成视频中… {pct}%',
    's-segments': '{n} 句', 's-dubbed': '{n} 段配音', 's-video': '视频完成',
    'err-job-gone': '服务器上已没有这个视频，请重新选择文件。',
    'err-no-segments': '这个文件里找不到语音。',
    'err-llm': '翻译服务返回了无法解析的内容：',
    'err-stopped': '已停止。再点一次按钮就会从中断处继续。',
    'confirm-redo': '这会覆盖这一步及之后各步骤的结果，要继续吗？',
    'confirm-new': '要开始新项目吗？当前项目会留在“历史”。',
    'dl-video': '下载视频', 'dl-audio': '下载音频', 'dl-srt': 'SRT 字幕', 'dl-vtt': 'VTT 字幕', 'dl-wav': '配音 WAV',
    'queue-empty': '还没有翻译过的视频。到“流程”页选一个视频开始吧。',
    'queue-go-setup': '前往流程',
    'h-open': '打开', 'h-delete': '删除', 'h-steps': '{n}/5 步', 'h-done': '已完成', 'h-running': '处理中',
    'update-available': '有新版本：Video Translator Remote v{version}',
    'update-download': '下载更新', 'update-downloading': '下载中…',
    'update-downloaded': '已下载。请解压覆盖旧文件，再到 chrome://extensions 重新加载。',
    'update-show': '显示文件夹',
    'update-failed': '下载失败，已改开发布页面。',
    'update-dismiss': '忽略此版本',
    'panel-mode-to-popup': '切换至弹窗', 'panel-mode-to-sidepanel': '切换至侧栏',
    'play': '播放',
  },
};

// ── State ────────────────────────────────────────────────────────────────────
let currentLang = 'zh-TW';
let panelMode   = 'sidepanel';  // 'sidepanel' | 'popup'
let host        = '';           // B70 address, entered by the user; never hard-coded
let ports       = { ...DEFAULT_PORTS };
let svc         = { asr: false, llm: false, tts: false, vt: false };
let svcLoading  = { asr: false, tts: false };
let pollTimer   = null;

let projects    = [];     // history, oldest first
let project     = null;   // the one shown in the workflow
let pendingFile = null;   // File chosen but not yet uploaded (cannot be persisted)
let busy        = null;   // 'asr' | 'translate' | 'dub' | 'render' | null
let abortCtl    = null;
let llmModel    = null;
const userToggled = {};   // step index → collapsed (manual override until the stage changes)

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusBar = $('statusBar'), statusDot = $('statusDot'), statusText = $('statusText'), svcDots = $('svcDots');
const startBackendBtn = $('startBackendBtn'), serverGearBtn = $('serverGearBtn'), serverPop = $('serverPop');
const hostInput = $('hostInput');
const portInputs = { asr: $('portAsr'), llm: $('portLlm'), tts: $('portTts'), vt: $('portVt') };
const langSelect = $('langSelect'), panelModeBtn = $('panelModeBtn');
const tabSetup = $('tabSetup'), tabQueue = $('tabQueue'), queueBadge = $('queueBadge');
const panelSetup = $('panelSetup'), panelQueue = $('panelQueue');
const queueContent = $('queueContent'), queueEmpty = $('queueEmpty');
const videoDropZone = $('videoDropZone'), videoFileInput = $('videoFileInput'), videoFileName = $('videoFileName');
const videoRemoveBtn = $('videoRemoveBtn'), videoMeta = $('videoMeta');
const srcLangSelect = $('srcLangSelect'), tgtLangSelect = $('tgtLangSelect');
const asrBtn = $('asrBtn'), translateBtn = $('translateBtn'), dubBtn = $('dubBtn'), renderBtn = $('renderBtn');
const stopBtns = { asr: $('stop2'), translate: $('stop3'), dub: $('stop4'), render: $('stop5') };
const autoBtn = $('autoBtn'), optPause = $('optPause');
const optClean = $('optClean'), glossaryTextarea = $('glossaryTextarea');
const segList = $('segList'), segHead3 = $('segHead3');
const optBurn = $('optBurn'), origVolSelect = $('origVolSelect'), speedSelect = $('speedSelect');
const refSegBox = $('refSegBox'), refSegSelect = $('refSegSelect'), refSegPlayer = $('refSegPlayer');
const refUploadBox = $('refUploadBox'), refDropZone = $('refDropZone'), refFileInput = $('refFileInput');
const refFileName = $('refFileName'), refRemoveBtn = $('refRemoveBtn'), refUploadPlayer = $('refUploadPlayer');
const refTextarea = $('refTextarea');
const resultBox = $('resultBox'), resultVideo = $('resultVideo'), resultAudio = $('resultAudio'), resultActions = $('resultActions');
const steps = [1, 2, 3, 4, 5].map((n) => ({
  card: $(`step${n}`), head: $(`step${n}Head`), summary: $(`step${n}Summary`),
  missing: $(`missing${n}`), missingText: $(`missing${n}Text`), progress: $(`progress${n}`), msg: $(`msg${n}`),
}));

// ── i18n helpers ─────────────────────────────────────────────────────────────
function t(key, vars) {
  let s = (TRANSLATIONS[currentLang] || TRANSLATIONS.en)[key] ?? TRANSLATIONS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  buildLangSelects();
}

function buildLangSelects() {
  const src = project?.srcLang || srcLangSelect.value || 'auto';
  const tgt = project?.tgtLang || tgtLangSelect.value || 'en';
  srcLangSelect.innerHTML = SRC_LANGS.map((c) =>
    `<option value="${c}">${c === 'auto' ? escapeHtml(t('lang-auto')) : escapeHtml(LANGS[c][0])}</option>`).join('');
  tgtLangSelect.innerHTML = TGT_LANGS.map((c) => `<option value="${c}">${escapeHtml(LANGS[c][0])}</option>`).join('');
  srcLangSelect.value = src;
  tgtLangSelect.value = tgt;
}

// ── Small utilities ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, type = 'audio/wav') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
const baseName = (name) => String(name || 'video').replace(/\.[^.]+$/, '');

function newProject() {
  return {
    id: Date.now(), created: Date.now(), name: '', size: 0, duration: 0, hasVideo: true, jobId: null,
    srcLang: srcLangSelect.value || 'auto', tgtLang: tgtLangSelect.value || 'en',
    segments: [], asrDone: false, translated: false, dubbed: false, rendered: false, outputs: [],
    refMode: 'segment', refSegIdx: null, refTextSeg: '', refTextUp: '', refAudio: null,
    glossary: '', pause: true, optClean: true, burn: true, origVol: '0', speed: '1.5', elapsedMs: 0, error: null,
  };
}

// ── Service URLs ─────────────────────────────────────────────────────────────
const svcUrl = (name) => `http://${host}:${ports[name]}`;
const llmBase = () => `${svcUrl('llm')}/v1`;
const vtUrl = (path) => `${svcUrl('vt')}${path}`;

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error || data?.detail || `HTTP ${res.status}`);
  return data;
}
async function vtJson(method, path, body, signal) {
  try {
    return await jfetch(vtUrl(path), {
      method, signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (/job not found/i.test(err.message)) { jobGone(); throw new Error(t('err-job-gone')); }
    throw err;
  }
}
function jobGone() {
  if (!project) return;
  project.jobId = null;
  project.segments = [];
  project.asrDone = project.translated = project.dubbed = project.rendered = false;
  project.outputs = [];
  saveState();
}

// ── Persistence ──────────────────────────────────────────────────────────────
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, SAVE_DEBOUNCE_MS);
}
function flushState() {
  clearTimeout(saveTimer);
  if (project && !projects.includes(project) && project.jobId) projects.push(project);
  chrome.storage.local.set({
    lang: currentLang, host, ports, panelMode,
    projects, currentId: project?.id ?? null,
  }).catch((err) => console.error('[saveState] failed:', err));
}
window.addEventListener('pagehide', flushState);


// ── Language selector & tabs ─────────────────────────────────────────────────
langSelect.addEventListener('change', () => {
  currentLang = langSelect.value;
  applyTranslations();
  renderAll();
  updatePanelModeBtn();
  saveState();
});

function switchTab(name) {
  const isSetup = name === 'setup';
  panelSetup.classList.toggle('hidden', !isSetup);
  panelQueue.classList.toggle('hidden', isSetup);
  tabSetup.classList.toggle('active', isSetup);
  tabQueue.classList.toggle('active', !isSetup);
}
tabSetup.addEventListener('click', () => switchTab('setup'));
tabQueue.addEventListener('click', () => switchTab('queue'));
$('queueEmptyCta').addEventListener('click', () => switchTab('setup'));

function updateBadge() {
  queueBadge.textContent = '1';
  queueBadge.classList.toggle('hidden', !busy);
}

// ── Service status ───────────────────────────────────────────────────────────
const SVC_ORDER = ['asr', 'llm', 'tts', 'vt'];

function renderStatus() {
  const dots = svcDots.querySelectorAll('i');
  SVC_ORDER.forEach((name, i) => {
    dots[i].className = svc[name] ? 'on' : svcLoading[name] ? 'load' : '';
    dots[i].title = t(`svc-${name}`);
  });
  statusDot.className = 'status-dot';
  startBackendBtn.style.display = 'none';
  serverGearBtn.classList.toggle('attn', !host);
  const notReady = SVC_ORDER.filter((n) => !svc[n]);

  if (!host) {
    statusDot.classList.add('offline');
    statusText.textContent = t('status-no-server');
  } else if (busy) {
    statusDot.classList.add('loading');
    statusText.textContent = autoRunning && autoStepNo
      ? t('auto-running', { n: autoStepNo - 1, name: t(`step${autoStepNo}-title`) })
      : t('status-working');
  } else if (notReady.length === 0) {
    statusText.textContent = t('status-ready');
  } else if (notReady.every((n) => svcLoading[n])) {
    statusDot.classList.add('loading');
    statusText.textContent = t('status-loading');
  } else {
    statusDot.classList.add('offline');
    statusText.textContent = t('status-partial', { list: notReady.map((n) => t(`svc-${n}`)).join(t('list-sep')) });
    startBackendBtn.style.display = 'inline-flex';
  }
}

async function probe(url, accept) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false };
    return accept(await res.json().catch(() => ({})));
  } catch (_) {
    return { ok: false };
  }
}
const modelHealth = (d) => ({ ok: d.status === 'ok' && d.model_loaded === true, loading: d.status === 'ok' && !d.model_loaded && !d.model_error });

async function checkServices() {
  if (!host) {
    svc = { asr: false, llm: false, tts: false, vt: false };
    svcLoading = { asr: false, tts: false };
    renderStatus(); updateSteps();
    return;
  }
  const [asr, tts, vt, llm] = await Promise.all([
    probe(`${svcUrl('asr')}/health`, modelHealth),
    probe(`${svcUrl('tts')}/health`, modelHealth),
    probe(`${svcUrl('vt')}/health`, (d) => ({ ok: d.status === 'ok' })),
    probe(`${llmBase()}/models`, (d) => ({ ok: Array.isArray(d.data) && d.data.length > 0, model: d.data?.[0]?.id })),
  ]);
  svc = { asr: !!asr.ok, tts: !!tts.ok, vt: !!vt.ok, llm: !!llm.ok };
  svcLoading = { asr: !!asr.loading, tts: !!tts.loading };
  if (llm.model) llmModel = llm.model;
  renderStatus();
  updateSteps();
}
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(checkServices, HEALTH_POLL_MS);
}

// ── Server settings ──────────────────────────────────────────────────────────
function parseHost(value) {
  const m = String(value || '').trim().match(/^(?:https?:\/\/)?([^/:\s]+)/i);
  return m ? m[1] : '';
}
async function ensureServerPermissions() {
  if (!host) return;
  try {
    const origins = SVC_ORDER.map((n) => `${svcUrl(n)}/*`);
    if (!(await chrome.permissions.contains({ origins }))) await chrome.permissions.request({ origins });
  } catch (_) { /* fall back to the servers' CORS headers */ }
}
function renderServerInputs() {
  hostInput.value = host;
  for (const n of SVC_ORDER) portInputs[n].value = ports[n];
}
async function onServerChange() {
  host = parseHost(hostInput.value);
  for (const n of SVC_ORDER) {
    const v = portInputs[n].value.replace(/\D/g, '');
    ports[n] = v || DEFAULT_PORTS[n];
  }
  renderServerInputs();
  llmModel = null;
  saveState();
  await ensureServerPermissions();
  checkServices();
}
[hostInput, ...Object.values(portInputs)].forEach((el) => el.addEventListener('change', onServerChange));
startBackendBtn.addEventListener('click', () => { statusText.textContent = t('status-checking'); checkServices(); });
serverGearBtn.addEventListener('click', () => {
  const open = serverPop.classList.toggle('open');
  serverGearBtn.classList.toggle('open', open);
  serverGearBtn.setAttribute('aria-expanded', String(open));
  if (open) setTimeout(() => hostInput.focus(), 120);
});

// ── Step cards ───────────────────────────────────────────────────────────────
let lastCurrent = 0;

function stage() {
  const p = project;
  return { s1: !!(pendingFile || p.jobId), s2: p.asrDone, s3: p.translated, s4: p.dubbed, s5: p.rendered };
}
function refReady(p) {
  if (p.refMode === 'upload') return !!(p.refAudio && p.refTextUp.trim());
  return p.refSegIdx != null && !!p.refTextSeg.trim();
}
function countTexts(p, key) { return p.segments.filter((s) => (s.src || '').trim() && (key === 'tgt' ? (s.tgt || '').trim() : true)).length; }

function setMissing(n, list, readyKey) {
  const s = steps[n - 1];
  if (!s.missing) return;
  s.missing.classList.toggle('ready', list.length === 0);
  s.missingText.textContent = list.length === 0 ? t(readyKey) : t('missing-prefix') + list.join(t('list-sep'));
}

function updateSteps() {
  if (!project) return;
  const p = project, st = stage();
  const done = [st.s1, st.s2, st.s3, st.s4, st.s5];
  let current = done.findIndex((d) => !d) + 1;
  if (current === 0) current = 5;
  if (current !== lastCurrent) { for (const k of Object.keys(userToggled)) delete userToggled[k]; lastCurrent = current; }

  steps.forEach((s, i) => {
    const n = i + 1;
    s.card.classList.toggle('done', done[i]);
    s.card.classList.toggle('current', n === current);
    const collapsed = userToggled[n] ?? (n !== current);
    s.card.classList.toggle('collapsed', collapsed);
  });

  // summaries
  const parts1 = [p.name && (p.name.length > 22 ? p.name.slice(0, 20) + '…' : p.name)].filter(Boolean);
  steps[0].summary.textContent = parts1.join(' · ');
  steps[1].summary.textContent = p.asrDone ? t('s-segments', { n: p.segments.length }) : '';
  steps[2].summary.textContent = p.translated ? t('s-segments', { n: countTexts(p, 'tgt') }) : '';
  const refNo = p.refMode === 'segment' && p.refSegIdx != null ? p.segments.findIndex((s) => s.i === p.refSegIdx) + 1 : 0;
  steps[3].summary.textContent = p.dubbed
    ? t('s-dubbed', { n: p.segments.filter((s) => s.clip).length }) + (refNo ? t('s-ref', { n: refNo }) : '')
    : '';
  steps[4].summary.textContent = p.rendered ? t('s-video') : '';

  // missing hints
  const m2 = [];
  if (!st.s1) m2.push(t('m-video'));
  if (!svc.vt) m2.push(t('m-svc-vt'));
  if (!svc.asr) m2.push(t('m-svc-asr'));
  setMissing(2, m2, 'ready-asr');
  const m3 = [];
  if (!st.s2) m3.push(t('m-asr'));
  if (!svc.llm) m3.push(t('m-svc-llm'));
  setMissing(3, m3, 'ready-translate');
  const m4 = [];
  if (!st.s3) m4.push(t('m-translate'));
  if (p.refMode === 'upload') {
    if (!p.refAudio) m4.push(t('m-ref'));
    if (!p.refTextUp.trim()) m4.push(t('m-reftext'));
  } else if (st.s2) {
    if (p.refSegIdx == null) m4.push(t('m-ref'));
    else if (!p.refTextSeg.trim()) m4.push(t('m-reftext'));
  }
  if (!svc.vt) m4.push(t('m-svc-vt'));
  if (!svc.tts) m4.push(t('m-svc-tts'));
  setMissing(4, m4, 'ready-dub');
  const m5 = [];
  if (!st.s4) m5.push(t('m-dub'));
  if (!svc.vt) m5.push(t('m-svc-vt'));
  setMissing(5, m5, 'ready-render');

  // buttons
  const setBtn = (btn, key, againKey, isDone, missing) => {
    btn.disabled = !!busy || missing.length > 0;
    btn.classList.toggle('again', isDone);
    btn.querySelector('.act-label').textContent = t(isDone ? againKey : key);
  };
  setBtn(asrBtn, 'btn-asr', 'btn-asr-again', p.asrDone, m2);
  setBtn(translateBtn, 'btn-translate', 'btn-translate-again', p.translated, m3);
  setBtn(dubBtn, 'btn-dub', 'btn-dub-again', p.dubbed, m4);
  setBtn(renderBtn, 'btn-render', 'btn-render-again', p.rendered, m5);
  const anyDone = p.asrDone || p.translated || p.dubbed;
  const autoMissing = !st.s1 || !svc.vt || !svc.asr || !svc.llm || !svc.tts || p.rendered;
  autoBtn.disabled = !!busy || autoRunning || autoMissing;
  autoBtn.querySelector('.act-label').textContent = t(anyDone ? 'btn-auto-resume' : 'btn-auto');
  updateBadge();
}

steps.forEach((s, i) => {
  s.head.addEventListener('click', () => {
    userToggled[i + 1] = !s.card.classList.contains('collapsed');
    s.card.classList.toggle('collapsed');
  });
});

// progress + messages
function showProgress(n, frac, text) {
  const el = steps[n - 1].progress;
  el.classList.add('show');
  el.classList.toggle('indeterminate', frac == null);
  el.querySelector('.step-progress-bar > span').style.width = frac == null ? '' : `${Math.round(Math.min(Math.max(frac, 0), 1) * 100)}%`;
  el.querySelector('.step-progress-text').textContent = text || '';
}
function hideProgress(n) { steps[n - 1].progress.classList.remove('show'); }
function showMsg(n, text, type = 'error') {
  const el = steps[n - 1].msg;
  el.className = `msg-box show ${type}`;
  el.textContent = text;
}
function hideMsg(n) { const el = steps[n - 1].msg; el.className = 'msg-box'; el.textContent = ''; }

async function runStep(kind, stepNo, fn) {
  if (busy) return 'failed';
  let result = 'ok';
  busy = kind;
  abortCtl = new AbortController();
  const started = Date.now();
  hideMsg(stepNo);
  stopBtns[kind] && (stopBtns[kind].hidden = false);
  statusBar.classList.add('generating');
  updateSteps(); renderStatus();
  try {
    await fn(abortCtl.signal);
  } catch (err) {
    if (err?.name === 'AbortError' || abortCtl?.signal.aborted) { result = 'stopped'; showMsg(stepNo, t('err-stopped'), 'info'); }
    else {
      result = 'failed'; console.error(err); showMsg(stepNo, err?.message || String(err)); project.error = err?.message || String(err); }
  } finally {
    project.elapsedMs = (project.elapsedMs || 0) + (Date.now() - started);
    busy = null;
    abortCtl = null;
    stopBtns[kind] && (stopBtns[kind].hidden = true);
    hideProgress(stepNo);
    statusBar.classList.remove('generating');
    flushState();
    renderAll();
  }
  return result;
}
Object.entries(stopBtns).forEach(([, btn]) => btn.addEventListener('click', () => { autoCancel = true; abortCtl?.abort(); }));

// ── Step 1: pick a video ─────────────────────────────────────────────────────
videoDropZone.addEventListener('click', (e) => { if (!videoRemoveBtn.contains(e.target)) videoFileInput.click(); });
videoFileInput.addEventListener('change', () => {
  const f = videoFileInput.files[0];
  if (f) loadVideoFile(f);
  videoFileInput.value = '';
});
['dragenter', 'dragover'].forEach((ev) => videoDropZone.addEventListener(ev, (e) => { e.preventDefault(); videoDropZone.classList.add('drag-over'); }));
['dragleave', 'dragend', 'drop'].forEach((ev) => videoDropZone.addEventListener(ev, () => videoDropZone.classList.remove('drag-over')));
videoDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadVideoFile(f);
});
videoRemoveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (busy) return;
  if (project.jobId && !confirm(t('confirm-new'))) return;
  startNewProject();
  renderAll();
});

function startNewProject() {
  if (project?.jobId && !projects.includes(project)) projects.push(project);
  pendingFile = null;
  project = newProject();
  Object.keys(userToggled).forEach((k) => delete userToggled[k]);
  lastCurrent = 0;
  saveState();
}

function loadVideoFile(file) {
  if (busy) return;
  if (project.jobId || project.asrDone) startNewProject();
  pendingFile = file;
  project.name = file.name;
  project.size = file.size;
  project.hasVideo = !file.type.startsWith('audio/');
  project.duration = 0;
  const media = document.createElement(project.hasVideo ? 'video' : 'audio');
  const url = URL.createObjectURL(file);
  media.preload = 'metadata';
  media.onloadedmetadata = () => {
    if (pendingFile === file && isFinite(media.duration)) { project.duration = media.duration; renderAll(); }
    URL.revokeObjectURL(url);
  };
  media.onerror = () => URL.revokeObjectURL(url);
  media.src = url;
  renderAll();
  saveState();
}

srcLangSelect.addEventListener('change', () => { project.srcLang = srcLangSelect.value; saveState(); });
tgtLangSelect.addEventListener('change', () => {
  if (project.translated || project.dubbed || project.rendered) {
    if (busy || !confirm(t('confirm-redo'))) { tgtLangSelect.value = project.tgtLang; return; }
    invalidateFrom('translate');
  }
  project.tgtLang = tgtLangSelect.value;
  renderAll();
  saveState();
});

// reset results from a stage onwards
function invalidateFrom(stageName) {
  const p = project;
  if (stageName === 'asr') {
    p.segments.forEach((s) => { s.src = null; s.raw = null; s.cleaned = false; });
    p.asrDone = false;
  }
  if (['asr', 'translate'].includes(stageName)) {
    p.segments.forEach((s) => { s.tgt = ''; });
    p.translated = false;
  }
  if (['asr', 'translate', 'dub'].includes(stageName)) {
    p.segments.forEach((s) => { s.clip = false; });
    p.dubbed = false;
  }
  p.rendered = false;
  p.outputs = [];
}

// ── Segment editor ───────────────────────────────────────────────────────────
const segAudio = new Audio();
function playSegment(i) {
  if (!project.jobId) return;
  segAudio.pause();
  segAudio.src = vtUrl(`/jobs/${project.jobId}/segments/${i}.wav`);
  segAudio.play().catch(() => {});
}

function renderSegList() {
  const p = project;
  segList.innerHTML = '';
  segHead3.hidden = !(p.asrDone && p.segments.length);
  if (!p.asrDone) return;
  const showTgt = p.translated || p.segments.some((s) => (s.tgt || '').trim());
  const frag = document.createDocumentFragment();
  p.segments.forEach((seg, idx) => {
    const row = document.createElement('div');
    row.className = 'seg-row' + (seg.clip ? ' dubbed' : '');
    row.dataset.i = String(seg.i);
    row.innerHTML = `<div class="seg-time"><span class="seg-no">#${idx + 1}</span><span>${fmtTime(seg.start)} – ${fmtTime(seg.end)}</span>
      <button class="seg-play" type="button" title="${escapeHtml(t('play'))}">▶</button></div>
      <textarea class="src" rows="2" spellcheck="false"></textarea>${showTgt ? '<textarea class="tgt" rows="2" spellcheck="false"></textarea>' : ''}`;
    const src = row.querySelector('textarea.src');
    src.value = seg.src || '';
    src.addEventListener('input', () => { seg.src = src.value; saveState(); });
    const tgt = row.querySelector('textarea.tgt');
    if (tgt) {
      tgt.value = seg.tgt || '';
      tgt.addEventListener('input', () => {
        seg.tgt = tgt.value;
        seg.clip = false;
        row.classList.remove('dubbed');
        project.dubbed = false;
        project.rendered = false;
        saveState();
        updateSteps();
      });
    }
    row.querySelector('.seg-play').addEventListener('click', () => playSegment(seg.i));
    frag.appendChild(row);
  });
  segList.appendChild(frag);
}
function refreshSegRow(seg) {
  const row = segList.querySelector(`.seg-row[data-i="${seg.i}"]`);
  if (!row) return;
  row.classList.toggle('dubbed', !!seg.clip);
  const tgt = row.querySelector('textarea.tgt');
  if (tgt && tgt.value !== (seg.tgt || '')) tgt.value = seg.tgt || '';
}

// ── Step 2: transcribe ───────────────────────────────────────────────────────
function uploadVideo(file, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', vtUrl('/jobs'));
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(new Error(data?.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload failed (network error)'));
    signal.addEventListener('abort', () => { xhr.abort(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    xhr.send(file);
  });
}

function pickDefaultRef(p) {
  let best = null, bestScore = Infinity;
  for (const s of p.segments) {
    if (!(s.raw ?? s.src ?? '').trim()) continue;
    const dur = s.end - s.start;
    const score = Math.abs(dur - 8) + (dur < 3 ? 10 : 0) + (dur > 15 ? 10 : 0);
    if (score < bestScore) { best = s; bestScore = score; }
  }
  return best;
}

asrBtn.addEventListener('click', () => {
  if (project.asrDone) {
    if (!confirm(t('confirm-redo'))) return;
    invalidateFrom('asr');
  }
  doAsr();
});
function doAsr() {
  const p = project;
  return runStep('asr', 2, async (signal) => {
    if (!p.jobId) {
      if (!pendingFile) throw new Error(t('err-job-gone'));
      showProgress(2, 0, t('p-upload', { pct: 0 }));
      const info = await uploadVideo(pendingFile, signal, (f) => {
        showProgress(2, f, t('p-upload', { pct: Math.round(f * 100) }));
        if (f >= 1) showProgress(2, null, t('p-prepare'));
      });
      p.jobId = info.job_id;
      p.duration = info.duration;
      p.hasVideo = info.has_video;
      pendingFile = null;
      flushState();
    }
    if (!p.segments.length) {
      showProgress(2, null, t('p-prepare'));
      const res = await vtJson('POST', `/jobs/${p.jobId}/segment`, {}, signal);
      if (!res.segments.length) throw new Error(t('err-no-segments'));
      p.segments = res.segments.map((s) => ({ i: s.i, start: s.start, end: s.end, src: null, raw: null, tgt: '', clip: false, cleaned: false }));
      flushState();
    }
    const todo = p.segments.filter((s) => s.src == null);
    const script = currentLang === 'zh-CN' ? 'zh-CN' : currentLang === 'zh-TW' ? 'zh-TW' : '';
    for (let k = 0; k < todo.length; k++) {
      const seg = todo[k];
      showProgress(2, k / todo.length, t('p-asr', { n: k + 1, total: todo.length }));
      const wav = await (await fetch(vtUrl(`/jobs/${p.jobId}/segments/${seg.i}.wav`), { signal })).blob();
      const r = await jfetch(`${svcUrl('asr')}/transcribe`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: await blobToBase64(wav), filename: 'segment.wav', language: p.srcLang || 'auto', script }),
      });
      seg.src = (r.text || '').trim();
      seg.raw = seg.src;
      if (k % 5 === 4) saveState();
    }
    p.asrDone = true;
    const ref = pickDefaultRef(p);
    if (ref && p.refSegIdx == null) { p.refSegIdx = ref.i; p.refTextSeg = ref.raw || ref.src || ''; }
  });
}

// ── Step 3: correct + translate (LLM) ────────────────────────────────────────
async function refreshLlmModel() {
  const d = await jfetch(`${llmBase()}/models`);
  llmModel = d.data?.[0]?.id;
  if (!llmModel) throw new Error('The LLM service lists no model.');
}
async function llmChat(messages, signal) {
  if (!llmModel) await refreshLlmModel();
  const data = await jfetch(`${llmBase()}/chat/completions`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmModel, messages, temperature: 0.2, max_tokens: 4096, stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  let text = data.choices?.[0]?.message?.content || '';
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
  return text;
}
function parseJsonArray(text, n) {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const arr = JSON.parse(text.slice(a, b + 1));
    if (Array.isArray(arr) && arr.length === n && arr.every((x) => typeof x === 'string' || typeof x?.text === 'string')) {
      return arr.map((x) => (typeof x === 'string' ? x : x.text));
    }
  } catch (_) { /* fall through */ }
  return null;
}
async function llmBatch(system, payload, n, signal, splitFn) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await llmChat([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }], signal);
    const arr = parseJsonArray(last, n);
    if (arr) return arr;
  }
  if (n > 1 && splitFn) {            // the model keeps miscounting: halve the batch
    const [a, b] = splitFn();
    return [...await llmBatch(system, a.payload, a.n, signal, a.split), ...await llmBatch(system, b.payload, b.n, signal, b.split)];
  }
  throw new Error(t('err-llm') + last.slice(0, 200));
}

function batches(items, textOf) {
  const out = [];
  let cur = [], chars = 0;
  for (const it of items) {
    const len = textOf(it).length;
    if (cur.length && (cur.length >= LLM_BATCH_LINES || chars + len > LLM_BATCH_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(it); chars += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

const CLEAN_SYSTEM =
  'You are a careful subtitle editor. The user sends JSON {"glossary": string, "lines": [string, ...]}; the lines are consecutive ' +
  'speech-recognition results from one talk. Return ONLY a JSON array of strings with exactly the same number of items, in the same order. ' +
  'For each line: fix obvious recognition errors (use the glossary and the context), remove filler words and stutters ' +
  '(e.g. 嗯 啊 呃 就是 那個 然後 / um uh you know), and make it fluent and concise. Keep the language of the line (do not translate) ' +
  'and keep English terms and product names unchanged. Never merge, split, drop or add lines. If a line is already fine return it unchanged; ' +
  'if a line is empty return an empty string.';

function translateSystem(srcName, tgtName) {
  return 'You are a professional subtitle translator and dubbing-script writer. The user sends JSON ' +
    '{"glossary": string, "previous_lines": [string] (context only, do not translate), "lines": [{"text": string, "sec": number}]}; ' +
    `the lines are consecutive sentences of one talk in ${srcName}, and "sec" is how long each one took to say. ` +
    `Translate every line into ${tgtName}. Return ONLY a JSON array of strings with exactly the same number of items, in the same order. ` +
    'Rules: natural spoken wording that suits dubbing; keep each translation about as long to say as the original (similar speaking time); ' +
    'keep technical terms, product names and numbers accurate and follow the glossary; never merge, split, drop or add lines; ' +
    'an empty line stays an empty string; no notes or explanations.';
}

translateBtn.addEventListener('click', () => {
  if (project.translated) {
    if (!confirm(t('confirm-redo'))) return;
    invalidateFrom('translate');
  }
  doTranslate();
});
function doTranslate() {
  const p = project;
  p.glossary = glossaryTextarea.value;
  p.optClean = optClean.checked;
  return runStep('translate', 3, async (signal) => {
    const glossary = p.glossary.trim();
    const segs = p.segments;

    if (p.optClean) {
      const todo = segs.filter((s) => (s.src || '').trim() && !s.cleaned);
      let done = 0;
      for (const batch of batches(todo, (s) => s.src)) {
        showProgress(3, done / Math.max(todo.length, 1) * 0.4, t('p-clean', { n: Math.min(done + batch.length, todo.length), total: todo.length }));
        const mk = (items) => ({ payload: { glossary, lines: items.map((s) => s.src) }, n: items.length,
          split: items.length > 1 ? () => { const h = items.length >> 1; return [mk(items.slice(0, h)), mk(items.slice(h))]; } : null });
        const first = mk(batch);
        const out = await llmBatch(CLEAN_SYSTEM, first.payload, first.n, signal, first.split);
        batch.forEach((s, k) => { s.raw = s.raw ?? s.src; s.src = out[k].trim() || s.src; s.cleaned = true; });
        done += batch.length;
        saveState();
      }
    }

    const srcName = p.srcLang === 'auto' ? 'the source language (auto-detected)' : LANGS[p.srcLang][1];
    const system = translateSystem(srcName, LANGS[p.tgtLang][1]);
    const todo = segs.filter((s) => (s.src || '').trim() && !(s.tgt || '').trim());
    const base = p.optClean ? 0.4 : 0;
    let done = 0;
    for (const batch of batches(todo, (s) => s.src)) {
      showProgress(3, base + (1 - base) * done / Math.max(todo.length, 1), t('p-translate', { n: Math.min(done + batch.length, todo.length), total: todo.length }));
      const firstIdx = segs.indexOf(batch[0]);
      const prev = segs.slice(Math.max(0, firstIdx - 3), firstIdx).map((s) => s.src || '').filter(Boolean);
      const mk = (items, prevLines) => ({
        payload: { glossary, previous_lines: prevLines, lines: items.map((s) => ({ text: s.src, sec: +(s.end - s.start).toFixed(1) })) },
        n: items.length,
        split: items.length > 1 ? () => { const h = items.length >> 1; return [mk(items.slice(0, h), prevLines), mk(items.slice(h), items.slice(0, h).map((s) => s.src))]; } : null,
      });
      const first = mk(batch, prev);
      const out = await llmBatch(system, first.payload, first.n, signal, first.split);
      batch.forEach((s, k) => { s.tgt = out[k].trim(); });
      done += batch.length;
      renderSegList();
      saveState();
    }
    segs.filter((s) => !(s.src || '').trim()).forEach((s) => { s.tgt = ''; });
    p.translated = true;
  });
}

// ── Step 4: dub ──────────────────────────────────────────────────────────────
function renderRefUi() {
  const p = project;
  document.querySelectorAll('input[name="refMode"]').forEach((r) => { r.checked = r.value === p.refMode; });
  refSegBox.hidden = p.refMode !== 'segment';
  refUploadBox.hidden = p.refMode !== 'upload';
  const cands = p.segments.filter((s) => (s.raw ?? s.src ?? '').trim());
  refSegSelect.innerHTML = cands.map((s) => {
    const n = p.segments.indexOf(s) + 1;
    const text = (s.raw ?? s.src).replace(/\s+/g, ' ');
    return `<option value="${s.i}">#${n} · ${fmtTime(s.start)} · ${(s.end - s.start).toFixed(1)}s · ${escapeHtml(text.length > 36 ? text.slice(0, 34) + '…' : text)}</option>`;
  }).join('');
  if (p.refSegIdx != null && cands.some((s) => s.i === p.refSegIdx)) refSegSelect.value = String(p.refSegIdx);
  refSegSelect.disabled = cands.length === 0;
  refSegPlayer.hidden = p.refSegIdx == null || !p.jobId;
  if (!refSegPlayer.hidden) {
    const url = vtUrl(`/jobs/${p.jobId}/segments/${p.refSegIdx}.wav`);
    if (refSegPlayer.getAttribute('src') !== url) refSegPlayer.src = url;
  }
  if (p.refAudio) {
    refDropZone.classList.add('has-file');
    refFileName.textContent = p.refAudio.name;
    refUploadPlayer.src = `data:audio/wav;base64,${p.refAudio.base64}`;
    refUploadPlayer.hidden = false;
  } else {
    refDropZone.classList.remove('has-file');
    refFileName.textContent = '';
    refUploadPlayer.removeAttribute('src');
    refUploadPlayer.hidden = true;
  }
  const text = p.refMode === 'upload' ? p.refTextUp : p.refTextSeg;
  if (refTextarea.value !== text) refTextarea.value = text;
}

document.querySelectorAll('input[name="refMode"]').forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  project.refMode = r.value;
  renderRefUi(); updateSteps(); saveState();
}));
refSegSelect.addEventListener('change', () => {
  const seg = project.segments.find((s) => s.i === Number(refSegSelect.value));
  if (!seg) return;
  project.refSegIdx = seg.i;
  project.refTextSeg = seg.raw ?? seg.src ?? '';
  renderRefUi(); updateSteps(); saveState();
});
refTextarea.addEventListener('input', () => {
  if (project.refMode === 'upload') project.refTextUp = refTextarea.value;
  else project.refTextSeg = refTextarea.value;
  updateSteps(); saveState();
});
refDropZone.addEventListener('click', (e) => { if (!refRemoveBtn.contains(e.target)) refFileInput.click(); });
refFileInput.addEventListener('change', () => { const f = refFileInput.files[0]; if (f) loadRefFile(f); refFileInput.value = ''; });
refDropZone.addEventListener('dragover', (e) => { e.preventDefault(); refDropZone.classList.add('drag-over'); });
['dragleave', 'drop'].forEach((ev) => refDropZone.addEventListener(ev, () => refDropZone.classList.remove('drag-over')));
refDropZone.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadRefFile(f); });
refRemoveBtn.addEventListener('click', (e) => { e.stopPropagation(); project.refAudio = null; renderRefUi(); updateSteps(); saveState(); });
async function loadRefFile(file) {
  if (!file.name.toLowerCase().endsWith('.wav')) { showMsg(4, '.wav only'); return; }
  hideMsg(4);
  project.refAudio = { name: file.name, base64: await blobToBase64(file) };
  renderRefUi(); updateSteps(); saveState();
}

dubBtn.addEventListener('click', () => {
  if (project.dubbed) {
    if (!confirm(t('confirm-redo'))) return;
    invalidateFrom('dub');
    renderSegList();
  }
  doDub();
});
function doDub() {
  const p = project;
  return runStep('dub', 4, async (signal) => {
    let refB64, refText;
    if (p.refMode === 'upload') {
      refB64 = p.refAudio.base64;
      refText = p.refTextUp.trim();
    } else {
      const wav = await (await fetch(vtUrl(`/jobs/${p.jobId}/segments/${p.refSegIdx}.wav`), { signal })).blob();
      refB64 = await blobToBase64(wav);
      refText = p.refTextSeg.trim();
    }
    const todo = p.segments.filter((s) => (s.tgt || '').trim() && !s.clip);
    const total = p.segments.filter((s) => (s.tgt || '').trim()).length;
    const doneBefore = total - todo.length;
    for (let k = 0; k < todo.length; k++) {
      const seg = todo[k];
      showProgress(4, (doneBefore + k) / total, t('p-dub', { n: doneBefore + k + 1, total }));
      const r = await jfetch(`${svcUrl('tts')}/synthesize`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: refB64, reference_text: refText, text: seg.tgt.trim(), language: ttsLang(p.tgtLang) }),
      });
      const put = await fetch(vtUrl(`/jobs/${p.jobId}/clips/${seg.i}`), { method: 'PUT', signal, headers: { 'Content-Type': 'audio/wav' }, body: base64ToBlob(r.audio_base64) });
      if (!put.ok) throw new Error((await put.json().catch(() => ({}))).error || `HTTP ${put.status}`);
      seg.clip = true;
      refreshSegRow(seg);
      if (k % 3 === 2) saveState();
    }
    p.dubbed = true;
  });
}

// ── Step 5: render ───────────────────────────────────────────────────────────
[optClean, optBurn].forEach((el) => el.addEventListener('change', () => { project.optClean = optClean.checked; project.burn = optBurn.checked; saveState(); }));
glossaryTextarea.addEventListener('input', () => { project.glossary = glossaryTextarea.value; saveState(); });
origVolSelect.addEventListener('change', () => { project.origVol = origVolSelect.value; saveState(); });
speedSelect.addEventListener('change', () => { project.speed = speedSelect.value; saveState(); });

renderBtn.addEventListener('click', () => doRender());
function doRender() {
  const p = project;
  return runStep('render', 5, async (signal) => {
    p.rendered = false;
    p.outputs = [];
    renderResult();
    showProgress(5, 0, t('p-render', { pct: 0 }));
    try {
      await vtJson('POST', `/jobs/${p.jobId}/render`, {
      segments: p.segments.map((s) => ({ i: s.i, start: s.start, end: s.end, text: s.tgt || '' })),
      burn_subtitles: optBurn.checked && p.hasVideo,
      original_volume: parseFloat(origVolSelect.value) || 0,
      max_speedup: parseFloat(speedSelect.value) || 1,
      }, signal);
    } catch (err) {
      if (!/already running/i.test(err.message)) throw err;   // an earlier render is still going: keep polling it
    }
    for (;;) {
      await sleep(1500);
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const st = await vtJson('GET', `/jobs/${p.jobId}`, null, signal);
      showProgress(5, st.progress, t('p-render', { pct: Math.round((st.progress || 0) * 100) }));
      if (st.state === 'error') throw new Error(st.message || 'Render failed');
      if (st.state === 'done') { p.outputs = st.outputs || []; break; }
    }
    p.rendered = true;
  });
}


// ── Auto mode: run every remaining step with the current settings ────────────
let autoRunning = false;
let autoCancel = false;
let autoStepNo = 0;

async function runAll() {
  if (busy || autoRunning) return;
  autoRunning = true;
  autoCancel = false;
  const p = project;
  p.pause = optPause.checked;
  const plan = [
    [2, () => p.asrDone, doAsr],
    [3, () => p.translated, doTranslate],
    [4, () => p.dubbed, doDub],
    [5, () => p.rendered, doRender],
  ];
  try {
    for (let i = 0; i < plan.length; i++) {
      const [stepNo, isDone, run] = plan[i];
      if (isDone()) continue;
      if (project !== p) break;
      autoStepNo = stepNo;
      const r = await run();
      if (r !== 'ok' || autoCancel) break;
      // one deliberate pause: let the user look over the translation before dubbing
      if (stepNo === 3 && p.pause && !p.dubbed) { showMsg(3, t('auto-paused'), 'info'); break; }
    }
  } finally {
    autoRunning = false;
    autoStepNo = 0;
    renderAll();
  }
}
autoBtn.addEventListener('click', runAll);
optPause.addEventListener('change', () => { project.pause = optPause.checked; saveState(); });

function renderResult() {
  const p = project;
  const show = p.rendered && p.outputs.length > 0 && p.jobId;
  resultBox.hidden = !show;
  if (!show) { resultVideo.removeAttribute('src'); resultAudio.removeAttribute('src'); resultActions.innerHTML = ''; return; }
  const dl = (name) => vtUrl(`/jobs/${p.jobId}/download/${name}`);
  const hasMp4 = p.outputs.includes('output.mp4');
  resultVideo.hidden = !hasMp4;
  resultAudio.hidden = hasMp4;
  const mediaUrl = dl(hasMp4 ? 'output.mp4' : 'output.m4a');
  const el = hasMp4 ? resultVideo : resultAudio;
  if (el.getAttribute('src') !== mediaUrl) el.src = mediaUrl;
  const items = [
    [hasMp4 ? 'output.mp4' : 'output.m4a', hasMp4 ? 'dl-video' : 'dl-audio', hasMp4 ? 'mp4' : 'm4a', true],
    ['subtitles.srt', 'dl-srt', 'srt'], ['subtitles.vtt', 'dl-vtt', 'vtt'], ['dubbed.wav', 'dl-wav', 'wav'],
  ].filter(([name]) => p.outputs.includes(name));
  resultActions.innerHTML = '';
  for (const [name, key, ext, primary] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(key);
    if (primary) b.className = 'primary';
    b.addEventListener('click', () => {
      chrome.downloads.download({ url: dl(name), filename: `${baseName(p.name)}_${p.tgtLang}.${ext}`, saveAs: false })
        .catch((err) => showMsg(5, err.message || String(err)));
    });
    resultActions.appendChild(b);
  }
}

// ── History ──────────────────────────────────────────────────────────────────
function stepsDone(p) { return [!!p.jobId, p.asrDone, p.translated, p.dubbed, p.rendered].filter(Boolean).length; }

function renderHistory() {
  queueContent.querySelectorAll('.task-card').forEach((c) => c.remove());
  const list = projects.filter((p) => p.jobId);
  queueEmpty.style.display = list.length ? 'none' : '';
  [...list].reverse().forEach((p, idx) => {
    const card = document.createElement('div');
    const isCurrent = p === project;
    const running = busy && isCurrent;
    card.className = `task-card ${p.rendered ? 'done' : running ? 'generating' : p.error ? 'error' : ''}${isCurrent ? ' current-project' : ''}`;
    const src = p.srcLang === 'auto' ? t('lang-auto') : LANGS[p.srcLang][0];
    card.innerHTML = `
      <div class="task-header">
        <span class="task-state"><span class="ts-n">${list.length - idx}</span>
          <svg class="ts-ring" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14"/></svg></span>
        <span class="task-filename" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span class="task-lang-tag">${escapeHtml(src)} → ${escapeHtml(LANGS[p.tgtLang][0])}</span>
        <button class="task-open-btn" type="button">${escapeHtml(t('h-open'))}</button>
        <button class="task-remove-btn" type="button" title="${escapeHtml(t('h-delete'))}">${ICONS.remove}</button>
      </div>
      <div class="task-sub">
        <span><b>${t('h-steps', { n: stepsDone(p) })}</b></span>
        ${p.duration ? `<span>${fmtTime(p.duration)}</span>` : ''}
        ${p.size ? `<span>${fmtSize(p.size)}</span>` : ''}
        <span>${new Date(p.created).toLocaleString()}</span>
        ${p.rendered ? `<span>${escapeHtml(t('h-done'))}</span>` : ''}
      </div>`;
    card.querySelector('.task-open-btn').addEventListener('click', () => openProject(p));
    card.querySelector('.task-remove-btn').addEventListener('click', () => deleteProject(p));
    queueContent.appendChild(card);
  });
}

function openProject(p) {
  if (busy) return;
  project = p;
  pendingFile = null;
  Object.keys(userToggled).forEach((k) => delete userToggled[k]);
  lastCurrent = 0;
  renderAll();
  switchTab('setup');
  saveState();
}
async function deleteProject(p) {
  if (busy && p === project) return;
  if (!confirm(`${t('h-delete')}: ${p.name}?`)) return;
  if (p.jobId) { try { await fetch(vtUrl(`/jobs/${p.jobId}`), { method: 'DELETE' }); } catch (_) { /* server may be down */ } }
  projects = projects.filter((x) => x !== p);
  if (p === project) { project = newProject(); pendingFile = null; lastCurrent = 0; }
  renderAll();
  saveState();
}

// ── Render everything from `project` ─────────────────────────────────────────
function renderAll() {
  const p = project;
  const hasFile = !!(pendingFile || p.jobId);
  videoDropZone.classList.toggle('has-file', hasFile);
  videoFileName.textContent = hasFile ? p.name : '';
  const meta = [];
  if (hasFile) {
    if (p.duration) meta.push(fmtTime(p.duration));
    if (p.size) meta.push(fmtSize(p.size));
    if (!p.hasVideo) meta.push('audio');
  }
  videoMeta.textContent = meta.join(' · ');
  srcLangSelect.value = p.srcLang;
  tgtLangSelect.value = p.tgtLang;
  optClean.checked = p.optClean;
  optPause.checked = p.pause !== false;
  if (glossaryTextarea.value !== p.glossary) glossaryTextarea.value = p.glossary;
  optBurn.checked = p.burn;
  origVolSelect.value = p.origVol;
  speedSelect.value = p.speed;
  renderSegList();
  renderRefUi();
  renderResult();
  renderStatus();
  updateSteps();
  renderHistory();
}

// ── Utility ──────────────────────────────────────────────────────────────────

// ── Extension update notice ───────────────────────────────────────────────────
const updateBanner     = document.getElementById('updateBanner');
const updateMessage    = document.getElementById('updateMessage');
const updateActionBtn  = document.getElementById('updateActionBtn');
const updateDismissBtn = document.getElementById('updateDismissBtn');
const extensionVersion = document.getElementById('extensionVersion');
let availableUpdate  = null;   // { latestVersion, releaseUrl, assetUrl }
let updateDownloadId = null;

function renderInstalledVersion() {
  extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;
}

function renderUpdateBanner(messageKey = 'update-available') {
  renderInstalledVersion();
  if (!availableUpdate?.latestVersion) { updateBanner.hidden = true; return; }
  updateMessage.textContent = t(messageKey).replace('{version}', availableUpdate.latestVersion);
  updateBanner.hidden = false;
}

async function checkForExtensionUpdate(force = false) {
  renderInstalledVersion();
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_EXTENSION_UPDATE', force }).catch(() => null);
  if (!result?.ok || !result.updateAvailable || !result.latestVersion) return;
  const stored = await chrome.storage.local.get('dismissedUpdateVersion');
  if (stored.dismissedUpdateVersion === result.latestVersion) return;
  availableUpdate = {
    latestVersion: result.latestVersion,
    releaseUrl:    result.releaseUrl,
    assetUrl:      result.assetUrl,
  };
  renderUpdateBanner();
}

async function downloadUpdate() {
  if (!availableUpdate) return;
  if (!availableUpdate.assetUrl) {  // no ZIP attached to the release: open its page
    chrome.tabs.create({ url: availableUpdate.releaseUrl });
    return;
  }
  updateActionBtn.disabled = true;
  updateActionBtn.textContent = t('update-downloading');
  try {
    updateDownloadId = await chrome.downloads.download({
      url: availableUpdate.assetUrl,
      filename: `video-translator-remote-v${availableUpdate.latestVersion}.zip`,
      saveAs: false,
    });
  } catch (_) {
    updateFailed();
  }
}

function updateFailed() {
  updateActionBtn.disabled = false;
  updateActionBtn.textContent = t('update-download');
  updateMessage.textContent = t('update-failed');
  if (availableUpdate?.releaseUrl) chrome.tabs.create({ url: availableUpdate.releaseUrl });
}

chrome.downloads?.onChanged.addListener((delta) => {
  if (delta.id !== updateDownloadId) return;
  if (delta.state?.current === 'complete') {
    updateActionBtn.disabled = false;
    updateActionBtn.textContent = t('update-show');
    updateActionBtn.dataset.done = '1';
    renderUpdateBanner('update-downloaded');
  } else if (delta.state?.current === 'interrupted' || delta.error) {
    updateFailed();
  }
});

updateActionBtn.addEventListener('click', () => {
  if (updateActionBtn.dataset.done === '1') chrome.downloads.show(updateDownloadId);
  else downloadUpdate();
});
updateDismissBtn.addEventListener('click', async () => {
  if (!availableUpdate?.latestVersion) return;
  await chrome.storage.local.set({ dismissedUpdateVersion: availableUpdate.latestVersion });
  availableUpdate = null;
  renderUpdateBanner();
});


// ── Panel mode toggle ─────────────────────────────────────────────────────────
function updatePanelModeBtn() {
  if (!panelModeBtn) return;
  if (panelMode === 'popup') {
    panelModeBtn.innerHTML = ICONS.sidepanel;
    panelModeBtn.title = t('panel-mode-to-sidepanel');
  } else {
    panelModeBtn.innerHTML = ICONS.popup;
    panelModeBtn.title = t('panel-mode-to-popup');
  }
}

async function togglePanelMode() {
  const newMode = panelMode === 'popup' ? 'sidepanel' : 'popup';
  panelMode = newMode;

  if (newMode === 'popup') {
    document.body.classList.add('popup-mode');
  } else {
    document.body.classList.remove('popup-mode');
    // Must call sidePanel.open() synchronously before any await to keep user gesture
    if (POPUP_SRC_WINDOW_ID !== null) {
      chrome.sidePanel.open({ windowId: POPUP_SRC_WINDOW_ID }).catch(() => {});
    }
  }

  updatePanelModeBtn();
  saveState();

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SET_PANEL_MODE', mode: newMode, srcWindowId: POPUP_SRC_WINDOW_ID });
    if (resp?.ok) {
      window.close();
    }
  } catch (err) {
    console.error('[togglePanelMode] sendMessage failed:', err);
  }
}

panelModeBtn?.addEventListener('click', () => togglePanelMode());

// ── Icon buttons: replay a small SVG state-change animation on each click ─────
[panelModeBtn, startBackendBtn].forEach((btn) => {
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.classList.remove('tog');
    void btn.offsetWidth;
    btn.classList.add('tog');
  });
  btn.addEventListener('animationend', () => btn.classList.remove('tog'));
});

// ── Header cursor spotlight: a soft light that smoothly trails the pointer ────
(() => {
  const bar = document.querySelector('.header-bar');
  if (!bar) return;

  // Double-click an empty area of the header to toggle the ambient sheen
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.header-title, .header-right')) return;
    bar.classList.toggle('sheen-off');
  });

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let curX = 0, curY = 0, tgtX = 0, tgtY = 0, raf = 0, lit = false;
  const tick = () => {
    curX += (tgtX - curX) * 0.18;
    curY += (tgtY - curY) * 0.18;
    bar.style.setProperty('--mx', curX + 'px');
    bar.style.setProperty('--my', curY + 'px');
    if (lit && (Math.abs(tgtX - curX) > 0.5 || Math.abs(tgtY - curY) > 0.5)) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
    }
  };
  bar.addEventListener('pointermove', (e) => {
    const r = bar.getBoundingClientRect();
    tgtX = e.clientX - r.left;
    tgtY = e.clientY - r.top;
    if (!raf) raf = requestAnimationFrame(tick);
  });
  bar.addEventListener('pointerenter', (e) => {
    const r = bar.getBoundingClientRect();
    curX = tgtX = e.clientX - r.left;
    curY = tgtY = e.clientY - r.top;
    lit = true;
    bar.classList.add('lit');
    if (!raf) raf = requestAnimationFrame(tick);
  });
  bar.addEventListener('pointerleave', () => {
    lit = false;
    bar.classList.remove('lit');
  });
})();



// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get([
    'lang', 'host', 'ports', 'panelMode', 'projects', 'currentId',
  ]).catch(() => ({}));

  host = stored.host || '';
  ports = { ...DEFAULT_PORTS, ...(stored.ports || {}) };
  renderServerInputs();

  if (stored.lang && TRANSLATIONS[stored.lang]) currentLang = stored.lang;
  langSelect.value = currentLang;

  projects = Array.isArray(stored.projects) ? stored.projects : [];
  // anything that was running when the panel closed is simply not running any more
  project = projects.find((p) => p.id === stored.currentId) || newProject();

  buildLangSelects();
  applyTranslations();

  // Derive the actual mode from the URL context, not storage (storage may be stale)
  panelMode = POPUP_SRC_WINDOW_ID !== null ? 'popup' : 'sidepanel';
  if ((stored.panelMode || 'sidepanel') !== panelMode) chrome.storage.local.set({ panelMode });
  if (panelMode === 'popup') document.body.classList.add('popup-mode');
  updatePanelModeBtn();

  statusText.textContent = t('status-checking');
  renderAll();
  await checkServices();
  startPolling();
  if (!host) serverGearBtn.click();  // first run: ask for the B70 address
  checkForExtensionUpdate();
}

init();
