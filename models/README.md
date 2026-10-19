# Local person detector

`yolox-tiny.onnx` is the unmodified official **YOLOX-tiny** model from Megvii's
`0.1.1rc0` release. It runs locally with the CPU provider in
`onnxruntime-node` 1.23.2. No camera image is uploaded and no model is downloaded
while the program is running.

- Source: https://github.com/Megvii-BaseDetection/YOLOX/releases/tag/0.1.1rc0
- Exact asset, size, SHA-256 and asset date: [manifest.json](manifest.json)
- License: Apache License 2.0, [LICENSE-YOLOX.txt](LICENSE-YOLOX.txt).
  Copyright (c) Megvii, Inc. and its affiliates.
- Reference preprocessing:
  https://github.com/Megvii-BaseDetection/YOLOX/blob/6ddff4824372906469a7fae2dc3206c7aa4bbaee/yolox/data/data_augment.py
- Reference ONNX decoding:
  https://github.com/Megvii-BaseDetection/YOLOX/blob/6ddff4824372906469a7fae2dc3206c7aa4bbaee/yolox/utils/demo_utils.py

These August 18, 2021 weights use **BGR float32 0..255 without normalization**,
as documented under "Breaking changes" in the release notes. The git tag
points to older code with RGB/ImageNet normalization; that transform is
incompatible with this asset. Real public-domain fixture inference tests cover
this distinction. The program validates the bundled model's hash before creating
the session. Inference uses a 416×416 top-left letterbox padded with 114 and
decodes the stride-8/16/32 raw grid. Only COCO's person class is retained, with
IoU 0.45 suppression. Scores 0.15–0.35 remain weak detections; they are not
silently promoted into certain people.

This generic COCO model has not been trained or calibrated for this user's
overhead camera. Occlusion, small people, extreme top-down views, reflections,
low light and slow capture can cause missed or duplicate detections. A count
comparison is an aid to review, not a guarantee that a passage was correct.

## Packaging

The pinned ONNX Runtime package uses Node-API v6, supported by the bundled
Electron. `ONNXRUNTIME_NODE_INSTALL=skip npm ci` retains the shipped CPU
libraries and skips optional CUDA downloads. For Windows x64, unpack
`node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**` from asar so Windows can
load `onnxruntime_binding.node` and `onnxruntime.dll`. Linux and macOS binaries
and Windows arm64 binaries are unnecessary for the x64 build. Bundling the
entire Windows x64 directory also preserves optional DirectML libraries, though
this application requests only CPU. The npm runtime does not include its full
license text, so this folder also bundles the unmodified MIT license and
ThirdPartyNotices.txt from the official Microsoft `v1.23.2` source release.
