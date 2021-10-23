const decoderReady = new Promise((resolve) => {
  ready = resolve;
});

class MPEGDecodedAudio {
  constructor(channelData, samplesDecoded, sampleRate) {
    this.channelData = channelData;
    this.samplesDecoded = samplesDecoded;
    this.sampleRate = sampleRate;
  }
}

class MPEGDecoder {
  constructor() {
    this.ready.then(() => this._createDecoder());
    this._sampleRate = 0;
  }

  get ready() {
    return decoderReady;
  }

  static concatFloat32(buffers, length) {
    const ret = new Float32Array(length);

    let offset = 0;
    for (const buf of buffers) {
      ret.set(buf, offset);
      offset += buf.length;
    }

    return ret;
  }

  _createOutputArray(length) {
    const pointer = _malloc(Float32Array.BYTES_PER_ELEMENT * length);
    const array = new Float32Array(HEAPF32.buffer, pointer, length);
    return [pointer, array];
  }

  _createDecoder() {
    this._decoder = _mpeg_frame_decoder_create();

    // max theoretical size of a MPEG frame (MPEG 2.5 Layer II, 8000 Hz @ 160 kbps, with a padding slot)
    // https://www.mars.org/pipermail/mad-dev/2002-January/000425.html
    this._framePtrSize = 2889;
    this._framePtr = _malloc(this._framePtrSize);

    // max samples per MPEG frame
    [this._leftPtr, this._leftArr] = this._createOutputArray(4 * 1152);
    [this._rightPtr, this._rightArr] = this._createOutputArray(4 * 1152);
  }

  free() {
    _mpeg_frame_decoder_destroy(this._decoder);

    _free(this._framePtr);
    _free(this._leftPtr);
    _free(this._rightPtr);

    this._sampleRate = 0;
  }

  decode(data) {
    let left = [],
      right = [],
      samples = 0,
      offset = 0;

    while (offset < data.length) {
      const { channelData, samplesDecoded } = this.decodeFrame(
        data.subarray(offset, offset + this._framePtrSize)
      );

      left.push(channelData[0]);
      right.push(channelData[1]);
      samples += samplesDecoded;

      offset += this._framePtrSize;
    }

    return new MPEGDecodedAudio(
      [
        MPEGDecoder.concatFloat32(left, samples),
        MPEGDecoder.concatFloat32(right, samples),
      ],
      samples,
      this._sampleRate
    );
  }

  decodeFrame(mpegFrame) {
    HEAPU8.set(mpegFrame, this._framePtr);

    const samplesDecoded = _mpeg_decode_float_deinterleaved(
      this._decoder,
      this._framePtr,
      mpegFrame.length,
      this._leftPtr,
      this._rightPtr
    );

    if (!this._sampleRate)
      this._sampleRate = _mpeg_get_sample_rate(this._decoder);

    return new MPEGDecodedAudio(
      [
        this._leftArr.slice(0, samplesDecoded),
        this._rightArr.slice(0, samplesDecoded),
      ],
      samplesDecoded,
      this._sampleRate
    );
  }

  decodeFrames(mpegFrames) {
    let left = [],
      right = [],
      samples = 0;

    mpegFrames.forEach((frame) => {
      const { channelData, samplesDecoded } = this.decodeFrame(frame);

      left.push(channelData[0]);
      right.push(channelData[1]);
      samples += samplesDecoded;
    });

    return new MPEGDecodedAudio(
      [
        MPEGDecoder.concatFloat32(left, samples),
        MPEGDecoder.concatFloat32(right, samples),
      ],
      samples,
      this._sampleRate
    );
  }
}

/*******************
 *    Web Worker   *
 *******************/

if (typeof importScripts === "function") {
  // We're in a Web Worker
  let decoder = new MPEGDecoder();

  const detachBuffers = (buffer) =>
    Array.isArray(buffer)
      ? buffer.map((buffer) => new Uint8Array(buffer))
      : new Uint8Array(buffer);

  self.onmessage = function (msg) {
    decoder.ready.then(() => {
      switch (msg.data.command) {
        case "ready":
          self.postMessage({
            command: "ready",
          });
          break;
        case "free":
          decoder.free();
          self.postMessage({
            command: "free",
          });
          break;
        case "reset":
          decoder.free();
          decoder = new MPEGDecoder();
          self.postMessage({
            command: "reset",
          });
          break;
        case "decode":
        case "decodeFrame":
        case "decodeFrames":
          const { channelData, samplesDecoded, sampleRate } = decoder[
            msg.data.command
          ](detachBuffers(msg.data.mpegData));

          self.postMessage(
            {
              command: msg.data.command,
              channelData,
              samplesDecoded,
              sampleRate,
            },
            // The "transferList" parameter transfers ownership of channel data to main thread,
            // which avoids copying memory.
            channelData.map((channel) => channel.buffer)
          );
          break;
        default:
          this.console.error(
            "Unknown command sent to worker: " + msg.data.command
          );
      }
    });
  };
}

class MPEGDecoderWebWorker extends Worker {
  constructor() {
    const decoder = "(" + getMPEGDecoder.toString() + ")()";
    super(
      URL.createObjectURL(
        new Blob([decoder], { type: "application/javascript" })
      )
    );
  }

  async _sendToDecoder(command, mpegData) {
    return new Promise((resolve) => {
      this.postMessage({
        command,
        mpegData,
      });

      this.onmessage = (message) => {
        if (message.data.command === command) resolve(message.data);
      };
    });
  }

  terminate() {
    this.free().finally(() => {
      super.terminate();
    });
  }

  get ready() {
    return this._sendToDecoder("ready");
  }

  async free() {
    await this._sendToDecoder("free");
  }

  async reset() {
    await this._sendToDecoder("reset");
  }

  async decode(data) {
    return this._sendToDecoder("decode", data);
  }

  async decodeFrame(data) {
    return this._sendToDecoder("decodeFrame", data);
  }

  async decodeFrames(data) {
    return this._sendToDecoder("decodeFrames", data);
  }
}

if ("undefined" !== typeof global && exports) {
  module.exports.MPEGDecoder = MPEGDecoder;
  module.exports.MPEGDecoderWebWorker = MPEGDecoderWebWorker;
}
