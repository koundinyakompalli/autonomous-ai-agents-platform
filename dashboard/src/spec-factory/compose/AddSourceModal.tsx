import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  ClipboardPaste,
  FileUp,
  Link2,
  Mic,
  Music,
  PenLine,
  Ticket,
  Video,
  X,
} from "lucide-react";

type UploadStatus = "uploading" | "uploaded" | "failed";
type ActiveSourceField =
  | "note"
  | "youtube"
  | "jira"
  | "confluence"
  | "record"
  | null;
type RecordingState = "idle" | "requesting" | "recording" | "recorded";

interface UploadItem {
  id: string;
  file: File;
  name: string;
  status: UploadStatus;
  errorMessage: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_UPLOAD_BYTES = 524_288_000;
const MAX_UPLOAD_LABEL = "500 MB";

function oversizedUploadMessage(): string {
  return `File exceeds maximum size of ${MAX_UPLOAD_LABEL}.`;
}

function isOversizedUpload(file: File): boolean {
  return file.size > MAX_UPLOAD_BYTES;
}

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/wav",
];

function preferredRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return (
    RECORDING_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ??
    ""
  );
}

function recordingExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remaining}`;
}

export function AddSourceModal({
  onClose,
  onUploadFiles,
  onAddNote,
  onAddYoutube,
  onAddJira,
  onAddConfluence,
  onPasteClipboard,
  pasteClipboardBusy = false,
}: {
  onClose: () => void;
  onUploadFiles: (files: File[]) => Promise<void> | void;
  onAddNote: (content: string) => void;
  onAddYoutube: (url: string) => void;
  onAddJira: (jiraKey: string) => void;
  onAddConfluence: (url: string) => void;
  onPasteClipboard?: () => Promise<boolean> | boolean;
  pasteClipboardBusy?: boolean;
}) {
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [jiraKey, setJiraKey] = useState("");
  const [confluenceUrl, setConfluenceUrl] = useState("");
  const [activeField, setActiveField] = useState<ActiveSourceField>(null);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const jiraInput = useRef<HTMLInputElement>(null);
  const confluenceInput = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);

  const uploading = uploadItems.some((item) => item.status === "uploading");
  const recording =
    recordingState === "requesting" || recordingState === "recording";
  const busy = uploading || recording || pasteClipboardBusy;

  function requestClose() {
    if (!busy) onClose();
  }

  function stopActiveStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function updateUploadItem(id: string, patch: Partial<UploadItem>) {
    setUploadItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function uploadOne(item: UploadItem): Promise<boolean> {
    if (isOversizedUpload(item.file)) {
      updateUploadItem(item.id, {
        status: "failed",
        errorMessage: oversizedUploadMessage(),
      });
      return false;
    }
    updateUploadItem(item.id, { status: "uploading", errorMessage: null });
    try {
      await onUploadFiles([item.file]);
      updateUploadItem(item.id, { status: "uploaded", errorMessage: null });
      return true;
    } catch (error) {
      updateUploadItem(item.id, {
        status: "failed",
        errorMessage: errorMessage(error),
      });
      return false;
    }
  }

  async function upload(files: FileList | File[] | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const items: UploadItem[] = list.map((file, index) => {
      const oversized = isOversizedUpload(file);
      return {
        id: `${Date.now()}-${index}-${file.name}`,
        file,
        name: file.name,
        status: oversized ? "failed" : "uploading",
        errorMessage: oversized ? oversizedUploadMessage() : null,
      };
    });
    setUploadItems(items);

    let allSucceeded = true;
    for (const item of items) {
      if (isOversizedUpload(item.file)) {
        allSucceeded = false;
        continue;
      }
      allSucceeded = (await uploadOne(item)) && allSucceeded;
    }
    if (allSucceeded) onClose();
  }

  async function startRecording() {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setRecordingError("Audio recording is not available in this browser.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setRecordingError("Audio recording is not available in this browser.");
      return;
    }

    setRecordingState("requesting");
    setRecordingError(null);
    setRecordedFile(null);
    setRecordingSeconds(0);
    recordingChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = preferredRecordingMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setRecordingError("Recording failed.");
        setRecordingState("idle");
        stopActiveStream();
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(recordingChunksRef.current, { type });
        stopActiveStream();
        recorderRef.current = null;
        if (blob.size === 0) {
          setRecordingError("No audio was captured.");
          setRecordingState("idle");
          return;
        }
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("Z", "");
        setRecordedFile(
          new File(
            [blob],
            `compose-recording-${timestamp}.${recordingExtension(type)}`,
            {
              type,
            },
          ),
        );
        setRecordingState("recorded");
      };
      recorder.start();
      setRecordingState("recording");
    } catch (error) {
      setRecordingError(errorMessage(error));
      setRecordingState("idle");
      stopActiveStream();
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
      return;
    }
    setRecordingState("idle");
    stopActiveStream();
  }

  function discardRecording() {
    setRecordedFile(null);
    setRecordingError(null);
    setRecordingSeconds(0);
    if (!recording) setRecordingState("idle");
  }

  async function uploadRecording() {
    if (!recordedFile) return;
    await upload([recordedFile]);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (activeField === "note") noteInput.current?.focus();
    if (activeField === "youtube") urlInput.current?.focus();
    if (activeField === "jira") jiraInput.current?.focus();
    if (activeField === "confluence") confluenceInput.current?.focus();
  }, [activeField]);

  useEffect(() => {
    if (recordingState !== "recording") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setRecordingSeconds(
        Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 500);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      stopActiveStream();
    },
    [],
  );

  const modal = (
    <div
      className="sf-source-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        className="sf-source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-add-source-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          className="sf-source-close"
          type="button"
          aria-label="Close add sources"
          onClick={requestClose}
          disabled={busy}
        >
          <X size={28} aria-hidden="true" />
        </button>

        <header className="sf-source-modal-header">
          <h2 id="sf-add-source-title">
            Add sources
            <span>for your Epic</span>
          </h2>
          <p>
            Choose the material that explains intent, constraints, and
            acceptance criteria.
          </p>
        </header>

        <input
          ref={fileInput}
          type="file"
          multiple
          aria-label="Upload files"
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={videoInput}
          type="file"
          multiple
          accept="video/*"
          aria-label="Upload video"
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={audioInput}
          type="file"
          multiple
          accept="audio/*"
          aria-label="Upload audio"
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
        />

        <div
          className="sf-source-option-grid"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            upload(e.dataTransfer.files);
          }}
        >
          <SourceOption
            icon={<FileUp size={30} aria-hidden="true" />}
            title="Files"
            description="PDFs, docs, slides, sheets, images"
            onClick={() => fileInput.current?.click()}
          />
          <SourceOption
            icon={<Video size={30} aria-hidden="true" />}
            title="Video"
            description="Upload a demo, screen recording, or walkthrough"
            onClick={() => videoInput.current?.click()}
          />
          <SourceOption
            icon={<Music size={30} aria-hidden="true" />}
            title="Audio"
            description="Upload call audio or voice notes"
            onClick={() => audioInput.current?.click()}
          />
          <SourceOption
            icon={<Link2 size={30} aria-hidden="true" />}
            title="YouTube"
            description="Paste a video or web URL below"
            active={activeField === "youtube"}
            onClick={() => setActiveField("youtube")}
          />
          <SourceOption
            icon={<PenLine size={30} aria-hidden="true" />}
            title="Sketch Pad"
            description="Capture manual notes below"
            active={activeField === "note"}
            onClick={() => setActiveField("note")}
          />
          <SourceOption
            icon={<Ticket size={30} aria-hidden="true" />}
            title="Jira"
            description="Fetch issue details, comments, and attachments"
            active={activeField === "jira"}
            onClick={() => setActiveField("jira")}
          />
          <SourceOption
            icon={<BookOpen size={30} aria-hidden="true" />}
            title="Confluence"
            description="Convert a Confluence page to markdown"
            active={activeField === "confluence"}
            onClick={() => setActiveField("confluence")}
          />
          <SourceOption
            icon={<Mic size={30} aria-hidden="true" />}
            title="Record Audio"
            description="Capture a fresh voice note"
            active={activeField === "record"}
            onClick={() => setActiveField("record")}
          />
          <SourceOption
            icon={<ClipboardPaste size={30} aria-hidden="true" />}
            title="Clipboard"
            description="Paste copied text, an image, or a PDF"
            disabled={!onPasteClipboard || pasteClipboardBusy}
            onClick={() => {
              if (!onPasteClipboard) return;
              void Promise.resolve(onPasteClipboard()).then((added) => {
                if (added) onClose();
              });
            }}
          />
        </div>

        {uploadItems.length > 0 ? (
          <ul className="sf-upload-status-list" aria-label="Upload status">
            {uploadItems.map((item) => (
              <li
                key={item.id}
                className={`sf-upload-status is-${item.status}`}
              >
                <span>{item.name}</span>
                <strong>
                  {item.status === "uploading"
                    ? "Uploading"
                    : item.status === "uploaded"
                      ? "Uploaded"
                      : "Failed"}
                </strong>
                {item.errorMessage ? <em>{item.errorMessage}</em> : null}
                {item.status === "failed" ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (await uploadOne(item)) onClose();
                    }}
                    aria-label={`Retry ${item.name}`}
                  >
                    Retry
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {activeField ? (
          <div className="sf-add-source-fields" aria-live="polite">
            {activeField === "note" ? (
              <div className="sf-add-source-field">
                <label htmlFor="sf-add-source-note">
                  Sketch pad / manual notes
                </label>
                <textarea
                  ref={noteInput}
                  id="sf-add-source-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Write notes, acceptance criteria, constraints, or implementation hints..."
                />
                <button
                  type="button"
                  className="sf-button sf-button-primary"
                  disabled={note.trim().length === 0}
                  onClick={() => {
                    onAddNote(note.trim());
                    setNote("");
                    onClose();
                  }}
                >
                  Add note
                </button>
              </div>
            ) : null}

            {activeField === "youtube" ? (
              <div className="sf-add-source-field">
                <label htmlFor="sf-add-source-url">YouTube or web URL</label>
                <div className="sf-add-source-url-row">
                  <span aria-hidden="true">
                    <Link2 size={18} />
                  </span>
                  <input
                    ref={urlInput}
                    id="sf-add-source-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://youtu.be/..."
                  />
                  <button
                    type="button"
                    className="sf-button sf-button-primary"
                    disabled={url.trim().length === 0}
                    onClick={() => {
                      onAddYoutube(url.trim());
                      setUrl("");
                      onClose();
                    }}
                  >
                    Add URL
                  </button>
                </div>
              </div>
            ) : null}

            {activeField === "jira" ? (
              <div className="sf-add-source-field">
                <label htmlFor="sf-add-source-jira">Jira issue key</label>
                <div className="sf-add-source-url-row">
                  <span aria-hidden="true">
                    <Ticket size={18} />
                  </span>
                  <input
                    ref={jiraInput}
                    id="sf-add-source-jira"
                    value={jiraKey}
                    onChange={(e) => setJiraKey(e.target.value)}
                    placeholder="CPDEV-123"
                  />
                  <button
                    type="button"
                    className="sf-button sf-button-primary"
                    disabled={jiraKey.trim().length === 0}
                    onClick={() => {
                      onAddJira(jiraKey.trim());
                      setJiraKey("");
                      onClose();
                    }}
                  >
                    Add Jira
                  </button>
                </div>
              </div>
            ) : null}

            {activeField === "confluence" ? (
              <div className="sf-add-source-field">
                <label htmlFor="sf-add-source-confluence">
                  Confluence page URL
                </label>
                <div className="sf-add-source-url-row">
                  <span aria-hidden="true">
                    <BookOpen size={18} />
                  </span>
                  <input
                    ref={confluenceInput}
                    id="sf-add-source-confluence"
                    value={confluenceUrl}
                    onChange={(e) => setConfluenceUrl(e.target.value)}
                    placeholder="https://.../wiki/spaces/..."
                  />
                  <button
                    type="button"
                    className="sf-button sf-button-primary"
                    disabled={confluenceUrl.trim().length === 0}
                    onClick={() => {
                      onAddConfluence(confluenceUrl.trim());
                      setConfluenceUrl("");
                      onClose();
                    }}
                  >
                    Add Confluence
                  </button>
                </div>
              </div>
            ) : null}

            {activeField === "record" ? (
              <div className="sf-add-source-field sf-record-source-field">
                <label>Record audio</label>
                <div className="sf-recording-status" role="status">
                  <span>
                    <Mic size={18} aria-hidden="true" />
                  </span>
                  <strong>
                    {recordingState === "recording"
                      ? "Recording"
                      : recordingState === "requesting"
                        ? "Starting"
                        : recordedFile
                          ? recordedFile.name
                          : "Ready"}
                  </strong>
                  <small>{formatDuration(recordingSeconds)}</small>
                </div>
                {recordingError ? (
                  <p className="sf-recording-error" role="alert">
                    {recordingError}
                  </p>
                ) : null}
                <div className="sf-recording-actions">
                  <button
                    type="button"
                    className="sf-button"
                    onClick={() => void startRecording()}
                    disabled={recording}
                  >
                    Start recording
                  </button>
                  <button
                    type="button"
                    className="sf-button"
                    onClick={stopRecording}
                    disabled={recordingState !== "recording"}
                  >
                    Stop recording
                  </button>
                  <button
                    type="button"
                    className="sf-button"
                    onClick={discardRecording}
                    disabled={!recordedFile || recording}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="sf-button sf-button-primary"
                    onClick={() => void uploadRecording()}
                    disabled={!recordedFile || uploading || recording}
                  >
                    Upload recording
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );

  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}

function SourceOption({
  icon,
  title,
  description,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`sf-source-option-tile${active ? " is-active" : ""}`}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      aria-label={title}
      disabled={disabled}
    >
      <span className="sf-source-option-icon">{icon}</span>
      <strong>{title}</strong>
      <small>{description}</small>
    </button>
  );
}
