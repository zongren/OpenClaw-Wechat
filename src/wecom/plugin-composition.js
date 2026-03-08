import { createPluginProcessingDeps } from "./plugin-processing-deps.js";
import { createPluginRouteRuntimeDeps } from "./plugin-route-runtime-deps.js";
import { createWecomPluginProcessingPipeline } from "./plugin-processing-pipeline.js";
import { createWecomPluginRouteRuntime } from "./plugin-route-runtime.js";
import { createWecomPluginServices } from "./plugin-services.js";

const services = createWecomPluginServices();

const processingDeps = createPluginProcessingDeps({
  ...services,
});
const { processBotInboundMessage, processInboundMessage, scheduleTextInboundProcessing } =
  createWecomPluginProcessingPipeline(processingDeps);

services.setWecomBotLongConnectionInboundProcessor(processBotInboundMessage);

const routeRuntimeDeps = createPluginRouteRuntimeDeps({
  ...services,
  processBotInboundMessage,
  processInboundMessage,
  scheduleTextInboundProcessing,
  wecomChannelPlugin: services.WecomChannelPlugin,
});
const { registerWecomRuntime } = createWecomPluginRouteRuntime(routeRuntimeDeps);

function register(api) {
  return registerWecomRuntime(api);
}

const internal = {
  buildWecomSessionId: services.buildWecomSessionId,
  buildInboundDedupeKey: services.buildInboundDedupeKey,
  markInboundMessageSeen: services.markInboundMessageSeen,
  resetInboundMessageDedupeForTests: services.resetInboundMessageDedupeForTests,
  splitWecomText: services.splitWecomText,
  getByteLength: services.getByteLength,
  computeMsgSignature: services.computeMsgSignature,
  pickAccountBySignature: services.pickAccountBySignature,
  buildWecomMessageSendRequest: services.buildWecomMessageSendRequest,
  resolveWecomWebhookTargetConfig: services.resolveWecomWebhookTargetConfig,
  buildMediaFetchErrorMessage: services.buildMediaFetchErrorMessage,
  inferFilenameFromMediaDownload: services.inferFilenameFromMediaDownload,
  smartDecryptWecomFileBuffer: services.smartDecryptWecomFileBuffer,
};

export function createWecomPluginRuntimeComposition() {
  return {
    register,
    internal,
  };
}
