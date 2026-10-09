import os
import shutil
import subprocess
import sys
from pathlib import Path
from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parent.parent
output = root / "speech-runtime"
files = ["model.bin", "config.json", "tokenizer.json", "vocabulary.json", "vocabulary.txt", "preprocessor_config.json"]
model = Path(snapshot_download("Systran/faster-whisper-base", allow_patterns=files))
model_output = output / "model"
model_output.mkdir(parents=True, exist_ok=True)
for name in files:
    if (model / name).is_file():
        shutil.copyfile(model / name, model_output / name)
shutil.copytree(root / 'assets' / 'third-party', output / 'licenses', dirs_exist_ok=True)
subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir", "--console", "--name", "mymind-whisper", "--distpath", str(output), "--workpath", str(root / ".speech-build"), "--specpath", str(root / ".speech-build"), "--collect-all", "faster_whisper", "--collect-all", "ctranslate2", "--collect-all", "onnxruntime", "--collect-all", "av", "--exclude-module", "torch", "--exclude-module", "tensorflow", str(root / "speech" / "worker.py")], check=True, cwd=root)
