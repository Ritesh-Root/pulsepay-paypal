/**
 * Nova 2 Sonic Voice Confirmation Service
 *
 * Uses Amazon Nova 2 Sonic (amazon.nova-2-sonic-v1:0) via AWS Bedrock's
 * bidirectional streaming API (InvokeModelWithBidirectionalStream).
 *
 * Implementation follows the official AWS sample:
 * https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech/amazon-nova-2-sonic
 *
 * Event protocol:
 *   sessionStart -> promptStart -> contentStart(SYSTEM) -> textInput -> contentEnd
 *   -> contentStart(USER/TEXT) -> textInput -> contentEnd -> promptEnd
 *   <- audioOutput chunks <- contentEnd <- sessionEnd
 *
 * Output audio: PCM 24kHz 16-bit mono, base64 encoded (audio/lpcm)
 */

const {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const { NodeHttp2Handler } = require('@smithy/node-http-handler');
const { randomUUID } = require('crypto');

const MODEL_ID = 'amazon.nova-2-sonic-v1:0';

const AUDIO_OUTPUT_CONFIG = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 24000,
  sampleSizeBits: 16,
  channelCount: 1,
  voiceId: 'tiffany',
  encoding: 'base64',
  audioType: 'SPEECH',
};

const TEXT_CONFIG = { mediaType: 'text/plain' };

const INFERENCE_CONFIG = {
  maxTokens: 1024,
  topP: 0.9,
  temperature: 0.3,
};

const SYSTEM_PROMPT =
  'You are PulsePay, a secure biometric payment assistant. ' +
  'Read payment confirmations clearly and professionally in a warm, confident tone. ' +
  'Keep your response to exactly the confirmation text provided — do not add extra commentary.';

let _client = null;

/** Lazy-initialize the Bedrock client with HTTP/2 handler. */
function getClient() {
  if (_client) return _client;

  const region = process.env.AWS_REGION || 'us-east-1';

  const credentials = {};
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    credentials.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    credentials.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (process.env.AWS_SESSION_TOKEN) {
      credentials.sessionToken = process.env.AWS_SESSION_TOKEN;
    }
  }

  const handler = new NodeHttp2Handler({
    requestTimeout: 300000,
    sessionTimeout: 300000,
    disableConcurrentStreams: false,
    maxConcurrentStreams: 20,
  });

  _client = new BedrockRuntimeClient({
    region,
    ...(credentials.accessKeyId ? { credentials } : {}),
    requestHandler: handler,
  });

  return _client;
}

/** Build the confirmation text Nova Sonic should speak. */
function buildConfirmationText({ amount, merchant_name, transaction_id }) {
  const rupees = Math.round(Number(amount));
  const shortId = transaction_id ? String(transaction_id).slice(-6) : '000000';
  const merchant = merchant_name || 'the merchant';
  return (
    `Payment of ${rupees} rupees to ${merchant} has been confirmed. ` +
    `Your transaction reference is T-X-N-${shortId}. Thank you for using PulsePay.`
  );
}

/** Encode an event object into the format expected by the bidirectional stream. */
function encodeEvent(event) {
  return {
    chunk: {
      bytes: new TextEncoder().encode(JSON.stringify(event)),
    },
  };
}

/**
 * Send text to Nova 2 Sonic and collect audio output.
 *
 * @param {string} confirmationText - The text for Nova Sonic to vocalize
 * @returns {{ audio_base64: string|null, text: string }}
 */
async function invokeNovaSonic(confirmationText) {
  const client = getClient();
  const promptName = randomUUID();
  const systemContentId = randomUUID();
  const userContentId = randomUUID();

  // Build the event queue
  const eventQueue = [];
  let queueIndex = 0;
  let resolveWaiting = null;
  let done = false;

  function enqueue(event) {
    eventQueue.push(encodeEvent(event));
    if (resolveWaiting) {
      resolveWaiting();
      resolveWaiting = null;
    }
  }

  // 1. Session start
  enqueue({
    event: {
      sessionStart: {
        inferenceConfiguration: INFERENCE_CONFIG,
      },
    },
  });

  // 2. Prompt start with audio output config
  enqueue({
    event: {
      promptStart: {
        promptName,
        textOutputConfiguration: TEXT_CONFIG,
        audioOutputConfiguration: AUDIO_OUTPUT_CONFIG,
      },
    },
  });

  // 3. System prompt: contentStart -> textInput -> contentEnd
  enqueue({
    event: {
      contentStart: {
        promptName,
        contentName: systemContentId,
        type: 'TEXT',
        interactive: false,
        role: 'SYSTEM',
        textInputConfiguration: TEXT_CONFIG,
      },
    },
  });

  enqueue({
    event: {
      textInput: {
        promptName,
        contentName: systemContentId,
        content: SYSTEM_PROMPT,
      },
    },
  });

  enqueue({
    event: {
      contentEnd: {
        promptName,
        contentName: systemContentId,
      },
    },
  });

  // 4. User text input: contentStart -> textInput -> contentEnd
  enqueue({
    event: {
      contentStart: {
        promptName,
        contentName: userContentId,
        type: 'TEXT',
        interactive: false,
        role: 'USER',
        textInputConfiguration: TEXT_CONFIG,
      },
    },
  });

  enqueue({
    event: {
      textInput: {
        promptName,
        contentName: userContentId,
        content: confirmationText,
      },
    },
  });

  enqueue({
    event: {
      contentEnd: {
        promptName,
        contentName: userContentId,
      },
    },
  });

  // 5. Prompt end — triggers audio generation
  enqueue({
    event: {
      promptEnd: {
        promptName,
      },
    },
  });

  // Create async iterable that yields queued events
  const inputStream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queueIndex < eventQueue.length) {
            const value = eventQueue[queueIndex++];
            return { value, done: false };
          }

          if (done) {
            return { value: undefined, done: true };
          }

          // Wait for new events or completion
          await new Promise((resolve) => {
            resolveWaiting = resolve;
          });

          if (done) {
            return { value: undefined, done: true };
          }

          if (queueIndex < eventQueue.length) {
            const value = eventQueue[queueIndex++];
            return { value, done: false };
          }

          return { value: undefined, done: true };
        },
      };
    },
  };

  const command = new InvokeModelWithBidirectionalStreamCommand({
    modelId: MODEL_ID,
    body: inputStream,
  });

  const response = await client.send(command);

  // Collect audio chunks from response stream
  const audioChunks = [];
  const transcriptParts = [];

  for await (const event of response.body) {
    if (event.chunk?.bytes) {
      try {
        const text = new TextDecoder().decode(event.chunk.bytes);
        const json = JSON.parse(text);

        if (json.event?.audioOutput?.content) {
          audioChunks.push(json.event.audioOutput.content);
        }

        if (json.event?.textOutput?.content) {
          transcriptParts.push(json.event.textOutput.content);
        }

        if (json.event?.sessionEnd) {
          done = true;
          if (resolveWaiting) resolveWaiting();
        }
      } catch {
        // Skip unparseable chunks
      }
    }
  }

  // Signal input stream done
  done = true;
  if (resolveWaiting) resolveWaiting();

  // Combine base64 audio chunks into single payload
  const combinedAudio =
    audioChunks.length > 0
      ? Buffer.concat(audioChunks.map((b64) => Buffer.from(b64, 'base64'))).toString('base64')
      : null;

  return {
    audio_base64: combinedAudio,
    text: transcriptParts.length > 0 ? transcriptParts.join('') : confirmationText,
  };
}

/**
 * Generate a spoken payment confirmation via Nova 2 Sonic.
 *
 * @param {{ amount: number, merchant_name: string, transaction_id: string }} transactionDetails
 * @returns {{ audio_base64: string|null, text: string, voice_enabled: boolean, source: string, audio_format?: object }}
 */
async function generateSpokenConfirmation(transactionDetails) {
  const confirmationText = buildConfirmationText(transactionDetails);

  try {
    const result = await invokeNovaSonic(confirmationText);

    return {
      audio_base64: result.audio_base64,
      text: result.text,
      voice_enabled: !!result.audio_base64,
      source: 'nova_sonic',
      audio_format: result.audio_base64
        ? {
            sampleRateHertz: 24000,
            bitsPerSample: 16,
            channelCount: 1,
            encoding: 'pcm',
          }
        : undefined,
    };
  } catch (error) {
    console.error('[nova-sonic] Bedrock call failed, falling back to text-only:', error.message);

    return {
      audio_base64: null,
      text: confirmationText,
      voice_enabled: false,
      source: 'fallback',
    };
  }
}

module.exports = { generateSpokenConfirmation };
