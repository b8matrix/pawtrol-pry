"""
Downloads pretrained ONNX models and quantizes the PP-OCRv4 text detector to int8.
- PP-OCRv4 (PaddleOCR mobile text detector): Apache-2.0, ~4.7 MB (quantized to ~1.3 MB int8)
- YuNet (OpenCV Zoo face detector): MIT, ~230 KB
"""

import os
import sys
from pathlib import Path
import requests
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

PPOCR_URL = "https://huggingface.co/webnn/PP-OCRv4-ONNX/resolve/main/ch_PP-OCRv4_det.onnx"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

PPOCR_RAW_PATH = MODELS_DIR / "ch_PP-OCRv4_det_infer.onnx"
PPOCR_QUANT_PATH = MODELS_DIR / "ch_PP-OCRv4_det_infer.quant.onnx"
YUNET_PATH = MODELS_DIR / "face_detection_yunet_2023mar.onnx"


def download_file(url: str, dest: Path, desc: str):
    if dest.exists() and dest.stat().st_size > 1000:
        print(f"[SKIP] {desc} already exists at {dest.name} ({dest.stat().st_size / 1024:.1f} KB)")
        return
    print(f"[DOWNLOAD] Downloading {desc} from {url}...")
    headers = {"User-Agent": "Pawtrol-Model-Downloader/1.0"}
    resp = requests.get(url, headers=headers, stream=True, timeout=60)
    resp.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
    print(f"[DONE] Saved {dest.name} ({dest.stat().st_size / 1024:.1f} KB)")


def quantize_ppocr(raw_path: Path, quant_path: Path):
    if quant_path.exists() and quant_path.stat().st_size > 1000:
        print(f"[SKIP] Quantized model already exists at {quant_path.name} ({quant_path.stat().st_size / 1024:.1f} KB)")
        return

    print(f"[PREPARE] Folding Constant nodes to initializers for {raw_path.name}...")
    model = onnx.load(str(raw_path))
    nodes_to_remove = []
    for node in model.graph.node:
        if node.op_type == "Constant":
            for attr in node.attribute:
                if attr.name == "value":
                    tensor = attr.t
                    tensor.name = node.output[0]
                    model.graph.initializer.append(tensor)
                    nodes_to_remove.append(node)
    for node in nodes_to_remove:
        model.graph.node.remove(node)

    temp_inits_path = MODELS_DIR / "temp_ppocr_inits.onnx"
    onnx.save(model, str(temp_inits_path))

    print(f"[QUANTIZE] Quantizing {raw_path.name} to int8 dynamic quantization...")
    quantize_dynamic(
        model_input=str(temp_inits_path),
        model_output=str(quant_path),
        weight_type=QuantType.QInt8,
    )
    if temp_inits_path.exists():
        temp_inits_path.unlink()
    print(f"[DONE] Created {quant_path.name} ({quant_path.stat().st_size / 1024:.1f} KB)")


def main():
    print(f"=== Preparing Pretrained Models in {MODELS_DIR} ===")
    download_file(PPOCR_URL, PPOCR_RAW_PATH, "PP-OCRv4 mobile detection model")
    quantize_ppocr(PPOCR_RAW_PATH, PPOCR_QUANT_PATH)
    download_file(YUNET_URL, YUNET_PATH, "OpenCV YuNet face detector model")

    # Clean up temporary scratch files if any
    for temp_file in [MODELS_DIR / "temp_inferred.onnx", MODELS_DIR / "ch_PP-OCRv4_det_infer_inits.onnx"]:
        if temp_file.exists():
            temp_file.unlink()

    print("=== All models downloaded and prepared successfully ===")


if __name__ == "__main__":
    main()
