// Запись экрана средствами браузера: getDisplayMedia + MediaRecorder, файл скачивается сам.
let rec: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];

export function recorderSupported(): boolean {
  return typeof window !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
}

export function isRecording(): boolean {
  return rec?.state === "recording";
}

export async function startRecording(onStop: () => void): Promise<void> {
  // preferCurrentTab — Chrome сразу предложит текущую вкладку
  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.onstop = () => {
    const type = rec?.mimeType || "video/webm";
    const blob = new Blob(chunks, { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bagdar-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${type.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    rec = null;
    onStop();
  };
  // пользователь нажал «Прекратить доступ» в браузере — тоже конец записи
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (rec?.state === "recording") rec.stop();
  });
  rec.start(1000);
}

export function stopRecording(): void {
  if (rec?.state === "recording") rec.stop();
}
