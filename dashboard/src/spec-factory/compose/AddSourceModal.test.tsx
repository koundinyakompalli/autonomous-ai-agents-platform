// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AddSourceModal } from "./AddSourceModal.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AddSourceModal", () => {
  it("renders a dialog with file, note, and url affordances and closes", () => {
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: /Add sources/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Files/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Video/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Audio$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /YouTube/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sketch Pad/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Jira$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Confluence$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Clipboard$/i })).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Record Audio/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText(/Record Audio is a placeholder/i)).toBeNull();
    expect(screen.queryByLabelText("Sketch pad / manual notes")).toBeNull();
    expect(screen.queryByLabelText(/YouTube or web URL/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Close add sources/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("adds clipboard content through the shared ingestion path and closes", async () => {
    const onPasteClipboard = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
        onPasteClipboard={onPasteClipboard}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Clipboard$/i }));

    await waitFor(() => expect(onPasteClipboard).toHaveBeenCalledOnce());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("reveals one input panel when a source tile is selected", () => {
    render(
      <AddSourceModal
        onClose={vi.fn()}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /YouTube/i }));
    expect(screen.getByLabelText(/YouTube or web URL/i)).toBeTruthy();
    expect(screen.queryByLabelText("Sketch pad / manual notes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Sketch Pad/i }));
    expect(screen.getByLabelText("Sketch pad / manual notes")).toBeTruthy();
    expect(screen.queryByLabelText(/YouTube or web URL/i)).toBeNull();
  });

  it("submits a note and closes", () => {
    const onAddNote = vi.fn();
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={vi.fn()}
        onAddNote={onAddNote}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sketch Pad/i }));
    fireEvent.change(screen.getByLabelText("Sketch pad / manual notes"), {
      target: { value: "Repo is billing-service" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add note$/i }));
    expect(onAddNote).toHaveBeenCalledWith("Repo is billing-service");
    expect(onClose).toHaveBeenCalled();
  });

  it("uploads selected files and closes after upload succeeds", async () => {
    const onUploadFiles = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={onUploadFiles}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    const file = new File(["hello"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Upload files/i), {
      target: { files: [file] },
    });
    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledWith([file]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("records browser audio and uploads the generated file", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      state: MediaRecorder["state"] = "inactive";
      mimeType: string;
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? "audio/webm";
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["voice"], { type: this.mimeType }),
        } as BlobEvent);
        this.onstop?.();
      }
    }
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onUploadFiles = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={onUploadFiles}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Record Audio/i }));
    fireEvent.click(screen.getByRole("button", { name: /Start recording/i }));
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /Stop recording/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /Stop recording/i }));

    await screen.findByText(/compose-recording-/i);
    fireEvent.click(screen.getByRole("button", { name: /Upload recording/i }));

    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledTimes(1));
    const uploaded = onUploadFiles.mock.calls[0][0][0] as File;
    expect(uploaded.name).toMatch(/^compose-recording-.*\.webm$/);
    expect(uploaded.type).toBe("audio/webm;codecs=opus");
    expect(stopTrack).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows a recording error when the browser has no recorder support", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: undefined,
    });
    render(
      <AddSourceModal
        onClose={vi.fn()}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Record Audio/i }));
    fireEvent.click(screen.getByRole("button", { name: /Start recording/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /not available/i,
    );
  });

  it("keeps the modal open and shows an upload error when browser upload fails", async () => {
    const onUploadFiles = vi
      .fn()
      .mockRejectedValue(new Error("Upload failed with 403"));
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={onUploadFiles}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    const file = new File(["hello"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Upload files/i), {
      target: { files: [file] },
    });

    await screen.findByText(/Upload failed with 403/i);
    expect(screen.getByRole("dialog", { name: /Add sources/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects oversized files before requesting an upload target", async () => {
    const onUploadFiles = vi.fn();
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={onUploadFiles}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    const file = new File(["x"], "huge.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 524_288_001 });

    fireEvent.change(screen.getByLabelText(/Upload files/i), {
      target: { files: [file] },
    });

    await screen.findByText(/maximum size/i);
    expect(onUploadFiles).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retries a failed browser upload and closes after retry succeeds", async () => {
    const onUploadFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error("Upload failed with 403"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={onUploadFiles}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    const file = new File(["hello"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Upload files/i), {
      target: { files: [file] },
    });

    const retry = await screen.findByRole("button", {
      name: /Retry spec.pdf/i,
    });
    fireEvent.click(retry);

    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("submits a youtube url", () => {
    const onAddYoutube = vi.fn();
    render(
      <AddSourceModal
        onClose={vi.fn()}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={onAddYoutube}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /YouTube/i }));
    fireEvent.change(screen.getByLabelText(/YouTube or web URL/i), {
      target: { value: "https://youtu.be/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add URL/i }));
    expect(onAddYoutube).toHaveBeenCalledWith("https://youtu.be/x");
  });

  it("submits a Jira key", () => {
    const onAddJira = vi.fn();
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={onAddJira}
        onAddConfluence={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Jira$/i }));
    fireEvent.change(screen.getByLabelText(/Jira issue key/i), {
      target: { value: "cpdev-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Jira/i }));
    expect(onAddJira).toHaveBeenCalledWith("cpdev-123");
    expect(onClose).toHaveBeenCalled();
  });

  it("submits a Confluence page URL", () => {
    const onAddConfluence = vi.fn();
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={onAddConfluence}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Confluence$/i }));
    fireEvent.change(screen.getByLabelText(/Confluence page URL/i), {
      target: { value: "https://wiki.example.com/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Confluence/i }));
    expect(onAddConfluence).toHaveBeenCalledWith("https://wiki.example.com/x");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <AddSourceModal
        onClose={onClose}
        onUploadFiles={vi.fn()}
        onAddNote={vi.fn()}
        onAddYoutube={vi.fn()}
        onAddJira={vi.fn()}
        onAddConfluence={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
