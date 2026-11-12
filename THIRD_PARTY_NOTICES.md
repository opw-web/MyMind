# Third-party notices

Upstream licenses apply to their respective components. Public availability of this repository does not replace those licenses. Retain the notices bundled with installed libraries and model distributions.

| Component | Upstream license information |
| --- | --- |
| Electron / Chromium | https://github.com/electron/electron/blob/main/LICENSE — MIT and bundled Chromium notices |
| React | https://github.com/facebook/react/blob/main/LICENSE — MIT |
| Vite | https://github.com/vitejs/vite/blob/main/LICENSE — MIT |
| TypeScript | https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt — Apache-2.0 |
| SQLite | https://www.sqlite.org/copyright.html — public domain |
| Koffi | https://koffi.dev/ — license supplied with the dependency |
| Ollama | https://github.com/ollama/ollama/blob/main/LICENSE — MIT; installed separately |
| Qwen 3.5 | https://ollama.com/library/qwen3.5:9b — license accompanies the separately downloaded model |
| Faster Whisper | https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE — MIT |
| CTranslate2 | https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE — MIT |
| Whisper model | https://github.com/openai/whisper/blob/main/LICENSE — MIT |
| Whisper base live-preview distribution | https://huggingface.co/Systran/faster-whisper-base — pinned CTranslate2 model; MIT |
| Whisper large-v3-turbo int8 distribution | https://huggingface.co/vokasug/faster-whisper-large-v3-turbo-int8 — pinned CTranslate2 int8 model; MIT |
| NumPy | https://numpy.org/doc/stable/license.html |
| ONNX Runtime | https://github.com/microsoft/onnxruntime/blob/main/LICENSE — MIT |
| PyAV / FFmpeg | https://pyav.org/docs/stable/overview/installation.html — retain wheel/native-library notices |
| Python | https://docs.python.org/3/license.html |
| Kokoro-ONNX 0.6.1 | https://github.com/thewh1teagle/kokoro-onnx — MIT; bundled notice |
| Kokoro-82M v1.0 | https://huggingface.co/hexgrad/Kokoro-82M — Apache-2.0; bundled notice |
| Phonemizer 3.4.0 | https://github.com/bootphon/phonemizer — GPL-3.0; bundled license and source link |
| eSpeak NG / espeakng-loader 0.2.4 | https://github.com/espeak-ng/espeak-ng and https://github.com/thewh1teagle/espeakng-loader — retain GPL-3.0 eSpeak notice and source information |

Speech component licenses and source-package links are included in `assets/third-party` and copied into the offline runtime. The tests' public LibriSpeech/JFK audio is downloaded only into ignored fixture folders and is not distributed in the installer.

MYMIND uses self-hosted Nunito (variable) and Silkscreen fonts under the SIL Open Font License 1.1, distributed through Fontsource. Their unmodified licenses are in `assets/third-party/Nunito-OFL.txt` and `Silkscreen-OFL.txt`. The Bloom pixel flower and cat artwork are original to this project's design.
