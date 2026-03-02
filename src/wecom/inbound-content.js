import { tmpdir } from "node:os";
import { join } from "node:path";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomInboundContentBuilder missing function dependency: ${name}`);
  }
}

function pickImageExtFromMime(imageMimeType) {
  const normalized = String(imageMimeType ?? "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  return "jpg";
}

function buildTempSuffix() {
  return Math.random().toString(36).slice(2);
}

export function createWecomInboundContentBuilder({
  tempDirName = "openclaw-wechat",
  downloadWecomMedia,
  fetchMediaFromUrl,
  resolveWecomVoiceTranscriptionConfig,
  transcribeInboundVoice,
  sendWecomText,
  ensureDir,
  writeFile,
  now = () => Date.now(),
  randomSuffix = buildTempSuffix,
  tmpDirResolver = tmpdir,
} = {}) {
  assertFunction("downloadWecomMedia", downloadWecomMedia);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("resolveWecomVoiceTranscriptionConfig", resolveWecomVoiceTranscriptionConfig);
  assertFunction("transcribeInboundVoice", transcribeInboundVoice);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("ensureDir", ensureDir);
  assertFunction("writeFile", writeFile);
  assertFunction("tmpDirResolver", tmpDirResolver);

  async function ensureTempDir() {
    const dir = join(tmpDirResolver(), tempDirName);
    await ensureDir(dir, { recursive: true });
    return dir;
  }

  async function buildInboundContent({
    api,
    corpId,
    corpSecret,
    agentId,
    proxyUrl,
    fromUser,
    msgType,
    baseText,
    mediaId,
    picUrl,
    recognition,
    fileName,
    fileSize,
    linkTitle,
    linkDescription,
    linkUrl,
  } = {}) {
    let messageText = String(baseText ?? "");
    const tempPathsToCleanup = [];

    if (msgType === "image" && mediaId) {
      api.logger.info?.(`wecom: downloading image mediaId=${mediaId}`);
      let imageBuffer = null;
      let imageMimeType = "";

      try {
        const { buffer, contentType } = await downloadWecomMedia({
          corpId,
          corpSecret,
          mediaId,
          proxyUrl,
          logger: api.logger,
        });
        imageBuffer = buffer;
        imageMimeType = contentType || "image/jpeg";
        api.logger.info?.(`wecom: image downloaded, size=${buffer.length} bytes, type=${imageMimeType}`);
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download image via mediaId: ${downloadErr.message}`);

        if (picUrl) {
          try {
            const { buffer, contentType } = await fetchMediaFromUrl(picUrl);
            imageBuffer = buffer;
            imageMimeType = contentType || "image/jpeg";
            api.logger.info?.(`wecom: image downloaded via PicUrl, size=${buffer.length} bytes`);
          } catch (picUrlErr) {
            api.logger.warn?.(`wecom: failed to download image via PicUrl: ${picUrlErr.message}`);
          }
        }
      }

      if (imageBuffer) {
        try {
          const ext = pickImageExtFromMime(imageMimeType);
          const tempDir = await ensureTempDir();
          const imageTempPath = join(tempDir, `image-${now()}-${randomSuffix()}.${ext}`);
          await writeFile(imageTempPath, imageBuffer);
          tempPathsToCleanup.push(imageTempPath);
          api.logger.info?.(`wecom: saved image to ${imageTempPath}`);
          messageText = `[用户发送了一张图片，已保存到: ${imageTempPath}]\n\n请使用 Read 工具查看这张图片并描述内容。`;
        } catch (saveErr) {
          api.logger.warn?.(`wecom: failed to save image: ${saveErr.message}`);
          messageText = "[用户发送了一张图片，但保存失败]\n\n请告诉用户图片处理暂时不可用。";
        }
      } else {
        messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
      }
    }

    if (msgType === "voice" && mediaId) {
      api.logger.info?.(`wecom: received voice message mediaId=${mediaId}`);
      const recognizedText = String(recognition ?? "").trim();
      if (recognizedText) {
        api.logger.info?.(`wecom: voice recognition result from WeCom: ${recognizedText.slice(0, 50)}...`);
        messageText = `[语音消息转写]\n${recognizedText}`;
      } else {
        const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
        if (!voiceConfig.enabled) {
          api.logger.info?.("wecom: voice transcription fallback disabled; asking user to send text");
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text: "语音识别未启用，请先开启企业微信语音识别，或直接发送文字消息。",
            logger: api.logger,
            proxyUrl,
          });
          return {
            aborted: true,
            messageText: "",
            tempPathsToCleanup,
          };
        }

        try {
          const { buffer, contentType } = await downloadWecomMedia({
            corpId,
            corpSecret,
            mediaId,
            proxyUrl,
            logger: api.logger,
          });
          api.logger.info?.(
            `wecom: downloaded voice media for transcription, size=${buffer.length}, type=${contentType || "unknown"}`,
          );
          const transcript = await transcribeInboundVoice({
            api,
            buffer,
            contentType,
            mediaId,
            voiceConfig,
          });
          messageText = `[语音消息转写]\n${transcript}`;
          api.logger.info?.(`wecom: voice transcribed via ${voiceConfig.model}: ${transcript.slice(0, 80)}...`);
        } catch (voiceErr) {
          api.logger.warn?.(`wecom: voice transcription failed: ${String(voiceErr?.message || voiceErr)}`);
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text:
              "语音识别失败，请稍后重试。\n" +
              "如持续失败，请确认本地 whisper 命令可用、模型路径已配置，并已安装 ffmpeg。",
            logger: api.logger,
            proxyUrl,
          });
          return {
            aborted: true,
            messageText: "",
            tempPathsToCleanup,
          };
        }
      }
    }

    if (msgType === "video" && mediaId) {
      api.logger.info?.(`wecom: received video message mediaId=${mediaId}`);
      try {
        const { buffer } = await downloadWecomMedia({
          corpId,
          corpSecret,
          mediaId,
          proxyUrl,
          logger: api.logger,
        });
        const tempDir = await ensureTempDir();
        const videoTempPath = join(tempDir, `video-${now()}-${randomSuffix()}.mp4`);
        await writeFile(videoTempPath, buffer);
        tempPathsToCleanup.push(videoTempPath);
        api.logger.info?.(`wecom: saved video to ${videoTempPath}, size=${buffer.length} bytes`);
        messageText = `[用户发送了一个视频文件，已保存到: ${videoTempPath}]\n\n请告知用户您已收到视频。`;
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download video: ${downloadErr.message}`);
        messageText = "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。";
      }
    }

    if (msgType === "file" && mediaId) {
      api.logger.info?.(`wecom: received file message mediaId=${mediaId}, fileName=${fileName}, size=${fileSize}`);
      try {
        const { buffer } = await downloadWecomMedia({
          corpId,
          corpSecret,
          mediaId,
          proxyUrl,
          logger: api.logger,
        });
        const ext = fileName ? fileName.split(".").pop() : "bin";
        const safeFileName = fileName || `file-${now()}.${ext}`;
        const tempDir = await ensureTempDir();
        const fileTempPath = join(tempDir, `${now()}-${safeFileName}`);
        await writeFile(fileTempPath, buffer);
        tempPathsToCleanup.push(fileTempPath);
        api.logger.info?.(`wecom: saved file to ${fileTempPath}, size=${buffer.length} bytes`);

        const readableTypes = [".txt", ".md", ".json", ".xml", ".csv", ".log", ".pdf"];
        const isReadable = readableTypes.some((t) => safeFileName.toLowerCase().endsWith(t));

        if (isReadable) {
          messageText = `[用户发送了一个文件: ${safeFileName}，已保存到: ${fileTempPath}]\n\n请使用 Read 工具查看这个文件的内容。`;
        } else {
          messageText = `[用户发送了一个文件: ${safeFileName}，大小: ${fileSize || buffer.length} 字节，已保存到: ${fileTempPath}]\n\n请告知用户您已收到文件。`;
        }
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download file: ${downloadErr.message}`);
        messageText = `[用户发送了一个文件${fileName ? `: ${fileName}` : ""}，但下载失败]\n\n请告诉用户文件处理暂时不可用。`;
      }
    }

    if (msgType === "link") {
      api.logger.info?.(`wecom: received link message title=${linkTitle}, url=${linkUrl}`);
      messageText = `[用户分享了一个链接]\n标题: ${linkTitle || "(无标题)"}\n描述: ${linkDescription || "(无描述)"}\n链接: ${linkUrl || "(无链接)"}\n\n请根据链接内容回复用户。如需要，可以使用 WebFetch 工具获取链接内容。`;
    }

    return {
      aborted: false,
      messageText,
      tempPathsToCleanup,
    };
  }

  return {
    buildInboundContent,
  };
}
