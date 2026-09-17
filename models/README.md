# Pretrained Vision Models for Pawtrol

This directory houses the on-device deep learning models used by Pawtrol's offscreen vision pipeline for text and face detection.

## Models Summary

| Model | Task | Source | License | Input Shape | Original Size | Quantized Size | Format |
|---|---|---|---|---|---|---|---|
| **PP-OCRv4 Mobile Detection** (`ch_PP-OCRv4_det_infer.quant.onnx`) | Text Detection | [Hugging Face: webnn/PP-OCRv4-ONNX](https://huggingface.co/webnn/PP-OCRv4-ONNX) | Apache-2.0 | `[1, 3, H, W]` (dynamic, multiple of 32, e.g. 640x640), RGB normalized | 4.7 MB (4,634 KB) | 1.3 MB (1,298 KB) | INT8 Dynamic Quantized ONNX |
| **YuNet Face Detector** (`face_detection_yunet_2023mar.onnx`) | Face Detection | [OpenCV Zoo: opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT | `[1, 3, 640, 640]`, BGR / RGB float32 | ~230 KB (227 KB) | — | FP32 ONNX |

## Model Descriptions

### 1. PP-OCRv4 Mobile Text Detector
- **Architecture**: DBNet (Real-time Scene Text Detection with Differentiable Binarization).
- **Weights Source**: Converted and verified from official PaddleOCR PP-OCRv4 mobile detection model.
- **License**: Apache License 2.0.
- **Quantization**: Quantized to `int8` dynamic quantization using `onnxruntime.quantization` in Python (`scripts/prepare_models.py`), reducing model footprint by ~72% (from 4.7 MB down to 1.3 MB) for fast browser loading and minimal memory consumption.
- **Inference**: Produces probability maps (`[1, 1, H, W]`) indicating the likelihood of text per pixel, followed by thresholding and bounding box contour extraction.

### 2. YuNet Face Detector
- **Architecture**: Ultra-lightweight face detector optimized for edge and real-time vision inference.
- **Weights Source**: OpenCV Model Zoo (`face_detection_yunet_2023mar.onnx`).
- **License**: MIT License.
- **Footprint**: 227.1 KB.
- **Inference**: Takes 640x640 image tensor and predicts multi-scale bounding boxes across strides 8, 16, and 32. All detected face boxes are unconditionally blurred.

## Execution and Acceleration
- Model sessions are executed via `onnxruntime-web` in the extension's offscreen document (`src/offscreen/`).
- Prioritizes **WebGPU** for hardware acceleration, automatically falling back to **WASM** when WebGPU is not supported by the client machine.
