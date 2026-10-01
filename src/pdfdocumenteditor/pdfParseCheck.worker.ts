import {
  readAsTheEditorWould,
  stopStreamsDecodingPastLimit,
} from "./pdfParseCheck";

stopStreamsDecodingPastLimit();

self.addEventListener("message", async (event: MessageEvent<Uint8Array>) => {
  self.postMessage(await readAsTheEditorWould(event.data));
});
