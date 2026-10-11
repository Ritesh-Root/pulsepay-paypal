"""
PulsePay CV Service: camera frame -> embedding vector.

The browser sends a frame; this service returns a numeric vector and keeps no
image. The backend matches vectors by cosine similarity against encrypted,
cancelable templates. Running the model next to the backend means raw biometric
images never leave the deployment.

NOTE: the embedding functions below are lightweight OpenCV stand-ins for the
production models (a certified fingerprint extractor and an ArcFace-class face
network). They demonstrate the cosine-threshold pipeline; swap `embed()` /
`embed_fingerprint_img()` for real models with no API change. A webcam cannot read
fingerprint ridges, so fingerprint "scans" here are a visual stand-in. Liveness is a
placeholder for certified ISO/IEC 30107-3 PAD. FAR/FRR are unmeasured.
"""
import os
import base64
import numpy as np
import cv2
from fastapi import FastAPI, UploadFile, File, Body
from fastapi.middleware.cors import CORSMiddleware

EMBED_DIM = 1024

# Reject frames that carry too little detail to identify anyone (blank wall, lens
# covered, heavy motion blur). Tunable per camera.
MIN_SHARPNESS = float(os.environ.get("MIN_SHARPNESS", "15"))  # variance of the Laplacian
MIN_CONTRAST = float(os.environ.get("MIN_CONTRAST", "12"))    # grey-level standard deviation

app = FastAPI(title="PulsePay CV Service")

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


def quality(gray):
    """(sharpness, contrast, ok) for a grey image."""
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    contrast = float(gray.std())
    return sharpness, contrast, sharpness >= MIN_SHARPNESS and contrast >= MIN_CONTRAST


def quality_score(sharpness, contrast):
    """0-100 for display: how far above the minimums this frame is."""
    s = min(1.0, sharpness / (MIN_SHARPNESS * 6))
    c = min(1.0, contrast / (MIN_CONTRAST * 4))
    return int(round(100 * (0.6 * s + 0.4 * c)))


def guide_crop(img):
    """
    The capture screen shows a finger guide in the middle of the frame (~40% of the
    width, ~2/3 of the height). Use only that region so the background does not
    dominate the vector.
    """
    h, w = img.shape[:2]
    cw, ch = int(w * 0.4), int(h * 0.667)
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    return img[y0:y0 + ch, x0:x0 + cw]


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


def embed_fingerprint_img(gray) -> list:
    """
    Stand-in fingerprint embedding (PRIMARY payment factor). Production: a certified
    fingerprint-scanner SDK / minutiae extractor (a certified scanner). Here we
    enhance the guide region and produce a normalized vector so the cosine pipeline
    works end-to-end. Same return shape as the production extractor.
    """
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
    return {"status": "PulsePay CV service running", "model": "local-cv:v1"}


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

        gray = cv2.cvtColor(guide_crop(img), cv2.COLOR_BGR2GRAY)
        sharpness, contrast, ok = quality(gray)
        if not ok:
            return {"error": "Finger not clear. Hold it steady inside the guide, in good light.",
                    "embedding": [], "quality": quality_score(sharpness, contrast)}

        return {"embedding": embed_fingerprint_img(gray), "quality": quality_score(sharpness, contrast),
                "model_version": "local-cv:v1"}
    except Exception as e:
        print(f"embed-fingerprint error: {e}")
        return {"error": str(e), "embedding": []}


@app.post("/embed-face")
async def embed_face(payload: dict = Body(default=None), image: UploadFile = File(default=None)):
    """
    Accepts JSON { image: <base64> } or a multipart file (the web app
    sends a multipart frame). Returns { embedding:[...], liveness_passed, pad_score, face_detected }.
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
            return {"face_detected": False, "liveness_passed": False, "pad_score": 0,
                    "error": "No face found. Look straight at the camera.", "embedding": []}
        if count > 1:
            return {"face_detected": True, "liveness_passed": False, "pad_score": 50,
                    "error": "More than one face in view. Only the customer should be in frame.", "embedding": []}
        x, y, w, h = bbox
        if w < img.shape[1] * 0.15:
            return {"face_detected": True, "liveness_passed": False, "pad_score": 0,
                    "error": "Move closer to the camera.", "embedding": []}
        sharpness, contrast, ok = quality(cv2.cvtColor(img[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY))
        if not ok:
            return {"face_detected": True, "liveness_passed": False, "pad_score": 0,
                    "error": "Face not clear. Hold steady in good light.", "embedding": []}

        # Placeholder PAD: NOT a liveness check (a printed photo passes). Production:
        # certified ISO/IEC 30107-3 PAD on the capture device.
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
