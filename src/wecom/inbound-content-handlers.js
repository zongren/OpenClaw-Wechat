import { createInboundFileVideoLinkHandlers } from "./inbound-content-handler-file-video-link.js";
import { createInboundImageVoiceHandlers } from "./inbound-content-handler-image-voice.js";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomInboundMessageTypeHandlers missing function dependency: ${name}`);
  }
}

export function createWecomInboundMessageTypeHandlers({
  downloadWecomMedia,
  fetchMediaFromUrl,
  resolveWecomVoiceTranscriptionConfig,
  transcribeInboundVoice,
  sendWecomText,
  ensureTempDir,
  writeFile,
  now,
  randomSuffix,
} = {}) {
  assertFunction("downloadWecomMedia", downloadWecomMedia);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("resolveWecomVoiceTranscriptionConfig", resolveWecomVoiceTranscriptionConfig);
  assertFunction("transcribeInboundVoice", transcribeInboundVoice);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("ensureTempDir", ensureTempDir);
  assertFunction("writeFile", writeFile);
  assertFunction("now", now);
  assertFunction("randomSuffix", randomSuffix);

  return {
    ...createInboundImageVoiceHandlers({
      downloadWecomMedia,
      fetchMediaFromUrl,
      resolveWecomVoiceTranscriptionConfig,
      transcribeInboundVoice,
      sendWecomText,
      ensureTempDir,
      writeFile,
      now,
      randomSuffix,
    }),
    ...createInboundFileVideoLinkHandlers({
      downloadWecomMedia,
      ensureTempDir,
      writeFile,
      now,
      randomSuffix,
    }),
  };
}
