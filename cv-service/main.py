"""
PulsePay-SBI CV Service (ARCHITECTURE §4.1, §4.2).

India-resident, model-agnostic inference plane. Replaces the Amazon build, which
shipped face images to Amazon Nova / AWS Bedrock in us-east-1 (a data-residency
breach) and returned a SHA3 hash used for exact-match (which can never match two
captures of the same face).

This service now returns a face EMBEDDING VECTOR; the backend matches by cosine
similarity over an encrypted, cancelable template. The embedding here is produced
by a local, in-cluster model so NO biometric data leaves India.

NOTE: the embedding function below is a lightweight OpenCV stand-in for the
production model (an on-prem ONNX ArcFace-class network). It is good enough to
demonstrate the cosine-threshold pipeline; swap `embed()` for the real model with
no API change. Liveness here is a placeholder for certified ISO/IEC 30107-3 PAD.
"""
import os
import base64
import numpy as np
import cv2
from fastapi import FastAPI, UploadFile, File, Form, Body
from fastapi.middleware.cors import CORSMiddleware

EMBED_DIM = 1024

app = FastAPI(title="PulsePay-SBI CV Service (India-resident)")

# Scoped CORS (no wildcard). Only configured origins.
origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

_face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")


def _decode(image_bytes: bytes):
    arr = np.frombuffer(image_bytes, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def detect_face(img):
    """Return (face_count, largest_face_bbox or None)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = _face_cascade.detectMultiScale(gray, 1.1, 4)
    if len(faces) == 0:
        return 0, None
    largest = max(faces, key=lambda f: f[2] * f[3])
    return len(faces), largest


def embed(img, bbox) -> list:
    """
    Stand-in face embedding: crop the face, normalize, downscale, equalize, flatten,
    L2-normalize to EMBED_DIM. Same face/pose -> high cosine; different -> lower.
    Replace with the production ONNX model (same return shape).
    """
    x, y, w, h = bbox
    face = img[y:y + h, x:x + w]
    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    side = int(round(EMBED_DIM ** 0.5))  # 32x32 = 1024
    resized = cv2.resize(gray, (side, side), interpolation=cv2.INTER_AREA)
    vec = resized.astype(np.float32).flatten()[:EMBED_DIM]
    if vec.shape[0] < EMBED_DIM:
        vec = np.pad(vec, (0, EMBED_DIM - vec.shape[0]))
    vec = vec - vec.mean()
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec.tolist()


def embed_fingerprint_img(img) -> list:
    """
    Stand-in fingerprint embedding (PRIMARY payment factor). Production: a certified
    fingerprint-scanner SDK / minutiae extractor (AePS-grade STQC device). Here we
    enhance the ridge image and produce a normalized vector so the cosine pipeline
    works end-to-end. Same return shape as the production extractor.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    side = int(round(EMBED_DIM ** 0.5))  # 32x32 = 1024
    resized = cv2.resize(gray, (side, side), interpolation=cv2.INTER_AREA)
    vec = resized.astype(np.float32).flatten()[:EMBED_DIM]
    if vec.shape[0] < EMBED_DIM:
        vec = np.pad(vec, (0, EMBED_DIM - vec.shape[0]))
    vec = vec - vec.mean()
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec.tolist()


@app.get("/")
async def root():
    return {"status": "PulsePay-SBI CV service running", "residency": "india", "model": "local-cv:v1"}


@app.post("/embed-fingerprint")
async def embed_fingerprint(payload: dict = Body(default=None), image: UploadFile = File(default=None)):
    """
    PRIMARY biometric. Accepts JSON { image:<base64> } or a multipart file (a frame
    from a fingerprint scanner / camera). Returns { embedding:[...], quality }.
    """
    try:
        if payload and payload.get("image"):
            raw = payload["image"]
            if "," in raw:
                raw = raw.split(",", 1)[1]
            image_bytes = base64.b64decode(raw)
        elif image is not None:
            image_bytes = await image.read()
        else:
            return {"error": "Provide image as base64 JSON or multipart file"}

        img = _decode(image_bytes)
        if img is None:
            return {"error": "Invalid image", "embedding": []}

        return {"embedding": embed_fingerprint_img(img), "quality": 90, "model_version": "local-cv:v1"}
    except Exception as e:
        print(f"embed-fingerprint error: {e}")
        return {"error": str(e), "embedding": []}


@app.post("/embed-face")
async def embed_face(payload: dict = Body(default=None), image: UploadFile = File(default=None)):
    """
    Accepts JSON { image: <base64> } (preferred, used by the backend) or a multipart
    file. Returns { embedding:[...], liveness_passed, pad_score, face_detected }.
    """
    try:
        if payload and payload.get("image"):
            raw = payload["image"]
            if "," in raw:  # strip data URL prefix if present
                raw = raw.split(",", 1)[1]
            image_bytes = base64.b64decode(raw)
        elif image is not None:
            image_bytes = await image.read()
        else:
            return {"error": "Provide image as base64 JSON or multipart file"}

        img = _decode(image_bytes)
        if img is None:
            return {"error": "Invalid image", "face_detected": False, "liveness_passed": False}

        count, bbox = detect_face(img)
        if count == 0:
            return {"face_detected": False, "liveness_passed": False, "pad_score": 0, "embedding": []}
        if count > 1:
            return {"face_detected": True, "liveness_passed": False, "pad_score": 50,
                    "error": "Multiple faces detected", "embedding": []}

        # Placeholder PAD. Production: certified ISO/IEC 30107-3 PAD on the capture device.
        pad_score = 90
        liveness_passed = pad_score >= int(float(os.environ.get("LIVENESS_THRESHOLD", "0.5")) * 100)

        return {
            "face_detected": True,
            "liveness_passed": bool(liveness_passed),
            "pad_score": pad_score,
            "embedding": embed(img, bbox),
            "model_version": "local-cv:v1",
        }
    except Exception as e:
        print(f"embed-face error: {e}")
        return {"error": str(e), "face_detected": False, "liveness_passed": False, "embedding": []}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
