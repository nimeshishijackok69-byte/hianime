class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkSamples = Math.max(
      160,
      Math.round(this.targetSampleRate * (processorOptions.chunkMs || 40) / 1000)
    );
    this.ratio = sampleRate / this.targetSampleRate;
    this.sourceBuffer = [];
    this.readIndex = 0;
    this.pendingSamples = [];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (output?.[0]) {
      output[0].fill(0);
    }

    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    const frameLength = input[0].length;
    for (let i = 0; i < frameLength; i += 1) {
      let sample = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        sample += input[channel][i] || 0;
      }
      this.sourceBuffer.push(sample / input.length);
    }

    while (this.readIndex + 1 < this.sourceBuffer.length) {
      const baseIndex = Math.floor(this.readIndex);
      const fraction = this.readIndex - baseIndex;
      const current = this.sourceBuffer[baseIndex];
      const next = this.sourceBuffer[baseIndex + 1];
      const interpolated = current + (next - current) * fraction;
      this.pendingSamples.push(this.floatToInt16(interpolated));
      this.readIndex += this.ratio;

      if (this.pendingSamples.length >= this.chunkSamples) {
        this.flushChunk();
      }
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.sourceBuffer = this.sourceBuffer.slice(consumed);
      this.readIndex -= consumed;
    }

    return true;
  }

  floatToInt16(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  flushChunk() {
    const samples = this.pendingSamples.splice(0, this.chunkSamples);
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < samples.length; i += 1) {
      view.setInt16(i * 2, samples[i], true);
    }

    this.port.postMessage({
      type: "PCM_CHUNK",
      buffer
    }, [buffer]);
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
