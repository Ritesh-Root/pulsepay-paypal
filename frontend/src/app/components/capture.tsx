import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, Camera } from "lucide-react";
import { cn } from "./ui/utils";
import { embed } from "../lib/api";

type Phase = "idle" | "starting" | "ready" | "scanning" | "done" | "error";

export type CaptureResult = { embedding: number[]; liveness_passed?: boolean; pad_score?: number };

// Real webcam capture. In production the primary factor is a fingerprint on an
// AePS scanner; this web demo uses the camera as a stand-in and sends the frame
// to the India-resident CV service, which returns a vector (no image is stored).
export function Capture({
  endpoint,
  label = "Align within the frame",
  requireLiveness = false,
  onResult,
}: {
  endpoint: "fingerprint" | "face";
  label?: string;
  requireLiveness?: boolean;
  onResult: (r: CaptureResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setPhase("ready");
      } catch {
        setErr("Camera access denied. Enable the camera to continue.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  async function grab() {
    const v = videoRef.current;
    if (!v) return;
    setPhase("scanning");
    setErr("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 480;
      canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.9));
      const r = await embed(endpoint, blob);
      if (r.error || !r.embedding || r.embedding.length === 0) {
        setErr(r.error || "No biometric detected. Try again.");
        setPhase("ready");
        return;
      }
      if (requireLiveness && r.liveness_passed === false) {
        setErr("Liveness check failed. Hold steady and retry.");
        setPhase("ready");
        return;
      }
      setPhase("done");
      onResult({ embedding: r.embedding, liveness_passed: r.liveness_passed, pad_score: r.pad_score });
    } catch {
      setErr("Capture failed. Try again.");
      setPhase("ready");
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative">
        <div className="relative h-60 w-60 overflow-hidden rounded-[28px] border border-[var(--hairline)] bg-gradient-to-br from-[var(--chip)] to-background">
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-40 w-32 rounded-[40%] border border-dashed border-foreground/30" />
          </div>
          {phase === "scanning" && (
            <motion.div
              initial={{ y: -8 }} animate={{ y: 248 }} transition={{ duration: 1.0, ease: "easeInOut", repeat: Infinity }}
              className="absolute left-0 right-0 h-px bg-foreground/70 shadow-[0_0_18px_2px_rgba(0,0,0,0.25)]"
            />
          )}
          {phase === "done" && (
            <motion.div
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 520, damping: 30 }}
              className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-sm"
            >
              <div className="grid h-14 w-14 place-items-center rounded-full bg-foreground text-background">
                <Check className="h-7 w-7" strokeWidth={2.4} />
              </div>
            </motion.div>
          )}
        </div>
        <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--hairline)] bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">
          {phase === "starting" && "Starting camera…"}
          {phase === "ready" && "Ready"}
          {phase === "scanning" && <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Matching…</span>}
          {phase === "done" && "Captured ✓"}
          {phase === "error" && "Camera off"}
        </div>
      </div>

      <p className="max-w-xs text-center text-sm text-muted-foreground">{label}</p>
      {err && <p className="text-center text-xs text-red-500">{err}</p>}

      <button
        type="button"
        disabled={phase === "scanning" || phase === "starting" || phase === "error"}
        onClick={() => (phase === "done" ? setPhase("ready") : grab())}
        className={cn("inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2 text-sm text-background transition hover:opacity-90 active:scale-[0.98]", (phase === "scanning" || phase === "starting") && "opacity-60")}
      >
        <Camera className="h-4 w-4" />
        {phase === "done" ? "Recapture" : phase === "scanning" ? "Scanning…" : "Capture"}
      </button>
    </div>
  );
}
